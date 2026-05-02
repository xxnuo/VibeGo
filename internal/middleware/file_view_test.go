package middleware

import (
	"bytes"
	"crypto/tls"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type fileViewTestClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *fileViewTestClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fileViewTestClock) Set(now time.Time) {
	c.mu.Lock()
	c.now = now
	c.mu.Unlock()
}

type fileViewTestRandom struct {
	mu    sync.Mutex
	next  byte
	reads int
}

func (r *fileViewTestRandom) Read(p []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i := range p {
		p[i] = r.next
	}
	r.next++
	r.reads++
	return len(p), nil
}

func (r *fileViewTestRandom) Reads() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.reads
}

func newTestFileViewAuthorizer(
	clock *fileViewTestClock,
	idleTTL, hardTTL time.Duration,
	seed byte,
) (*FileViewAuthorizer, *fileViewTestRandom) {
	random := &fileViewTestRandom{next: seed + 3}
	return newFileViewAuthorizer(
		bytes.Repeat([]byte{seed}, fileViewSecretSize),
		bytes.Repeat([]byte{seed + 1}, fileViewSecretSize),
		bytes.Repeat([]byte{seed + 2}, fileViewSecretSize),
		random,
		clock.Now,
		idleTTL,
		hardTTL,
	), random
}

func issueTestFileView(
	t *testing.T,
	a *FileViewAuthorizer,
	accessKey, path string,
	cookie *http.Cookie,
	secure bool,
) (FileViewGrant, *http.Cookie) {
	t.Helper()
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest(http.MethodGet, "/api/file/view-url", nil)
	if cookie != nil {
		c.Request.AddCookie(cookie)
	}
	if secure {
		c.Request.TLS = &tls.ConnectionState{}
	}
	grant, err := a.Issue(c, accessKey, path)
	require.NoError(t, err)
	cookies := w.Result().Cookies()
	require.Len(t, cookies, 1)
	return grant, cookies[0]
}

func testFileViewRequest(
	a *FileViewAuthorizer,
	method, target string,
	cookie *http.Cookie,
	rangeHeader string,
) (*httptest.ResponseRecorder, bool) {
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest(method, target, nil)
	if cookie != nil {
		c.Request.AddCookie(cookie)
	}
	if rangeHeader != "" {
		c.Request.Header.Set("Range", rangeHeader)
	}
	return w, a.Authorize(c)
}

func TestFileViewSessionUsesBrowserScopedStableNonceAndRestrictedCookie(t *testing.T) {
	gin.SetMode(gin.TestMode)
	clock := &fileViewTestClock{now: time.Date(2026, 8, 26, 12, 0, 0, 0, time.UTC)}
	a, random := newTestFileViewAuthorizer(clock, 10*time.Minute, time.Hour, 1)

	first, cookie := issueTestFileView(t, a, "human-memorable-key", "/tmp/video.mp4", nil, true)
	assert.NotContains(t, first.URL, "human-memorable-key")
	assert.NotContains(t, cookie.Value, "human-memorable-key")
	assert.Equal(t, FileViewSessionCookie, cookie.Name)
	assert.Equal(t, FileViewSessionPath, cookie.Path)
	assert.Empty(t, cookie.Domain)
	assert.True(t, cookie.HttpOnly)
	assert.True(t, cookie.Secure)
	assert.Equal(t, http.SameSiteStrictMode, cookie.SameSite)
	assert.Equal(t, clock.Now().Add(10*time.Minute).Unix(), first.ExpiresAt)
	assert.Equal(t, clock.Now().Add(time.Hour).Unix(), first.HardExpiresAt)
	assert.Equal(t, first.HardExpiresAt, cookie.Expires.Unix())
	assert.Equal(t, 1, random.Reads())

	second, secondCookie := issueTestFileView(t, a, "human-memorable-key", "/tmp/video.mp4", cookie, false)
	assert.Equal(t, first.URL, second.URL)
	assert.Equal(t, cookieNonce(t, cookie), cookieNonce(t, secondCookie))
	assert.Equal(t, first.HardExpiresAt, second.HardExpiresAt)
	assert.False(t, secondCookie.Secure)
	assert.Equal(t, 1, random.Reads())

	otherResource, otherCookie := issueTestFileView(t, a, "human-memorable-key", "/tmp/report.pdf", secondCookie, false)
	assert.NotEqual(t, first.URL, otherResource.URL)
	assert.Equal(t, cookieNonce(t, cookie), cookieNonce(t, otherCookie))
	assert.Equal(t, 1, random.Reads(), "one browser session must serve all resources")

	otherBrowser, otherBrowserCookie := issueTestFileView(t, a, "human-memorable-key", "/tmp/video.mp4", nil, false)
	assert.NotEqual(t, first.URL, otherBrowser.URL)
	assert.NotEqual(t, cookieNonce(t, cookie), cookieNonce(t, otherBrowserCookie))
	assert.Equal(t, 2, random.Reads())

	otherPrincipal, otherPrincipalCookie := issueTestFileView(t, a, "different-key", "/tmp/video.mp4", nil, false)
	assert.NotEqual(t, first.URL, otherPrincipal.URL)
	assert.NotEqual(t, cookieNonce(t, cookie), cookieNonce(t, otherPrincipalCookie))
	assert.Equal(t, 3, random.Reads())
}

func TestFileViewBearerRenewalPreservesHardDeadlineAndRotatesAfterIt(t *testing.T) {
	gin.SetMode(gin.TestMode)
	start := time.Date(2026, 8, 26, 12, 0, 0, 0, time.UTC)
	clock := &fileViewTestClock{now: start}
	a, random := newTestFileViewAuthorizer(clock, 10*time.Minute, 30*time.Minute, 10)
	first, cookie := issueTestFileView(t, a, "test-key", "/tmp/report.pdf", nil, false)

	clock.Set(start.Add(11 * time.Minute))
	_, ok := testFileViewRequest(a, http.MethodGet, first.URL, cookie, "bytes=100-199")
	assert.False(t, ok)
	renewed, renewedCookie := issueTestFileView(t, a, "test-key", "/tmp/report.pdf", cookie, false)
	assert.Equal(t, first.URL, renewed.URL)
	assert.Equal(t, first.HardExpiresAt, renewed.HardExpiresAt)
	assert.Equal(t, start.Add(21*time.Minute).Unix(), renewed.ExpiresAt)
	assert.Equal(t, 1, random.Reads())
	_, ok = testFileViewRequest(a, http.MethodGet, first.URL, renewedCookie, "bytes=100-199")
	assert.True(t, ok)

	clock.Set(start.Add(30*time.Minute + time.Second))
	rotated, rotatedCookie := issueTestFileView(t, a, "test-key", "/tmp/report.pdf", renewedCookie, false)
	assert.NotEqual(t, first.URL, rotated.URL)
	assert.NotEqual(t, cookieNonce(t, cookie), cookieNonce(t, rotatedCookie))
	assert.Equal(t, 2, random.Reads())
}

func TestFileViewRangeSlidesIdleTTLWithoutExtendingHardMax(t *testing.T) {
	gin.SetMode(gin.TestMode)
	start := time.Date(2026, 8, 26, 12, 0, 0, 0, time.UTC)
	clock := &fileViewTestClock{now: start}
	a, _ := newTestFileViewAuthorizer(clock, 10*time.Minute, 30*time.Minute, 20)
	grant, cookie := issueTestFileView(t, a, "test-key", "/tmp/media.bin", nil, false)

	clock.Set(start.Add(9 * time.Minute))
	w, ok := testFileViewRequest(a, http.MethodGet, grant.URL, cookie, "bytes=0-3")
	require.True(t, ok)
	assert.Empty(t, w.Result().Cookies(), "stable cookies avoid concurrent renewal rollback")

	clock.Set(start.Add(11 * time.Minute))
	w, ok = testFileViewRequest(a, http.MethodGet, grant.URL, cookie, "bytes=4-7")
	require.True(t, ok, "the Range request must slide server-side idle expiry")

	clock.Set(start.Add(20 * time.Minute))
	w, ok = testFileViewRequest(a, http.MethodGet, grant.URL, cookie, "bytes=5-5")
	require.True(t, ok)
	clock.Set(start.Add(29 * time.Minute))
	w, ok = testFileViewRequest(a, http.MethodGet, grant.URL, cookie, "bytes=6-6")
	require.True(t, ok)

	clock.Set(start.Add(30*time.Minute + time.Second))
	_, ok = testFileViewRequest(a, http.MethodGet, grant.URL, cookie, "bytes=7-7")
	assert.False(t, ok, "Range requests must never move hard expiry")
}

func TestFileViewLogoutRevokesOldCookieAndURL(t *testing.T) {
	gin.SetMode(gin.TestMode)
	clock := &fileViewTestClock{now: time.Date(2026, 8, 26, 12, 0, 0, 0, time.UTC)}
	a, random := newTestFileViewAuthorizer(clock, 10*time.Minute, time.Hour, 30)
	grant, cookie := issueTestFileView(t, a, "test-key", "/tmp/video.mp4", nil, false)

	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest(http.MethodPost, "/api/auth/logout", nil)
	c.Request.AddCookie(cookie)
	a.ClearSessionCookie(c)
	cleared := responseCookie(t, w)
	assert.Equal(t, -1, cleared.MaxAge)
	assert.Equal(t, FileViewSessionPath, cleared.Path)

	_, ok := testFileViewRequest(a, http.MethodGet, grant.URL, cookie, "bytes=0-1")
	assert.False(t, ok, "server-side revocation must reject replayed cookies")
	newGrant, newCookie := issueTestFileView(t, a, "test-key", "/tmp/video.mp4", nil, false)
	assert.NotEqual(t, grant.URL, newGrant.URL)
	assert.NotEqual(t, cookieNonce(t, cookie), cookieNonce(t, newCookie))
	assert.Equal(t, 2, random.Reads())
}

func TestFileViewURLCookieAndAuthorizerTamperingIsRejected(t *testing.T) {
	gin.SetMode(gin.TestMode)
	clock := &fileViewTestClock{now: time.Date(2026, 8, 26, 12, 0, 0, 0, time.UTC)}
	a, _ := newTestFileViewAuthorizer(clock, 10*time.Minute, time.Hour, 40)
	grant, cookie := issueTestFileView(t, a, "test-key", "/tmp/image.png", nil, false)
	tamperedCookie := *cookie
	tamperedCookie.Value += "x"

	tests := []struct {
		name   string
		method string
		target string
		cookie *http.Cookie
	}{
		{name: "missing cookie", method: http.MethodGet, target: grant.URL},
		{name: "tampered cookie", method: http.MethodGet, target: grant.URL, cookie: &tamperedCookie},
		{name: "tampered path", method: http.MethodGet, target: replaceQuery(t, grant.URL, "path", "/tmp/other.png"), cookie: cookie},
		{name: "tampered signature", method: http.MethodGet, target: replaceQuery(t, grant.URL, "sig", "invalid"), cookie: cookie},
		{name: "attachment", method: http.MethodGet, target: replaceQuery(t, grant.URL, "inline", "0"), cookie: cookie},
		{name: "wrong endpoint", method: http.MethodGet, target: "/api/file/read?" + queryPart(grant.URL), cookie: cookie},
		{name: "wrong method", method: http.MethodPost, target: grant.URL, cookie: cookie},
		{name: "duplicate path", method: http.MethodGet, target: grant.URL + "&path=%2Ftmp%2Fother.png", cookie: cookie},
		{name: "duplicate signature", method: http.MethodGet, target: grant.URL + "&sig=invalid", cookie: cookie},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, ok := testFileViewRequest(a, tt.method, tt.target, tt.cookie, "")
			assert.False(t, ok)
		})
	}

	rotated, _ := newTestFileViewAuthorizer(clock, 10*time.Minute, time.Hour, 80)
	_, ok := testFileViewRequest(rotated, http.MethodGet, grant.URL, cookie, "")
	assert.False(t, ok, "new process secrets and active state must invalidate old grants")
}

func TestFileViewConcurrentFirstIssueCreatesIndependentBrowserSessions(t *testing.T) {
	gin.SetMode(gin.TestMode)
	clock := &fileViewTestClock{now: time.Date(2026, 8, 26, 12, 0, 0, 0, time.UTC)}
	a, random := newTestFileViewAuthorizer(clock, 10*time.Minute, time.Hour, 50)

	const count = 16
	urls := make(chan string, count)
	var wg sync.WaitGroup
	for i := 0; i < count; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			w := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(w)
			c.Request = httptest.NewRequest(http.MethodGet, "/api/file/view-url", nil)
			grant, err := a.Issue(c, "test-key", "/tmp/video.mp4")
			if err == nil {
				urls <- grant.URL
			}
		}()
	}
	wg.Wait()
	close(urls)

	seenURLs := make(map[string]struct{}, count)
	seen := 0
	for current := range urls {
		seen++
		seenURLs[current] = struct{}{}
	}
	assert.Equal(t, count, seen)
	assert.Len(t, seenURLs, count)
	assert.Equal(t, count, random.Reads())
}

func TestFileViewBrowserSessionsCannotBeCrossedOrGloballyRevoked(t *testing.T) {
	gin.SetMode(gin.TestMode)
	clock := &fileViewTestClock{now: time.Date(2026, 8, 26, 12, 0, 0, 0, time.UTC)}
	a, _ := newTestFileViewAuthorizer(clock, 10*time.Minute, time.Hour, 55)

	first, firstCookie := issueTestFileView(t, a, "test-key", "/tmp/video.mp4", nil, false)
	second, secondCookie := issueTestFileView(t, a, "test-key", "/tmp/video.mp4", nil, false)
	require.NotEqual(t, first.URL, second.URL)

	_, ok := testFileViewRequest(a, http.MethodGet, first.URL, firstCookie, "")
	assert.True(t, ok)
	_, ok = testFileViewRequest(a, http.MethodGet, second.URL, secondCookie, "")
	assert.True(t, ok)
	_, ok = testFileViewRequest(a, http.MethodGet, first.URL, secondCookie, "")
	assert.False(t, ok)
	_, ok = testFileViewRequest(a, http.MethodGet, second.URL, firstCookie, "")
	assert.False(t, ok)

	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest(http.MethodPost, "/api/file/view-session/logout", nil)
	c.Request.AddCookie(firstCookie)
	a.ClearSessionCookie(c)

	_, ok = testFileViewRequest(a, http.MethodGet, first.URL, firstCookie, "")
	assert.False(t, ok)
	_, ok = testFileViewRequest(a, http.MethodGet, second.URL, secondCookie, "")
	assert.True(t, ok, "logging out one browser must not revoke another browser")
}

func TestFileViewSessionCapacityAndHardExpiryCleanup(t *testing.T) {
	gin.SetMode(gin.TestMode)
	start := time.Date(2026, 8, 26, 12, 0, 0, 0, time.UTC)
	clock := &fileViewTestClock{now: start}
	a, _ := newTestFileViewAuthorizer(clock, 10*time.Minute, time.Hour, 58)
	a.maxSessions = 3
	a.maxSessionsPerPrincipal = 2

	first, firstCookie := issueTestFileView(t, a, "first-key", "/tmp/one", nil, false)
	second, secondCookie := issueTestFileView(t, a, "first-key", "/tmp/two", nil, false)
	third, thirdCookie := issueTestFileView(t, a, "first-key", "/tmp/three", nil, false)
	assert.Equal(t, 2, fileViewSessionCount(a))
	_, ok := testFileViewRequest(a, http.MethodGet, first.URL, firstCookie, "")
	assert.False(t, ok, "the oldest principal session must be evicted")
	_, ok = testFileViewRequest(a, http.MethodGet, second.URL, secondCookie, "")
	assert.True(t, ok)
	_, ok = testFileViewRequest(a, http.MethodGet, third.URL, thirdCookie, "")
	assert.True(t, ok)

	_, _ = issueTestFileView(t, a, "second-key", "/tmp/four", nil, false)
	fifth, fifthCookie := issueTestFileView(t, a, "third-key", "/tmp/five", nil, false)
	assert.Equal(t, 3, fileViewSessionCount(a))
	_, ok = testFileViewRequest(a, http.MethodGet, second.URL, secondCookie, "")
	assert.False(t, ok, "the global capacity must evict the oldest remaining session")

	clock.Set(start.Add(time.Hour))
	_, _ = issueTestFileView(t, a, "fourth-key", "/tmp/six", nil, false)
	assert.Equal(t, 1, fileViewSessionCount(a), "hard-expired sessions must be swept before issuance")
	_, ok = testFileViewRequest(a, http.MethodGet, fifth.URL, fifthCookie, "")
	assert.False(t, ok)
}

func TestFileViewCookieUsesTrustedSecureRequestScheme(t *testing.T) {
	gin.SetMode(gin.TestMode)
	clock := &fileViewTestClock{now: time.Date(2026, 8, 26, 12, 0, 0, 0, time.UTC)}
	a, _ := newTestFileViewAuthorizer(clock, 10*time.Minute, time.Hour, 59)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest(http.MethodGet, "/api/file/view-url", nil)
	c.Request.URL.Scheme = "https"

	_, err := a.Issue(c, "test-key", "/tmp/video.mp4")
	require.NoError(t, err)
	assert.True(t, responseCookie(t, w).Secure)
}

func TestFileViewRangeLifecycleWithServeContent(t *testing.T) {
	gin.SetMode(gin.TestMode)
	start := time.Date(2026, 8, 26, 12, 0, 0, 0, time.UTC)
	clock := &fileViewTestClock{now: start}
	a, _ := newTestFileViewAuthorizer(clock, 10*time.Minute, time.Hour, 60)
	grant, cookie := issueTestFileView(t, a, "test-key", "/tmp/media.bin", nil, false)

	r := gin.New()
	r.Use(Auth("test-key", a))
	r.GET(SignedFileDownloadPath, func(c *gin.Context) {
		http.ServeContent(c.Writer, c.Request, "media.bin", start, bytes.NewReader([]byte("0123456789")))
	})

	clock.Set(start.Add(9 * time.Minute))
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, grant.URL, nil)
	req.AddCookie(cookie)
	req.Header.Set("Range", "bytes=2-5")
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusPartialContent, w.Code)
	assert.Equal(t, "2345", w.Body.String())
	assert.Equal(t, "bytes 2-5/10", w.Header().Get("Content-Range"))
	assert.Empty(t, w.Result().Cookies())

	clock.Set(start.Add(11 * time.Minute))
	w = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, grant.URL, nil)
	req.AddCookie(cookie)
	req.Header.Set("Range", "bytes=6-9")
	r.ServeHTTP(w, req)
	assert.Equal(t, http.StatusPartialContent, w.Code)
	assert.Equal(t, "6789", w.Body.String())
}

func responseCookie(t *testing.T, w *httptest.ResponseRecorder) *http.Cookie {
	t.Helper()
	cookies := w.Result().Cookies()
	require.Len(t, cookies, 1)
	return cookies[0]
}

func fileViewSessionCount(a *FileViewAuthorizer) int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return len(a.sessions)
}

func cookieNonce(t *testing.T, cookie *http.Cookie) string {
	t.Helper()
	parts := splitCookieValue(cookie.Value)
	require.Len(t, parts, 3)
	return parts[1]
}

func replaceQuery(t *testing.T, rawURL, key, value string) string {
	t.Helper()
	parsed, err := url.Parse(rawURL)
	require.NoError(t, err)
	query := parsed.Query()
	query.Set(key, value)
	parsed.RawQuery = query.Encode()
	return parsed.String()
}

func queryPart(rawURL string) string {
	return rawURL[strings.IndexByte(rawURL, '?')+1:]
}

func TestFileViewPathDescriptorRoundTripAndTamperRejection(t *testing.T) {
	a, _ := newTestFileViewAuthorizer(&fileViewTestClock{now: time.Unix(100, 0)}, time.Minute, time.Hour, 120)
	payload := []byte(`{"terminal_id":"terminal-1","path":"/remote/report.pdf"}`)

	sealed, err := a.SealPathDescriptor("ssh-sftp", payload)
	require.NoError(t, err)
	assert.NotContains(t, sealed, "/remote/report.pdf")
	opened, err := a.OpenPathDescriptor("ssh-sftp", sealed)
	require.NoError(t, err)
	assert.Equal(t, payload, opened)

	parts := strings.Split(sealed, ".")
	require.Len(t, parts, 3)
	parts[1] = parts[1][:len(parts[1])-1] + "A"
	_, err = a.OpenPathDescriptor("ssh-sftp", strings.Join(parts, "."))
	require.Error(t, err)
	_, err = a.OpenPathDescriptor("other-kind", sealed)
	require.Error(t, err)
}
