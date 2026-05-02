package handler

import (
	"errors"
	"io"
	"net/http"

	"github.com/gin-gonic/gin"
)

func bindLimitedJSON(c *gin.Context, target any, limit int64) bool {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, limit)
	if err := c.ShouldBindJSON(target); err != nil {
		if errors.Is(err, io.EOF) {
			return true
		}
		var maxBytesErr *http.MaxBytesError
		if errors.As(err, &maxBytesErr) {
			c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "request body is too large"})
			return false
		}
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return false
	}
	return true
}
