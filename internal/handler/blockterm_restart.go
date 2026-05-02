package handler

import (
	"errors"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/xxnuo/vibego/internal/service/terminal"
	"gorm.io/gorm"
)

const blockTermRestartMaxBodyBytes = 16 * 1024

type blockTermRestartRequest struct {
	Token              string `json:"token"`
	IndependentRuntime bool   `json:"independent_runtime"`
	Mode               string `json:"mode"`
	TermCols           int    `json:"term_cols"`
	TermRows           int    `json:"term_rows"`
	TermFlexRows       bool   `json:"term_flex_rows"`
	TermMaxPTYSize     int    `json:"term_max_pty_size"`
	BeforeStateJSON    string `json:"before_state_json"`
}

type blockTermRestartCancelRequest struct {
	Token string `json:"token"`
}

func writeBlockTermRestartError(c *gin.Context, err error) {
	switch {
	case errors.Is(err, gorm.ErrRecordNotFound), errors.Is(err, terminal.ErrTerminalNotFound):
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
	case errors.Is(err, terminal.ErrBlockTermRestartBusy), errors.Is(err, terminal.ErrBlockTermRestartUnavailable):
		c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
	case errors.Is(err, terminal.ErrBlockTermRestartInvalid):
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
	case errors.Is(err, terminal.ErrBlockTermRestartUnsupported):
		c.JSON(http.StatusUnprocessableEntity, gin.H{"error": err.Error()})
	default:
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
	}
}

func (h *BlockTermHandler) Restart(c *gin.Context) {
	id := strings.TrimSpace(c.Param("id"))
	if id == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id is required"})
		return
	}

	var request blockTermRestartRequest
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, blockTermRestartMaxBodyBytes)
	if err := c.ShouldBindJSON(&request); err != nil {
		var maxBytesErr *http.MaxBytesError
		if errors.As(err, &maxBytesErr) {
			c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "request body is too large"})
			return
		}
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	block, err := h.manager.RestartBlockTermBlock(id, terminal.BlockTermRestartRequest{
		Token:              request.Token,
		IndependentRuntime: request.IndependentRuntime,
		Mode:               request.Mode,
		TermCols:           request.TermCols,
		TermRows:           request.TermRows,
		TermFlexRows:       request.TermFlexRows,
		TermMaxPTYSize:     request.TermMaxPTYSize,
		BeforeStateJSON:    request.BeforeStateJSON,
	})
	if err != nil {
		writeBlockTermRestartError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"block": block})
}

func (h *BlockTermHandler) CancelRestart(c *gin.Context) {
	id := strings.TrimSpace(c.Param("id"))
	if id == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id is required"})
		return
	}

	var request blockTermRestartCancelRequest
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, blockTermRestartMaxBodyBytes)
	if err := c.ShouldBindJSON(&request); err != nil {
		var maxBytesErr *http.MaxBytesError
		if errors.As(err, &maxBytesErr) {
			c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "request body is too large"})
			return
		}
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	block, err := h.manager.CancelBlockTermRestart(id, request.Token)
	if err != nil {
		writeBlockTermRestartError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"block": block})
}
