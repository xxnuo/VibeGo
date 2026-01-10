package middleware

import (
	"runtime/debug"

	"github.com/gin-gonic/gin"
	"github.com/rs/zerolog/log"
)

func Recovery() gin.HandlerFunc {
	return func(c *gin.Context) {
		defer func() {
			if err := recover(); err != nil {
				log.Error().
					Interface("error", err).
					Bytes("stack", debug.Stack()).
					Msg("Panic recovered")
				c.AbortWithStatus(500)
			}
		}()
		c.Next()
	}
}
