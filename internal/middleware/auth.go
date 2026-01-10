package middleware

import (
	"crypto/subtle"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/rs/zerolog/log"
)

func Auth(token string) gin.HandlerFunc {
	tokenBytes := []byte(token)
	return func(c *gin.Context) {
		if token == "" {
			c.Next()
			return
		}

		reqToken := c.GetHeader("Authorization")
		if reqToken != "" {
			reqToken = strings.TrimPrefix(reqToken, "Bearer ")
		} else {
			reqToken = c.Query("token")
		}

		if subtle.ConstantTimeCompare([]byte(reqToken), tokenBytes) != 1 {
			log.Warn().
				Str("ip", c.ClientIP()).
				Str("path", c.Request.URL.Path).
				Msg("Unauthorized access attempt")
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Unauthorized"})
			c.Abort()
			return
		}

		c.Next()
	}
}
