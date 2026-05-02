package handler

import (
	"bufio"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

func taskServer(t *testing.T) (*TaskHandler, *httptest.Server) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	handler := NewTaskHandler()
	router := gin.New()
	handler.Register(router.Group("/api"))
	server := httptest.NewServer(router)
	t.Cleanup(func() { handler.Close(); server.Close() })
	return handler, server
}
func TestTaskOutputExitAndValidation(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell fixture")
	}
	_, server := taskServer(t)
	for _, fixture := range []struct {
		command string
		code    int
	}{{"printf 'hello'; printf 'error' >&2", 0}, {"printf failed; exit 7", 7}} {
		response, err := http.Post(server.URL+"/api/tasks", "application/json", strings.NewReader(`{"command":`+strconvQuote(fixture.command)+`,"cwd":`+strconvQuote(t.TempDir())+`}`))
		if err != nil {
			t.Fatal(err)
		}
		decoder := json.NewDecoder(response.Body)
		var output string
		var code *int
		var id string
		for {
			var event struct {
				ID       string `json:"id"`
				Output   string `json:"output"`
				ExitCode *int   `json:"exitCode"`
			}
			err := decoder.Decode(&event)
			if err == io.EOF {
				break
			}
			if err != nil {
				t.Fatal(err)
			}
			if id == "" && event.ID == "" {
				t.Fatal("Output preceded task ID")
			}
			if event.ID != "" {
				id = event.ID
			}
			output += event.Output
			if event.ExitCode != nil {
				code = event.ExitCode
			}
		}
		response.Body.Close()
		if id == "" || output == "" || code == nil || *code != fixture.code {
			t.Fatalf("id=%q output=%q code=%v", id, output, code)
		}
	}
	response, err := http.Post(server.URL+"/api/tasks", "application/json", strings.NewReader(`{"command":""}`))
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 400 {
		t.Fatal(response.Status)
	}
	response, err = http.Post(server.URL+"/api/tasks", "application/json", strings.NewReader(`{"command":"pwd","cwd":"/nonexistent-vibego-task-folder"}`))
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 400 {
		t.Fatal(response.Status)
	}
	response, err = http.Post(server.URL+"/api/tasks", "application/json", strings.NewReader(`{"command":"pwd","padding":"`+strings.Repeat("x", 600000)+`"}`))
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatal(response.Status)
	}
}
func strconvQuote(value string) string { data, _ := json.Marshal(value); return string(data) }
func TestTaskCancelAndDisconnect(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell fixture")
	}
	handler, server := taskServer(t)
	for _, disconnect := range []bool{false, true} {
		marker := filepath.Join(t.TempDir(), "survived")
		command := "(sleep 0.5; printf survived > '" + marker + "') & wait"
		response, err := http.Post(server.URL+"/api/tasks", "application/json", strings.NewReader(`{"command":`+strconvQuote(command)+`}`))
		if err != nil {
			t.Fatal(err)
		}
		scanner := bufio.NewScanner(response.Body)
		if !scanner.Scan() {
			t.Fatal("Missing task ID")
		}
		var event struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &event); err != nil {
			t.Fatal(err)
		}
		if disconnect {
			response.Body.Close()
		} else {
			request, _ := http.NewRequest(http.MethodDelete, server.URL+"/api/tasks/"+event.ID, nil)
			result, err := http.DefaultClient.Do(request)
			if err != nil {
				t.Fatal(err)
			}
			result.Body.Close()
			if result.StatusCode != 200 {
				t.Fatal(result.Status)
			}
			exited := false
			for scanner.Scan() {
				if strings.Contains(scanner.Text(), "exitCode") {
					exited = true
				}
			}
			response.Body.Close()
			if !exited {
				t.Fatal("No exit notification")
			}
		}
		time.Sleep(600 * time.Millisecond)
		if _, err := os.Stat(marker); !os.IsNotExist(err) {
			t.Fatal("Descendant survived cancellation")
		}
		deadline := time.Now().Add(3 * time.Second)
		for {
			handler.mu.Lock()
			count := len(handler.tasks)
			handler.mu.Unlock()
			if count == 0 {
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("Task or its descendants survived cancellation")
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
}

func TestTaskStreamPreservesUTF8AcrossOutputChunks(t *testing.T) {
	response := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(response)
	ready := make(chan struct{})
	close(ready)
	stream := &taskStream{c: context, ready: ready}
	for _, value := range []byte("中文输出") {
		if _, err := stream.Write([]byte{value}); err != nil {
			t.Fatal(err)
		}
	}
	if err := stream.emit(gin.H{"exitCode": 0}); err != nil {
		t.Fatal(err)
	}
	decoder := json.NewDecoder(response.Body)
	output := ""
	for {
		var event struct {
			Output string `json:"output"`
		}
		err := decoder.Decode(&event)
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		output += event.Output
	}
	if output != "中文输出" {
		t.Fatalf("Corrupted UTF-8 output: %q", output)
	}
}
