package handler

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/xxnuo/vibego/internal/service/blocktermmodel"
)

const blockTermModelMaxBodyBytes = blocktermmodel.MaxRunInputBytes

type BlockTermModelHandler struct {
	service *blocktermmodel.Service
}

func NewBlockTermModelHandler(service *blocktermmodel.Service) *BlockTermModelHandler {
	return &BlockTermModelHandler{service: service}
}

func (h *BlockTermModelHandler) Register(r *gin.RouterGroup) {
	group := r.Group("/blockterm/model")
	group.GET("/config", h.GetConfig)
	group.PUT("/config", h.PutConfig)
	group.DELETE("/config", h.DeleteConfig)
	group.POST("/runs", h.CreateRun)
	group.GET("/runs/:id/events", h.Events)
	group.POST("/runs/:id/cancel", h.Cancel)
}

type blockTermModelConfigResponse struct {
	BaseURL             string `json:"base_url"`
	Model               string `json:"model"`
	MaxTokens           int    `json:"max_tokens"`
	TimeoutSecond       int    `json:"timeout_seconds"`
	AllowPrivateNetwork bool   `json:"allow_private_network"`
	APITokenSet         bool   `json:"api_token_set"`
}

func modelConfigResponse(config blocktermmodel.Config) blockTermModelConfigResponse {
	return blockTermModelConfigResponse{
		BaseURL: config.BaseURL, Model: config.Model, MaxTokens: config.MaxTokens,
		TimeoutSecond: config.TimeoutSecond, AllowPrivateNetwork: config.AllowPrivateNetwork, APITokenSet: config.APITokenSet(),
	}
}

func (h *BlockTermModelHandler) GetConfig(c *gin.Context) {
	config, err := h.service.Config()
	if err != nil {
		writeBlockTermModelError(c, err)
		return
	}
	c.JSON(http.StatusOK, modelConfigResponse(config))
}

type blockTermModelConfigRequest struct {
	BaseURL             *string `json:"base_url"`
	Model               *string `json:"model"`
	MaxTokens           *int    `json:"max_tokens"`
	TimeoutSecond       *int    `json:"timeout_seconds"`
	AllowPrivateNetwork *bool   `json:"allow_private_network"`
	APIToken            *string `json:"api_token"`
	Token               *string `json:"token"`
}

func (h *BlockTermModelHandler) PutConfig(c *gin.Context) {
	var request blockTermModelConfigRequest
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 16*1024)
	if err := c.ShouldBindJSON(&request); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	apiToken := request.APIToken
	if apiToken == nil {
		apiToken = request.Token
	}
	config, err := h.service.SetConfig(blocktermmodel.ConfigPatch{
		BaseURL: request.BaseURL, Model: request.Model, MaxTokens: request.MaxTokens,
		TimeoutSecond: request.TimeoutSecond, APIToken: apiToken,
		AllowPrivateNetwork: request.AllowPrivateNetwork,
	})
	if err != nil {
		writeBlockTermModelError(c, err)
		return
	}
	c.JSON(http.StatusOK, modelConfigResponse(config))
}

func (h *BlockTermModelHandler) DeleteConfig(c *gin.Context) {
	config, err := h.service.DeleteConfig()
	if err != nil {
		writeBlockTermModelError(c, err)
		return
	}
	c.JSON(http.StatusOK, modelConfigResponse(config))
}

type blockTermModelRunRequest struct {
	ID             string                           `json:"id"`
	BlockID        string                           `json:"block_id"`
	TerminalID     string                           `json:"terminal_id"`
	LineNum        *int                             `json:"line_num"`
	Command        string                           `json:"command"`
	CurrentCommand string                           `json:"current_command"`
	Prompt         string                           `json:"prompt"`
	Cwd            string                           `json:"cwd"`
	Model          string                           `json:"model"`
	RuntimeType    string                           `json:"runtime_type"`
	SSHProfileID   string                           `json:"ssh_profile_id"`
	Messages       []blocktermmodel.RunMessage      `json:"messages"`
	Context        *blockTermModelRunContextRequest `json:"context"`
	SourceBlockID  string                           `json:"source_block_id"`
}

type blockTermModelRunContextRequest struct {
	SourceBlockID string `json:"source_block_id"`
}

func (h *BlockTermModelHandler) CreateRun(c *gin.Context) {
	var request blockTermModelRunRequest
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, blockTermModelMaxBodyBytes)
	if err := c.ShouldBindJSON(&request); err != nil {
		var maxBytesErr *http.MaxBytesError
		if errors.As(err, &maxBytesErr) {
			c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "request body is too large"})
			return
		}
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	var runContext *blocktermmodel.RunContext
	if request.Context != nil {
		runContext = &blocktermmodel.RunContext{SourceBlockID: request.Context.SourceBlockID}
	}
	block, err := h.service.CreateRun(c.Request.Context(), blocktermmodel.RunInput{
		ID: request.ID, BlockID: request.BlockID, TerminalID: request.TerminalID,
		LineNum: request.LineNum, Command: request.Command, CurrentCommand: request.CurrentCommand,
		Prompt: request.Prompt, Cwd: request.Cwd, Model: request.Model,
		RuntimeType: request.RuntimeType, SSHProfileID: request.SSHProfileID,
		Messages: request.Messages, Context: runContext, SourceBlockID: request.SourceBlockID,
	})
	if err != nil {
		writeBlockTermModelError(c, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"block": block})
}

func parseBlockTermModelAfter(raw string) (int64, error) {
	if strings.TrimSpace(raw) == "" {
		return 0, nil
	}
	after, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || after < 0 {
		return 0, errors.New("after must be a non-negative integer")
	}
	return after, nil
}

func (h *BlockTermModelHandler) Events(c *gin.Context) {
	rawAfter := c.Query("after")
	if strings.TrimSpace(rawAfter) == "" {
		rawAfter = c.GetHeader("Last-Event-ID")
	}
	after, err := parseBlockTermModelAfter(rawAfter)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	subscription, err := h.service.Subscribe(c.Param("id"), after)
	if err != nil {
		writeBlockTermModelError(c, err)
		return
	}
	defer subscription.Close()
	flusher, ok := c.Writer.(http.Flusher)
	if !ok {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "streaming is not supported"})
		return
	}
	c.Header("Content-Type", "text/event-stream; charset=utf-8")
	c.Header("Cache-Control", "no-cache, no-store")
	c.Header("Connection", "keep-alive")
	c.Header("X-Accel-Buffering", "no")
	c.Status(http.StatusOK)
	flusher.Flush()
	writeEvent := func(event blocktermmodel.Event) bool {
		payload, marshalErr := json.Marshal(event)
		if marshalErr != nil {
			return false
		}
		if _, writeErr := fmt.Fprintf(c.Writer, "id: %d\ndata: %s\n\n", event.Seq, payload); writeErr != nil {
			return false
		}
		flusher.Flush()
		return true
	}
	for _, event := range subscription.Events {
		if !writeEvent(event) || event.Done {
			return
		}
	}
	keepAlive := time.NewTicker(15 * time.Second)
	defer keepAlive.Stop()
	for {
		select {
		case <-c.Request.Context().Done():
			return
		case event, open := <-subscription.C:
			if !open || !writeEvent(event) || event.Done {
				return
			}
		case <-keepAlive.C:
			if _, err := c.Writer.Write([]byte(": keep-alive\n\n")); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

func (h *BlockTermModelHandler) Cancel(c *gin.Context) {
	if err := h.service.CancelContext(c.Request.Context(), c.Param("id")); err != nil {
		writeBlockTermModelError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func writeBlockTermModelError(c *gin.Context, err error) {
	switch {
	case errors.Is(err, blocktermmodel.ErrRunNotFound), errors.Is(err, blocktermmodel.ErrTerminalNotFound), errors.Is(err, blocktermmodel.ErrSourceBlockNotFound):
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
	case errors.Is(err, blocktermmodel.ErrBlockDeleted), errors.Is(err, blocktermmodel.ErrRunConflict), errors.Is(err, blocktermmodel.ErrSourceBlockUnavailable):
		c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
	case errors.Is(err, blocktermmodel.ErrTerminalNotRunning):
		c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
	case errors.Is(err, blocktermmodel.ErrServiceClosed):
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": err.Error()})
	case errors.Is(err, blocktermmodel.ErrRunInputTooLarge):
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": err.Error()})
	case errors.Is(err, blocktermmodel.ErrInvalidRunInput):
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
	case errors.Is(err, blocktermmodel.ErrInvalidConfig), errors.Is(err, blocktermmodel.ErrMissingAPIToken), errors.Is(err, blocktermmodel.ErrInvalidEventCursor):
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
	default:
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
	}
}
