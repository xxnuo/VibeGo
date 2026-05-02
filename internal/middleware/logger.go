package middleware

import (
	"net/url"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/rs/zerolog/log"
)

func Logger() gin.HandlerFunc {
	return func(c *gin.Context) {

		start := time.Now()
		path := c.Request.URL.Path
		raw := redactQuery(c.Request.URL.RawQuery)

		c.Next()

		end := time.Now()
		latency := end.Sub(start)

		clientIP := c.ClientIP()
		method := c.Request.Method
		statusCode := c.Writer.Status()
		errorMessage := c.Errors.ByType(gin.ErrorTypePrivate).String()

		if raw != "" {
			path = path + "?" + raw
		}

		event := log.Info()
		if statusCode >= 500 {
			event = log.Error()
		} else if statusCode >= 400 {
			event = log.Warn()
		}

		if errorMessage != "" {
			event.Str("error", errorMessage)
		}

		event.Str("method", method).
			Str("path", path).
			Int("status", statusCode).
			Dur("latency", latency).
			Str("ip", clientIP).
			Msg("Request")
	}
}

func redactQuery(raw string) string {
	if raw == "" {
		return ""
	}
	sensitive := map[string]struct{}{
		"key": {}, "sig": {}, "signature": {},
		// OAuth authorization codes and state values are bearer-like secrets
		// that must not be retained in request logs.
		"code": {}, "state": {}, "error": {}, "error_description": {},
		"access_token": {}, "refresh_token": {}, "client_secret": {}, "device_code": {},
	}
	parts := strings.Split(raw, "&")
	for i, part := range parts {
		key, _, _ := strings.Cut(part, "=")
		decodedKey, err := url.QueryUnescape(key)
		if err == nil {
			if _, ok := sensitive[strings.ToLower(decodedKey)]; !ok {
				continue
			}
			parts[i] = key + "=REDACTED"
		}
	}
	return strings.Join(parts, "&")
}
