package middleware

import (
	"net"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/rs/zerolog/log"
)

var privateIPBlocks []*net.IPNet

func init() {
	cidrs := []string{
		"10.0.0.0/8",     // RFC1918
		"172.16.0.0/12",  // RFC1918
		"192.168.0.0/16", // RFC1918
		"fc00::/7",       // IPv6 Unique Local Address
		"fe80::/10",      // IPv6 Link-Local Address
	}

	for _, cidr := range cidrs {
		_, block, err := net.ParseCIDR(cidr)
		if err == nil {
			privateIPBlocks = append(privateIPBlocks, block)
		}
	}
}

func isPrivateIP(ip net.IP) bool {
	if ip.IsLoopback() {
		return true
	}
	for _, block := range privateIPBlocks {
		if block.Contains(ip) {
			return true
		}
	}
	return false
}

func AllowWAN(allowWAN bool) gin.HandlerFunc {
	return func(c *gin.Context) {
		clientIPStr := c.ClientIP()
		clientIP := net.ParseIP(clientIPStr)

		if clientIP == nil {
			log.Warn().Str("ip", clientIPStr).Msg("Invalid IP format")
			c.AbortWithStatus(http.StatusForbidden)
			return
		}

		if allowWAN || isPrivateIP(clientIP) {
			c.Next()
			return
		}

		log.Warn().
			Str("ip", clientIPStr).
			Str("path", c.Request.URL.Path).
			Msg("WAN access denied")
		c.AbortWithStatus(http.StatusForbidden)
	}
}
