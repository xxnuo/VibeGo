package middleware

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/rs/zerolog/log"
)

func Auth(token string) gin.HandlerFunc {
	return func(c *gin.Context) {

		if token == "" {
			c.Next()
			return
		}

		_token := c.GetHeader("Authorization")
		if _token != "" {
			_token = strings.TrimPrefix(_token, "Bearer ")
		} else {
			_token = c.Query("token")
		}

		if _token != token {
			log.Warn().
				Str("ip", c.ClientIP()).
				Str("path", c.Request.URL.Path).
				Msg("Unauthorized access attempt")
			c.JSON(http.StatusUnauthorized, gin.H{
				"error": "Unauthorized",
			})
			c.Abort()
			return
		}

		c.Next()
	}
}
