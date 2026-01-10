package handler

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/gorilla/websocket"
	"github.com/xxnuo/vibego/internal/service/terminal"
	"gorm.io/gorm"
)

func setupTestHandler(t *testing.T) (*TerminalHandler, func()) {
	tmpDir := t.TempDir()
	dbPath := filepath.Join(tmpDir, "test.db")

	db, err := gorm.Open(sqlite.Open(dbPath), &gorm.Config{})
	if err != nil {
		t.Fatalf("failed to open database: %v", err)
	}

	if err := db.AutoMigrate(&terminal.TerminalSession{}, &terminal.TerminalHistory{}); err != nil {
		t.Fatalf("failed to migrate: %v", err)
	}

	mgr := terminal.NewManager(db, &terminal.ManagerConfig{Shell: os.Getenv("SHELL")})
	handler := &TerminalHandler{manager: mgr}

	cleanup := func() {
		sessions, _ := mgr.List()
		for _, s := range sessions {
			mgr.Close(s.ID)
		}
	}

	return handler, cleanup
}

func TestTerminalHandlerNew(t *testing.T) {
	handler, cleanup := setupTestHandler(t)
	defer cleanup()

	gin.SetMode(gin.TestMode)
	router := gin.New()
	handler.Register(router.Group("/api"))

	reqBody := NewTerminalRequest{
		Name: "test",
		Cols: 80,
		Rows: 24,
	}
	body, _ := json.Marshal(reqBody)

	req := httptest.NewRequest("POST", "/api/terminal/new", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", w.Code)
	}

	var resp map[string]interface{}
	json.Unmarshal(w.Body.Bytes(), &resp)

	if resp["ok"] != true {
		t.Error("expected ok=true")
	}
	if resp["id"] == "" {
		t.Error("expected non-empty id")
	}
}

func TestTerminalHandlerList(t *testing.T) {
	handler, cleanup := setupTestHandler(t)
	defer cleanup()

	info1, _ := handler.manager.Create(terminal.CreateOptions{Name: "test1", Cols: 80, Rows: 24})
	info2, _ := handler.manager.Create(terminal.CreateOptions{Name: "test2", Cols: 80, Rows: 24})

	gin.SetMode(gin.TestMode)
	router := gin.New()
	handler.Register(router.Group("/api"))

	req := httptest.NewRequest("GET", "/api/terminal/list", nil)
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", w.Code)
	}

	var resp map[string][]TerminalInfo
	json.Unmarshal(w.Body.Bytes(), &resp)

	terminals := resp["terminals"]
	if len(terminals) < 2 {
		t.Errorf("expected at least 2 terminals, got %d", len(terminals))
	}

	found := false
	for _, term := range terminals {
		if term.ID == info1.ID || term.ID == info2.ID {
			found = true
			if term.Status != terminal.StatusActive {
				t.Errorf("expected status %s, got %s", terminal.StatusActive, term.Status)
			}
			if term.PTYStatus != terminal.PTYStatusRunning {
				t.Errorf("expected PTY status %s, got %s", terminal.PTYStatusRunning, term.PTYStatus)
			}
		}
	}

	if !found {
		t.Error("created sessions not found in list")
	}
}

func TestTerminalHandlerClose(t *testing.T) {
	handler, cleanup := setupTestHandler(t)
	defer cleanup()

	info, _ := handler.manager.Create(terminal.CreateOptions{Name: "test", Cols: 80, Rows: 24})

	gin.SetMode(gin.TestMode)
	router := gin.New()
	handler.Register(router.Group("/api"))

	reqBody := CloseTerminalRequest{ID: info.ID}
	body, _ := json.Marshal(reqBody)

	req := httptest.NewRequest("POST", "/api/terminal/close", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", w.Code)
	}

	_, ok := handler.manager.Get(info.ID)
	if ok {
		t.Error("expected session to be closed")
	}
}

func TestTerminalHandlerWebSocket(t *testing.T) {
	handler, cleanup := setupTestHandler(t)
	defer cleanup()

	info, _ := handler.manager.Create(terminal.CreateOptions{Name: "test", Cols: 80, Rows: 24})

	gin.SetMode(gin.TestMode)
	router := gin.New()
	handler.Register(router.Group("/api"))

	server := httptest.NewServer(router)
	defer server.Close()

	wsURL := "ws" + server.URL[4:] + "/api/terminal/ws/" + info.ID

	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("failed to connect websocket: %v", err)
	}
	defer conn.Close()

	time.Sleep(100 * time.Millisecond)

	_, ok := handler.manager.Get(info.ID)
	if !ok {
		t.Fatal("session not found")
	}
}

func TestTerminalHistoryPersistence(t *testing.T) {
	handler, cleanup := setupTestHandler(t)
	defer cleanup()

	info, _ := handler.manager.Create(terminal.CreateOptions{Name: "test", Cols: 80, Rows: 24})

	sessions, _ := handler.manager.List()
	var found *terminal.TerminalInfo
	for i, s := range sessions {
		if s.ID == info.ID {
			found = &sessions[i]
			break
		}
	}

	if found == nil {
		t.Fatal("session not found")
	}

	if found.PTYStatus != terminal.PTYStatusRunning {
		t.Errorf("expected PTY status %s, got %s", terminal.PTYStatusRunning, found.PTYStatus)
	}
}
