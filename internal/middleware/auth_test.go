package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
)

func TestAuthWithValidKey(t *testing.T) {
	gin.SetMode(gin.TestMode)

	r := gin.New()
	r.Use(Auth("test-key"))
	r.GET("/test", func(c *gin.Context) {
		c.String(http.StatusOK, "success")
	})

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/test", nil)
	req.Header.Set("Authorization", "test-key")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	assert.Equal(t, "success", w.Body.String())
}

func TestAuthWithBearerKey(t *testing.T) {
	gin.SetMode(gin.TestMode)

	r := gin.New()
	r.Use(Auth("test-key"))
	r.GET("/test", func(c *gin.Context) {
		c.String(http.StatusOK, "success")
	})

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/test", nil)
	req.Header.Set("Authorization", "Bearer test-key")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	assert.Equal(t, "success", w.Body.String())
}

func TestAuthWithValidKeyInQuery(t *testing.T) {
	gin.SetMode(gin.TestMode)

	r := gin.New()
	r.Use(Auth("test-key"))
	r.GET("/test", func(c *gin.Context) {
		c.String(http.StatusOK, "success")
	})

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/test?key=test-key", nil)
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	assert.Equal(t, "success", w.Body.String())
}

func TestAuthWithInvalidKey(t *testing.T) {
	gin.SetMode(gin.TestMode)

	r := gin.New()
	r.Use(Auth("test-key"))
	r.GET("/test", func(c *gin.Context) {
		c.String(http.StatusOK, "success")
	})

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/test", nil)
	req.Header.Set("Authorization", "wrong-key")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
	assert.Contains(t, w.Body.String(), "Unauthorized")
}

func TestAuthWithNoKey(t *testing.T) {
	gin.SetMode(gin.TestMode)

	r := gin.New()
	r.Use(Auth("test-key"))
	r.GET("/test", func(c *gin.Context) {
		c.String(http.StatusOK, "success")
	})

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/test", nil)
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
	assert.Contains(t, w.Body.String(), "Unauthorized")
}

func TestAuthWithEmptyConfigKey(t *testing.T) {
	gin.SetMode(gin.TestMode)

	r := gin.New()
	r.Use(Auth(""))
	r.GET("/test", func(c *gin.Context) {
		c.String(http.StatusOK, "success")
	})

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/test", nil)
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	assert.Equal(t, "success", w.Body.String())
}

func TestAuthProtectsLaterAPIRoutesWithoutBlockingStaticUI(t *testing.T) {
	gin.SetMode(gin.TestMode)

	r := gin.New()
	api := r.Group("/api")
	api.GET("/auth/status", func(c *gin.Context) {
		c.String(http.StatusOK, "auth status")
	})
	api.Use(Auth("test-key"))
	api.GET("/protected", func(c *gin.Context) {
		c.String(http.StatusOK, "protected")
	})
	r.NoRoute(func(c *gin.Context) {
		c.String(http.StatusOK, "static ui")
	})

	for _, tt := range []struct {
		name       string
		path       string
		key        string
		wantStatus int
		wantBody   string
	}{
		{name: "static ui", path: "/", wantStatus: http.StatusOK, wantBody: "static ui"},
		{name: "public auth route", path: "/api/auth/status", wantStatus: http.StatusOK, wantBody: "auth status"},
		{name: "protected api without key", path: "/api/protected", wantStatus: http.StatusUnauthorized},
		{name: "protected api with key", path: "/api/protected", key: "test-key", wantStatus: http.StatusOK, wantBody: "protected"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			req, _ := http.NewRequest(http.MethodGet, tt.path, nil)
			if tt.key != "" {
				req.Header.Set("Authorization", "Bearer "+tt.key)
			}
			r.ServeHTTP(w, req)
			assert.Equal(t, tt.wantStatus, w.Code)
			if tt.wantBody != "" {
				assert.Equal(t, tt.wantBody, w.Body.String())
			}
		})
	}
}

func TestAuthWithFileViewSession(t *testing.T) {
	gin.SetMode(gin.TestMode)
	const key = "test-key"
	const path = "/tmp/image.png"
	clock := &fileViewTestClock{now: time.Date(2026, 8, 26, 12, 0, 0, 0, time.UTC)}
	fileViews, _ := newTestFileViewAuthorizer(clock, 10*time.Minute, time.Hour, 90)
	grant, cookie := issueTestFileView(t, fileViews, key, path, nil, false)

	r := gin.New()
	r.Use(Auth(key, fileViews))
	r.GET(SignedFileDownloadPath, func(c *gin.Context) {
		c.String(http.StatusOK, "success")
	})
	w := httptest.NewRecorder()
	req, _ := http.NewRequest(http.MethodGet, grant.URL, nil)
	req.AddCookie(cookie)
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	assert.Equal(t, "success", w.Body.String())
}

func TestAuthExposesOnlyValidatedBearerAccessKey(t *testing.T) {
	gin.SetMode(gin.TestMode)
	const key = "test-key"
	r := gin.New()
	r.Use(Auth(key))
	r.GET("/protected", func(c *gin.Context) {
		value, ok := BearerAccessKey(c)
		c.JSON(http.StatusOK, gin.H{"key": value, "ok": ok})
	})

	tests := []struct {
		name       string
		target     string
		header     string
		wantStatus int
		wantBody   string
	}{
		{name: "validated bearer", target: "/protected", header: "Bearer " + key, wantStatus: http.StatusOK, wantBody: `{"key":"test-key","ok":true}`},
		{name: "query key is not bearer", target: "/protected?key=" + key, wantStatus: http.StatusOK, wantBody: `{"key":"","ok":false}`},
		{name: "raw authorization is not bearer", target: "/protected", header: key, wantStatus: http.StatusOK, wantBody: `{"key":"","ok":false}`},
		{name: "invalid bearer", target: "/protected", header: "Bearer wrong", wantStatus: http.StatusUnauthorized},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodGet, tt.target, nil)
			if tt.header != "" {
				req.Header.Set("Authorization", tt.header)
			}
			r.ServeHTTP(w, req)
			assert.Equal(t, tt.wantStatus, w.Code)
			if tt.wantBody != "" {
				assert.JSONEq(t, tt.wantBody, w.Body.String())
			}
		})
	}
}

func TestAuthRejectsInvalidFileViewSession(t *testing.T) {
	gin.SetMode(gin.TestMode)
	const key = "test-key"
	clock := &fileViewTestClock{now: time.Date(2026, 8, 26, 12, 0, 0, 0, time.UTC)}
	fileViews, _ := newTestFileViewAuthorizer(clock, 10*time.Minute, time.Hour, 100)
	grant, cookie := issueTestFileView(t, fileViews, key, "/tmp/image.png", nil, false)

	r := gin.New()
	r.Use(Auth(key, fileViews))
	r.GET(SignedFileDownloadPath, func(c *gin.Context) {
		c.String(http.StatusOK, "success")
	})

	w := httptest.NewRecorder()
	req, _ := http.NewRequest(http.MethodGet, grant.URL, nil)
	r.ServeHTTP(w, req)
	assert.Equal(t, http.StatusUnauthorized, w.Code)

	w = httptest.NewRecorder()
	req, _ = http.NewRequest(http.MethodGet, replaceQuery(t, grant.URL, "path", "/tmp/other.png"), nil)
	req.AddCookie(cookie)
	r.ServeHTTP(w, req)
	assert.Equal(t, http.StatusUnauthorized, w.Code)
}
