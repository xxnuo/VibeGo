package middleware

import (
	"net"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
)

func TestAllowWAN(t *testing.T) {
	gin.SetMode(gin.TestMode)

	tests := []struct {
		name           string
		clientIP       string
		allowWAN       bool
		expectedStatus int
	}{
		{
			name:           "Localhost IPv4",
			clientIP:       "127.0.0.1",
			allowWAN:       false,
			expectedStatus: http.StatusOK,
		},
		{
			name:           "Localhost IPv6",
			clientIP:       "::1",
			allowWAN:       false,
			expectedStatus: http.StatusOK,
		},
		{
			name:           "LAN IP 192.168.x.x",
			clientIP:       "192.168.1.50",
			allowWAN:       false,
			expectedStatus: http.StatusOK,
		},
		{
			name:           "LAN IP 10.x.x.x",
			clientIP:       "10.200.0.1",
			allowWAN:       false,
			expectedStatus: http.StatusOK,
		},
		{
			name:           "LAN IP 172.16.x.x",
			clientIP:       "172.16.0.1",
			allowWAN:       false,
			expectedStatus: http.StatusOK,
		},
		{
			name:           "Public IP - AllowWAN False",
			clientIP:       "8.8.8.8",
			allowWAN:       false,
			expectedStatus: http.StatusForbidden,
		},
		{
			name:           "Public IP - AllowWAN True",
			clientIP:       "8.8.8.8",
			allowWAN:       true,
			expectedStatus: http.StatusOK,
		},
		{
			name:           "IPv6 Link-Local",
			clientIP:       "fe80::1",
			allowWAN:       false,
			expectedStatus: http.StatusOK,
		},
		{
			name:           "IPv6 Unique Local",
			clientIP:       "fc00::1",
			allowWAN:       false,
			expectedStatus: http.StatusOK,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := gin.New()
			r.Use(AllowWAN(tt.allowWAN))
			r.GET("/test", func(c *gin.Context) {
				c.String(http.StatusOK, "Allowed")
			})

			req, _ := http.NewRequest("GET", "/test", nil)
			req.RemoteAddr = net.JoinHostPort(tt.clientIP, "12345")

			w := httptest.NewRecorder()
			r.ServeHTTP(w, req)

			assert.Equal(t, tt.expectedStatus, w.Code)
		})
	}
}

func TestAllowWANInvalidIP(t *testing.T) {
	gin.SetMode(gin.TestMode)

	r := gin.New()
	r.Use(AllowWAN(false))
	r.GET("/test", func(c *gin.Context) {
		c.String(http.StatusOK, "Allowed")
	})

	req, _ := http.NewRequest("GET", "/test", nil)
	req.RemoteAddr = "invalid-ip:12345"

	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusForbidden, w.Code)
}
