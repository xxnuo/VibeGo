package handler

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
)

func setupTestSystemHandler() (*SystemHandler, *gin.Engine) {
	gin.SetMode(gin.TestMode)
	h := NewSystemHandler()
	r := gin.New()
	h.Register(r)
	return h, r
}

func TestSystemVersion(t *testing.T) {
	_, r := setupTestSystemHandler()

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/version", nil)
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	assert.Contains(t, w.Body.String(), "version")
}

func TestSystemHealth(t *testing.T) {
	_, r := setupTestSystemHandler()

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/health", nil)
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	assert.Contains(t, w.Body.String(), "ok")
}

func TestSystemHeartbeat(t *testing.T) {
	_, r := setupTestSystemHandler()

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/__heartbeat__", nil)
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	assert.Equal(t, "Ready", w.Body.String())
}

func TestSystemLBHeartbeat(t *testing.T) {
	_, r := setupTestSystemHandler()

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/__lbheartbeat__", nil)
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	assert.Equal(t, "Ready", w.Body.String())
}
