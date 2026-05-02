package handler

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"github.com/stretchr/testify/require"
)

func TestForwardCodexOutputAllowsHistoricalResponseOverRequestLimit(t *testing.T) {
	payload := bytes.Repeat([]byte("x"), codexMaxMessageBytes+1024)
	line, err := json.Marshal(map[string]string{"text": string(payload)})
	require.NoError(t, err)
	line = append(line, '\n')

	var forwarded []byte
	require.NoError(t, forwardCodexOutput(bytes.NewReader(line), func(value []byte) error {
		forwarded = append([]byte(nil), value...)
		return nil
	}))
	require.Equal(t, line[:len(line)-1], forwarded)
}

func TestForwardCodexOutputReplacesOversizedResponseAndContinues(t *testing.T) {
	const limit = 128
	oversized, err := json.Marshal(struct {
		ID     int            `json:"id"`
		Result map[string]any `json:"result"`
	}{ID: 7, Result: map[string]any{"text": string(bytes.Repeat([]byte("x"), limit*2))}})
	require.NoError(t, err)
	normal := []byte(`{"id":8,"result":{"ok":true}}`)
	input := append(append(append([]byte(nil), oversized...), '\n'), normal...)
	input = append(input, '\n')

	var forwarded [][]byte
	require.NoError(t, forwardCodexOutputWithLimit(bytes.NewReader(input), func(value []byte) error {
		forwarded = append(forwarded, append([]byte(nil), value...))
		return nil
	}, limit))
	require.Len(t, forwarded, 2)

	var replacement struct {
		ID    int `json:"id"`
		Error struct {
			Code int `json:"code"`
			Data struct {
				LimitBytes int `json:"limitBytes"`
			} `json:"data"`
		} `json:"error"`
	}
	require.NoError(t, json.Unmarshal(forwarded[0], &replacement))
	require.Equal(t, 7, replacement.ID)
	require.Equal(t, codexOutputTooLargeCode, replacement.Error.Code)
	require.Equal(t, limit, replacement.Error.Data.LimitBytes)
	require.JSONEq(t, string(normal), string(forwarded[1]))
}

func TestForwardCodexOutputDropsOversizedNotificationAndContinues(t *testing.T) {
	const limit = 128
	oversized, err := json.Marshal(map[string]any{
		"method": "item/agentMessage/delta",
		"params": map[string]any{"delta": string(bytes.Repeat([]byte("x"), limit*2))},
	})
	require.NoError(t, err)
	normal := []byte(`{"id":9,"result":{"ok":true}}`)
	input := append(append(append([]byte(nil), oversized...), '\n'), normal...)
	input = append(input, '\n')

	var forwarded [][]byte
	require.NoError(t, forwardCodexOutputWithLimit(bytes.NewReader(input), func(value []byte) error {
		forwarded = append(forwarded, append([]byte(nil), value...))
		return nil
	}, limit))
	require.Len(t, forwarded, 1)
	require.JSONEq(t, string(normal), string(forwarded[0]))
}

func TestExtractCodexResponseID(t *testing.T) {
	id, ok := extractCodexResponseID([]byte(` { "id" : "request-7", "result": {`))
	require.True(t, ok)
	require.JSONEq(t, `"request-7"`, string(id))

	_, ok = extractCodexResponseID([]byte(`{"method":"item/started","params":{`))
	require.False(t, ok)
}

func TestCodexStatus(t *testing.T) {
	gin.SetMode(gin.TestMode)
	handler := newCodexHandlerWithDependencies(nil, func(context.Context) CodexStatus {
		return CodexStatus{Available: true, Path: "/usr/bin/codex", Version: "codex-cli test"}
	})
	router := gin.New()
	handler.Register(router.Group("/api"))

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest("GET", "/api/codex/status", nil)
	router.ServeHTTP(recorder, request)

	require.Equal(t, 200, recorder.Code)
	require.JSONEq(t, `{"available":true,"path":"/usr/bin/codex","version":"codex-cli test"}`, recorder.Body.String())
}

func TestCodexWebSocketBridgesJSONRPC(t *testing.T) {
	gin.SetMode(gin.TestMode)
	handler := newCodexHandlerWithDependencies(func(ctx context.Context) *exec.Cmd {
		cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=TestCodexBridgeHelperProcess")
		cmd.Env = append(os.Environ(), "VIBEGO_CODEX_HELPER=1")
		return cmd
	}, func(context.Context) CodexStatus { return CodexStatus{Available: true} })
	router := gin.New()
	handler.Register(router.Group("/api"))
	server := httptest.NewServer(router)
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/api/codex/ws"
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, http.Header{"Origin": []string{server.URL}})
	require.NoError(t, err)
	defer conn.Close()

	require.NoError(t, conn.WriteJSON(map[string]any{
		"method": "initialize",
		"id":     7,
		"params": map[string]any{"clientInfo": map[string]any{"name": "test"}},
	}))
	require.NoError(t, conn.SetReadDeadline(time.Now().Add(3*time.Second)))

	var response map[string]any
	require.NoError(t, conn.ReadJSON(&response))
	require.Equal(t, float64(7), response["id"])
	result, ok := response["result"].(map[string]any)
	require.True(t, ok)
	require.Equal(t, "initialize", result["echoMethod"])

	var notification map[string]any
	require.NoError(t, conn.ReadJSON(&notification))
	require.Equal(t, "test/ready", notification["method"])
}

func TestCodexWebSocketRejectsCrossOrigin(t *testing.T) {
	gin.SetMode(gin.TestMode)
	var commandStarted atomic.Bool
	handler := newCodexHandlerWithDependencies(func(ctx context.Context) *exec.Cmd {
		commandStarted.Store(true)
		cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=TestCodexBridgeHelperProcess")
		cmd.Env = append(os.Environ(), "VIBEGO_CODEX_HELPER=1")
		return cmd
	}, func(context.Context) CodexStatus { return CodexStatus{Available: true} })
	router := gin.New()
	handler.Register(router.Group("/api"))
	server := httptest.NewServer(router)
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/api/codex/ws"
	conn, response, err := websocket.DefaultDialer.Dial(
		wsURL,
		http.Header{"Origin": []string{"https://attacker.example"}},
	)
	if conn != nil {
		_ = conn.Close()
	}
	require.Error(t, err)
	require.NotNil(t, response)
	defer response.Body.Close()
	require.Equal(t, http.StatusForbidden, response.StatusCode)
	require.False(t, commandStarted.Load())
}

func TestCodexBridgeHelperProcess(t *testing.T) {
	if os.Getenv("VIBEGO_CODEX_HELPER") != "1" {
		return
	}
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		var message map[string]any
		if err := json.Unmarshal(scanner.Bytes(), &message); err != nil {
			os.Exit(2)
		}
		if id, ok := message["id"]; ok {
			payload, _ := json.Marshal(map[string]any{
				"id": id,
				"result": map[string]any{
					"echoMethod": message["method"],
				},
			})
			fmt.Println(string(payload))
			fmt.Println(`{"method":"test/ready","params":{}}`)
		}
	}
	os.Exit(0)
}
