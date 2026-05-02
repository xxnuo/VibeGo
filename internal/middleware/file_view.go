package middleware

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"hash"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

const (
	SignedFileDownloadPath    = "/api/file/download"
	FileViewSessionCookie     = "vibego_file_view"
	FileViewSessionPath       = "/api/file"
	SignedFileViewTTL         = 10 * time.Minute
	FileViewSessionHardTTL    = 24 * time.Hour
	fileViewSecretSize        = 32
	fileViewNonceSize         = 32
	fileViewMaxSessions       = 256
	fileViewMaxPerPrincipal   = 32
	fileViewURLMACPurpose     = "vibego-file-view-url-v1"
	fileViewCookiePurpose     = "vibego-file-view-cookie-v1"
	fileViewPrincipalPurpose  = "vibego-file-view-principal-v1"
	fileViewDescriptorPurpose = "vibego-file-view-descriptor-v1"
)

type FileViewGrant struct {
	URL           string
	ExpiresAt     int64
	HardExpiresAt int64
}

type fileViewSession struct {
	Nonce         string
	Principal     string
	ExpiresAt     int64
	HardExpiresAt int64
	Sequence      uint64
}

type FileViewAuthorizer struct {
	urlKey       []byte
	cookieKey    []byte
	principalKey []byte
	random       io.Reader
	now          func() time.Time
	idleTTL      time.Duration
	hardTTL      time.Duration

	mu                      sync.Mutex
	sessions                map[string]fileViewSession
	nextSequence            uint64
	maxSessions             int
	maxSessionsPerPrincipal int
}

func NewFileViewAuthorizer() (*FileViewAuthorizer, error) {
	secrets := make([]byte, 3*fileViewSecretSize)
	if _, err := io.ReadFull(rand.Reader, secrets); err != nil {
		return nil, fmt.Errorf("generate file view secrets: %w", err)
	}
	return newFileViewAuthorizer(
		secrets[:fileViewSecretSize],
		secrets[fileViewSecretSize:2*fileViewSecretSize],
		secrets[2*fileViewSecretSize:],
		rand.Reader,
		time.Now,
		SignedFileViewTTL,
		FileViewSessionHardTTL,
	), nil
}

func newFileViewAuthorizer(
	urlKey, cookieKey, principalKey []byte,
	random io.Reader,
	now func() time.Time,
	idleTTL, hardTTL time.Duration,
) *FileViewAuthorizer {
	return &FileViewAuthorizer{
		urlKey:                  append([]byte(nil), urlKey...),
		cookieKey:               append([]byte(nil), cookieKey...),
		principalKey:            append([]byte(nil), principalKey...),
		random:                  random,
		now:                     now,
		idleTTL:                 idleTTL,
		hardTTL:                 hardTTL,
		sessions:                make(map[string]fileViewSession),
		maxSessions:             fileViewMaxSessions,
		maxSessionsPerPrincipal: fileViewMaxPerPrincipal,
	}
}

func (a *FileViewAuthorizer) Issue(c *gin.Context, accessKey, path string) (FileViewGrant, error) {
	if accessKey == "" {
		return FileViewGrant{}, fmt.Errorf("access key required")
	}

	now := a.now()
	principal := a.principalID(accessKey)
	claims, hasCookie := a.readCookie(c)
	a.mu.Lock()
	a.sweepExpiredLocked(now.Unix())
	session, ok := a.sessions[claims.Nonce]
	if !hasCookie || !ok || session.Principal != principal {
		nonce, err := a.newNonceLocked()
		if err != nil {
			a.mu.Unlock()
			return FileViewGrant{}, err
		}
		a.makeRoomLocked(principal)
		hardExpiresAt := now.Add(a.hardTTL)
		session = fileViewSession{
			Nonce:         nonce,
			Principal:     principal,
			ExpiresAt:     minTime(now.Add(a.idleTTL), hardExpiresAt).Unix(),
			HardExpiresAt: hardExpiresAt.Unix(),
			Sequence:      a.nextSequence,
		}
		a.sessions[nonce] = session
	} else {
		expiresAt := minTime(now.Add(a.idleTTL), time.Unix(session.HardExpiresAt, 0)).Unix()
		if expiresAt > session.ExpiresAt {
			session.ExpiresAt = expiresAt
			a.sessions[session.Nonce] = session
		}
	}
	a.mu.Unlock()

	a.setSessionCookie(c, session)
	params := url.Values{
		"path":   []string{path},
		"inline": []string{"1"},
		"sig":    []string{a.signURL(path, session.Nonce)},
	}
	return FileViewGrant{
		URL:           SignedFileDownloadPath + "?" + params.Encode(),
		ExpiresAt:     session.ExpiresAt,
		HardExpiresAt: session.HardExpiresAt,
	}, nil
}

func (a *FileViewAuthorizer) Authorize(c *gin.Context) bool {
	if c.Request.Method != http.MethodGet || c.Request.URL.Path != SignedFileDownloadPath {
		return false
	}
	query := c.Request.URL.Query()
	if len(query["path"]) != 1 || len(query["inline"]) != 1 || len(query["sig"]) != 1 || query.Get("inline") != "1" {
		return false
	}
	path := query.Get("path")
	signature := query.Get("sig")
	if path == "" || signature == "" {
		return false
	}

	claims, ok := a.readCookie(c)
	if !ok || !hmac.Equal([]byte(signature), []byte(a.signURL(path, claims.Nonce))) {
		return false
	}

	now := a.now()
	a.mu.Lock()
	a.sweepExpiredLocked(now.Unix())
	session, ok := a.sessions[claims.Nonce]
	if !ok {
		a.mu.Unlock()
		return false
	}
	if session.ExpiresAt <= now.Unix() {
		a.mu.Unlock()
		return false
	}
	refresh := c.GetHeader("Range") != ""
	if refresh {
		expiresAt := minTime(now.Add(a.idleTTL), time.Unix(session.HardExpiresAt, 0)).Unix()
		if expiresAt > session.ExpiresAt {
			session.ExpiresAt = expiresAt
			a.sessions[claims.Nonce] = session
		}
	}
	a.mu.Unlock()
	return true
}

func (a *FileViewAuthorizer) ClearSessionCookie(c *gin.Context) {
	if claims, ok := a.readCookie(c); ok {
		a.mu.Lock()
		if session, exists := a.sessions[claims.Nonce]; exists {
			delete(a.sessions, session.Nonce)
		}
		a.mu.Unlock()
	}
	http.SetCookie(c.Writer, &http.Cookie{
		Name:     FileViewSessionCookie,
		Value:    "",
		Path:     FileViewSessionPath,
		Expires:  time.Unix(1, 0).UTC(),
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   fileViewCookieSecure(c.Request),
		SameSite: http.SameSiteStrictMode,
	})
}

func (a *FileViewAuthorizer) SealPathDescriptor(kind string, payload []byte) (string, error) {
	if kind == "" || len(kind) > 64 || len(payload) == 0 || len(payload) > 16*1024 {
		return "", fmt.Errorf("invalid file view descriptor")
	}
	encoded := base64.RawURLEncoding.EncodeToString(payload)
	mac := hmac.New(sha256.New, a.urlKey)
	writeMACFields(mac, fileViewDescriptorPurpose, kind, encoded)
	signature := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return strings.Join([]string{"v1", encoded, signature}, "."), nil
}

func (a *FileViewAuthorizer) OpenPathDescriptor(kind, value string) ([]byte, error) {
	if kind == "" || len(kind) > 64 || len(value) > 32*1024 {
		return nil, fmt.Errorf("invalid file view descriptor")
	}
	parts := strings.Split(value, ".")
	if len(parts) != 3 || parts[0] != "v1" || parts[1] == "" || parts[2] == "" {
		return nil, fmt.Errorf("invalid file view descriptor")
	}
	mac := hmac.New(sha256.New, a.urlKey)
	writeMACFields(mac, fileViewDescriptorPurpose, kind, parts[1])
	want := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(parts[2]), []byte(want)) {
		return nil, fmt.Errorf("invalid file view descriptor")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || len(payload) == 0 || len(payload) > 16*1024 {
		return nil, fmt.Errorf("invalid file view descriptor")
	}
	return payload, nil
}

func (a *FileViewAuthorizer) newNonceLocked() (string, error) {
	for attempts := 0; attempts < 8; attempts++ {
		value := make([]byte, fileViewNonceSize)
		if _, err := io.ReadFull(a.random, value); err != nil {
			return "", fmt.Errorf("generate file view nonce: %w", err)
		}
		nonce := base64.RawURLEncoding.EncodeToString(value)
		if _, exists := a.sessions[nonce]; !exists {
			return nonce, nil
		}
	}
	return "", fmt.Errorf("generate unique file view nonce")
}

func (a *FileViewAuthorizer) sweepExpiredLocked(now int64) {
	for nonce, session := range a.sessions {
		if session.HardExpiresAt <= now {
			delete(a.sessions, nonce)
		}
	}
}

func (a *FileViewAuthorizer) makeRoomLocked(principal string) {
	for a.maxSessionsPerPrincipal > 0 && a.countPrincipalLocked(principal) >= a.maxSessionsPerPrincipal {
		if !a.evictOldestLocked(principal) {
			break
		}
	}
	for a.maxSessions > 0 && len(a.sessions) >= a.maxSessions {
		if !a.evictOldestLocked("") {
			break
		}
	}
	a.nextSequence++
}

func (a *FileViewAuthorizer) countPrincipalLocked(principal string) int {
	count := 0
	for _, session := range a.sessions {
		if session.Principal == principal {
			count++
		}
	}
	return count
}

func (a *FileViewAuthorizer) evictOldestLocked(principal string) bool {
	var oldest fileViewSession
	found := false
	for _, session := range a.sessions {
		if principal != "" && session.Principal != principal {
			continue
		}
		if !found || session.Sequence < oldest.Sequence {
			oldest = session
			found = true
		}
	}
	if found {
		delete(a.sessions, oldest.Nonce)
	}
	return found
}

func (a *FileViewAuthorizer) principalID(accessKey string) string {
	mac := hmac.New(sha256.New, a.principalKey)
	writeMACFields(mac, fileViewPrincipalPurpose, accessKey)
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func (a *FileViewAuthorizer) signURL(path, nonce string) string {
	mac := hmac.New(sha256.New, a.urlKey)
	writeMACFields(mac, fileViewURLMACPurpose, http.MethodGet, SignedFileDownloadPath, path, "inline=1", nonce)
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func (a *FileViewAuthorizer) signCookie(nonce string) string {
	mac := hmac.New(sha256.New, a.cookieKey)
	writeMACFields(mac, fileViewCookiePurpose, nonce)
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func (a *FileViewAuthorizer) readCookie(c *gin.Context) (fileViewSession, bool) {
	raw, err := c.Cookie(FileViewSessionCookie)
	if err != nil {
		return fileViewSession{}, false
	}
	parts := splitCookieValue(raw)
	if len(parts) != 3 || parts[0] != "v1" || parts[1] == "" {
		return fileViewSession{}, false
	}
	if !hmac.Equal([]byte(parts[2]), []byte(a.signCookie(parts[1]))) {
		return fileViewSession{}, false
	}
	return fileViewSession{Nonce: parts[1]}, true
}

func (a *FileViewAuthorizer) setSessionCookie(c *gin.Context, session fileViewSession) {
	now := a.now().Unix()
	maxAge := int(session.HardExpiresAt - now)
	if maxAge < 1 {
		maxAge = 1
	}
	value := strings.Join([]string{
		"v1",
		session.Nonce,
		a.signCookie(session.Nonce),
	}, ".")
	http.SetCookie(c.Writer, &http.Cookie{
		Name:     FileViewSessionCookie,
		Value:    value,
		Path:     FileViewSessionPath,
		Expires:  time.Unix(session.HardExpiresAt, 0).UTC(),
		MaxAge:   maxAge,
		HttpOnly: true,
		Secure:   fileViewCookieSecure(c.Request),
		SameSite: http.SameSiteStrictMode,
	})
}

func fileViewCookieSecure(request *http.Request) bool {
	return request.TLS != nil || strings.EqualFold(request.URL.Scheme, "https")
}

func splitCookieValue(value string) []string {
	return strings.Split(value, ".")
}

func writeMACFields(mac hash.Hash, fields ...string) {
	var size [8]byte
	for _, field := range fields {
		binary.BigEndian.PutUint64(size[:], uint64(len(field)))
		_, _ = mac.Write(size[:])
		_, _ = io.WriteString(mac, field)
	}
}

func minTime(left, right time.Time) time.Time {
	if left.Before(right) {
		return left
	}
	return right
}
