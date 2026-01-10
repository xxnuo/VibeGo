package middleware

import (
	"bytes"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"
	"github.com/stretchr/testify/assert"
)

func captureLogs(f func()) string {
	var buf bytes.Buffer
	// Replace global logger with one writing to buf
	originalLogger := log.Logger

	// Use JSON output for assertions
	log.Logger = zerolog.New(&buf).With().Timestamp().Logger()

	defer func() { log.Logger = originalLogger }()

	f()
	return buf.String()
}

func setupRouter() *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	return r
}

func TestLogger(t *testing.T) {
	r := setupRouter()
	r.Use(Logger())

	r.GET("/test", func(c *gin.Context) {
		c.Status(http.StatusOK)
	})
	r.GET("/warn", func(c *gin.Context) {
		c.Status(http.StatusBadRequest)
	})
	r.GET("/error", func(c *gin.Context) {
		c.Status(http.StatusInternalServerError)
	})
	r.GET("/custom_error", func(c *gin.Context) {
		c.Error(errors.New("something went wrong"))
		c.Status(http.StatusInternalServerError)
	})

	t.Run("Info Log", func(t *testing.T) {
		output := captureLogs(func() {
			req, _ := http.NewRequest("GET", "/test?q=hello", nil)
			w := httptest.NewRecorder()
			r.ServeHTTP(w, req)
			assert.Equal(t, http.StatusOK, w.Code)
		})

		assert.Contains(t, output, "\"level\":\"info\"")
		assert.Contains(t, output, "GET")
		assert.Contains(t, output, "/test?q=hello")
		assert.Contains(t, output, "200")
	})

	t.Run("Warn Log", func(t *testing.T) {
		output := captureLogs(func() {
			req, _ := http.NewRequest("GET", "/warn", nil)
			w := httptest.NewRecorder()
			r.ServeHTTP(w, req)
			assert.Equal(t, http.StatusBadRequest, w.Code)
		})

		assert.Contains(t, output, "\"level\":\"warn\"")
		assert.Contains(t, output, "400")
	})

	t.Run("Error Log", func(t *testing.T) {
		output := captureLogs(func() {
			req, _ := http.NewRequest("GET", "/error", nil)
			w := httptest.NewRecorder()
			r.ServeHTTP(w, req)
			assert.Equal(t, http.StatusInternalServerError, w.Code)
		})

		assert.Contains(t, output, "\"level\":\"error\"")
		assert.Contains(t, output, "500")
	})

	t.Run("Error Message Log", func(t *testing.T) {
		output := captureLogs(func() {
			req, _ := http.NewRequest("GET", "/custom_error", nil)
			w := httptest.NewRecorder()
			r.ServeHTTP(w, req)
			assert.Equal(t, http.StatusInternalServerError, w.Code)
		})

		assert.Contains(t, output, "\"level\":\"error\"")
		assert.Contains(t, output, "something went wrong")
	})
}
