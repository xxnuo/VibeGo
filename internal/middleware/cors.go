package middleware

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

func CORS(origins string) gin.HandlerFunc {
	headers := map[string]string{
		"Access-Control-Allow-Origin":      origins,
		"Access-Control-Allow-Credentials": "true",
		"Access-Control-Allow-Headers":     "Content-Type, Content-Length, Accept-Encoding, X-CSRF-Token, Authorization, accept, origin, Cache-Control, X-Requested-With, KEY",
		"Access-Control-Allow-Methods":     "POST, OPTIONS, GET, PUT, DELETE",
	}
	return func(c *gin.Context) {
		for k, v := range headers {
			c.Writer.Header().Set(k, v)
		}
		if c.Request.Method == "OPTIONS" {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
		c.Next()
	}
}
