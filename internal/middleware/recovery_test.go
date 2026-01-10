package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
)

func TestRecovery(t *testing.T) {
	r := setupRouter()
	r.Use(Recovery())

	r.GET("/panic", func(c *gin.Context) {
		panic("oops")
	})

	t.Run("Recover from panic", func(t *testing.T) {
		output := captureLogs(func() {
			req, _ := http.NewRequest("GET", "/panic", nil)
			w := httptest.NewRecorder()
			r.ServeHTTP(w, req)
			assert.Equal(t, http.StatusInternalServerError, w.Code)
		})

		assert.Contains(t, output, "\"level\":\"error\"")
		assert.Contains(t, output, "Panic recovered")
		assert.Contains(t, output, "oops")
	})
}
