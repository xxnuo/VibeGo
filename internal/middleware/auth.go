package middleware

import (
	"crypto/subtle"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/rs/zerolog/log"
)

const bearerAccessKeyContext = "vibego.auth.bearer-access-key"

func BearerAccessKey(c *gin.Context) (string, bool) {
	value, ok := c.Get(bearerAccessKeyContext)
	key, valid := value.(string)
	return key, ok && valid && key != ""
}

func Auth(key string, fileViewAuthorizers ...*FileViewAuthorizer) gin.HandlerFunc {
	keyBytes := []byte(key)
	var fileViews *FileViewAuthorizer
	if len(fileViewAuthorizers) > 0 {
		fileViews = fileViewAuthorizers[0]
	}
	return func(c *gin.Context) {
		if key == "" {
			c.Next()
			return
		}

		authorization := c.GetHeader("Authorization")
		bearerKey := ""
		reqKey := authorization
		if authorization != "" {
			if strings.HasPrefix(authorization, "Bearer ") {
				bearerKey = strings.TrimPrefix(authorization, "Bearer ")
			}
			reqKey = strings.TrimPrefix(authorization, "Bearer ")
		} else {
			reqKey = c.Query("key")
		}

		authorizedByKey := subtle.ConstantTimeCompare([]byte(reqKey), keyBytes) == 1
		if authorizedByKey && bearerKey != "" {
			c.Set(bearerAccessKeyContext, bearerKey)
		}
		authorized := authorizedByKey
		if !authorized && fileViews != nil {
			authorized = fileViews.Authorize(c)
		}
		if !authorized {
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
