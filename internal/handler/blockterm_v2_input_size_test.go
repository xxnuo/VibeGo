package handler

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/xxnuo/vibego/internal/service/blockterm"
)

func TestBlockTermEscapedInputSize(t *testing.T) {
	service, err := blockterm.Open(filepath.Join(t.TempDir(), "core.sqlite"), "bash")
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	router := gin.New()
	RegisterBlockTermV2(router.Group("/api"), service)
	for _, endpoint := range []string{"submit", "native"} {
		field := "command"
		if endpoint == "native" {
			field = "draft"
		}
		for _, size := range []int{blockterm.MaxCommandBytes, blockterm.MaxCommandBytes + 1} {
			body, err := json.Marshal(map[string]string{"owner": "owner", "request_id": "request", field: strings.Repeat("\x01", size)})
			if err != nil {
				t.Fatal(err)
			}
			if len(body) <= 2<<20 {
				t.Fatal("fixture does not exceed the old HTTP body limit")
			}
			request := httptest.NewRequest(http.MethodPost, "/api/blockterm/v2/sessions/missing/"+endpoint, bytes.NewReader(body))
			request.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			// Valid size reaches session lookup; oversized decoded data must fail
			// validation before lookup. Neither path creates or writes to a PTY.
			want := http.StatusNotFound
			if size > blockterm.MaxCommandBytes {
				want = http.StatusBadRequest
			}
			if response.Code != want || strings.Contains(response.Body.String(), "request body too large") {
				t.Fatalf("%s size=%d: status=%d body=%s", endpoint, size, response.Code, response.Body.String())
			}
		}
	}
	for _, endpoint := range []string{"submit", "native", "input", "control"} {
		limit := 2 << 20
		if endpoint == "submit" || endpoint == "native" {
			limit = 6*blockterm.MaxCommandBytes + 4096
		}
		request := httptest.NewRequest(http.MethodPost, "/api/blockterm/v2/sessions/missing/"+endpoint, strings.NewReader(strings.Repeat(" ", limit+1)+"{}"))
		request.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "request body too large") {
			t.Fatalf("%s lost HTTP size limit: status=%d body=%s", endpoint, response.Code, response.Body.String())
		}
	}
}
