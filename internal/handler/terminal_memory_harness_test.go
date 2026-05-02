package handler

import (
	"github.com/gin-gonic/gin"
	"github.com/xxnuo/vibego/internal/middleware"
	"github.com/xxnuo/vibego/internal/model"
	"github.com/xxnuo/vibego/internal/service/terminal"
	"net/http/httptest"
	"os"
	"runtime"
	"testing"
	"time"
)

// Opt-in browser/PTY harness. It owns a temporary database and ephemeral port.
func TestTerminalMemoryHarness(t *testing.T) {
	file := os.Getenv("VIBEGO_TERMINAL_HARNESS_FILE")
	if file == "" {
		t.Skip("browser harness only")
	}
	db, workspace, router := workspaceFixture(t)
	for _, row := range []any{&model.UserSession{ID: "ws", Name: "Test", State: "{}"}, &model.Workspace{ID: "ws", Name: "Test", Revision: 1}} {
		if err := db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	manager := terminal.NewManager(db, &terminal.ManagerConfig{Shell: "/bin/sh", TerminalEvents: workspace.PublishTerminalEvent, WorkspaceChanged: workspace.TerminalsChanged})
	NewTerminalHandler(manager).Register(router.Group("/api", middleware.Auth("test-key")))
	router.GET("/harness/metrics", func(c *gin.Context) {
		active := 0
		var historyBytes int64
		sessions, _ := manager.List("", "")
		for _, s := range sessions {
			historyBytes += s.HistorySize
			if _, ok := manager.Get(s.ID); ok {
				active++
			}
		}
		runtime.GC()
		var memory runtime.MemStats
		runtime.ReadMemStats(&memory)
		c.JSON(200, gin.H{"active": active, "historyBytes": historyBytes, "heap": memory.HeapAlloc, "goroutines": runtime.NumGoroutine()})
	})
	server := httptest.NewServer(router)
	defer server.Close()
	defer func() {
		sessions, _ := manager.List("", "")
		for _, s := range sessions {
			_ = manager.Close(s.ID)
		}
	}()
	if err := os.WriteFile(file, []byte(server.URL), 0600); err != nil {
		t.Fatal(err)
	}
	timer := time.NewTimer(15 * time.Minute)
	defer timer.Stop()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-timer.C:
			t.Fatal("browser harness timed out")
		case <-ticker.C:
			if _, err := os.Stat(file + ".stop"); err == nil {
				return
			}
		}
	}
}
