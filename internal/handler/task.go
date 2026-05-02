package handler

import (
	"encoding/json"
	"net/http"
	"os/exec"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

// TaskHandler streams command output on the authenticated API connection.
// Disconnecting cancels the entire process tree, including background children.
type TaskHandler struct {
	mu     sync.Mutex
	tasks  map[string]*exec.Cmd
	closed bool
}

func NewTaskHandler() *TaskHandler { return &TaskHandler{tasks: make(map[string]*exec.Cmd)} }
func (h *TaskHandler) Register(api *gin.RouterGroup) {
	api.POST("/tasks", h.Run)
	api.DELETE("/tasks/:id", h.Cancel)
}
func (h *TaskHandler) Cancel(c *gin.Context) {
	h.mu.Lock()
	defer h.mu.Unlock()
	cmd := h.tasks[c.Param("id")]
	if cmd == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Task not running"})
		return
	}
	if err := killTaskProcess(cmd); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}
func (h *TaskHandler) Close() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.closed = true
	for _, cmd := range h.tasks {
		_ = killTaskProcess(cmd)
	}
}

type taskStream struct {
	mu      sync.Mutex
	c       *gin.Context
	ready   chan struct{}
	pending []byte
}

func (s *taskStream) emit(event any) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.pending) > 0 {
		if err := s.emitLocked(gin.H{"output": string(s.pending)}); err != nil {
			return err
		}
		s.pending = nil
	}
	return s.emitLocked(event)
}
func (s *taskStream) emitLocked(event any) error {
	_ = http.NewResponseController(s.c.Writer).SetWriteDeadline(time.Now().Add(10 * time.Second))
	if err := json.NewEncoder(s.c.Writer).Encode(event); err != nil {
		return err
	}
	s.c.Writer.Flush()
	return nil
}
func (s *taskStream) Write(data []byte) (int, error) {
	<-s.ready
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pending = append(s.pending, data...)
	end := 0
	for end < len(s.pending) && utf8.FullRune(s.pending[end:]) {
		_, size := utf8.DecodeRune(s.pending[end:])
		end += size
	}
	if end > 0 {
		if err := s.emitLocked(gin.H{"output": string(s.pending[:end])}); err != nil {
			return 0, err
		}
		s.pending = append([]byte(nil), s.pending[end:]...)
	}
	return len(data), nil
}
func (h *TaskHandler) Run(c *gin.Context) {
	var input struct {
		Command string `json:"command"`
		Cwd     string `json:"cwd"`
	}
	if !bindLimitedJSON(c, &input, 512<<10) {
		return
	}
	if strings.TrimSpace(input.Command) == "" || len(input.Command) > 64*1024 || strings.ContainsRune(input.Command, 0) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid task command"})
		return
	}
	cmd := newTaskCommand(input.Command)
	cmd.Dir = input.Cwd
	// A descendant retaining stdout must not hold a finished task open forever.
	cmd.WaitDelay = 2 * time.Second
	stream := &taskStream{c: c, ready: make(chan struct{})}
	cmd.Stdout, cmd.Stderr = stream, stream
	id := uuid.NewString()
	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "Task runner shutting down"})
		return
	}
	if len(h.tasks) >= 32 {
		h.mu.Unlock()
		c.JSON(http.StatusTooManyRequests, gin.H{"error": "Too many running tasks"})
		return
	}
	if err := cmd.Start(); err != nil {
		h.mu.Unlock()
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	h.tasks[id] = cmd
	h.mu.Unlock()
	defer func() { h.mu.Lock(); delete(h.tasks, id); h.mu.Unlock() }()
	c.Header("Content-Type", "application/x-ndjson")
	c.Header("Cache-Control", "no-store")
	c.Header("X-Accel-Buffering", "no")
	_ = stream.emit(gin.H{"id": id})
	close(stream.ready)
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case <-c.Request.Context().Done():
		_ = killTaskProcess(cmd)
		<-done
	case err := <-done:
		code := 0
		if err != nil {
			code = cmd.ProcessState.ExitCode()
			if code == 0 {
				code = -1
			}
		}
		// Kill orphaned descendants before releasing the process group identity.
		_ = killTaskProcess(cmd)
		_ = stream.emit(gin.H{"exitCode": code})
	}
}
