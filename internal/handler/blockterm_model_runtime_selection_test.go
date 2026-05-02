package handler

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"
	"github.com/xxnuo/vibego/internal/model"
	"github.com/xxnuo/vibego/internal/service/blocktermmodel"
)

func TestBlockTermModelRunPersistsRuntimeSelection(t *testing.T) {
	router, db, service, upstreamURL := setupBlockTermModelHandler(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
	})
	baseURL := upstreamURL + "/v1"
	token := "runtime-selection-token"
	allowPrivate := true
	_, err := service.SetConfig(blocktermmodel.ConfigPatch{
		BaseURL: &baseURL, APIToken: &token, AllowPrivateNetwork: &allowPrivate,
	})
	require.NoError(t, err)

	body := `{"id":"handler-runtime-model","terminal_id":"terminal-1","command":"/chat runtime","prompt":"runtime","runtime_type":"ssh","ssh_profile_id":"child-profile"}`
	request := httptest.NewRequest(http.MethodPost, "/api/blockterm/model/runs", bytes.NewBufferString(body))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	require.Equal(t, http.StatusCreated, response.Code, response.Body.String())
	var created struct {
		Block model.BlockTermBlock `json:"block"`
	}
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &created))
	require.Equal(t, "ssh", created.Block.RuntimeType)
	require.Equal(t, "child-profile", created.Block.SSHProfileID)

	var persisted model.BlockTermBlock
	require.NoError(t, db.First(&persisted, "id = ?", created.Block.ID).Error)
	require.Equal(t, "ssh", persisted.RuntimeType)
	require.Equal(t, "child-profile", persisted.SSHProfileID)

	invalid := httptest.NewRequest(http.MethodPost, "/api/blockterm/model/runs", bytes.NewBufferString(
		`{"id":"handler-invalid-runtime-model","terminal_id":"terminal-1","prompt":"invalid","runtime_type":"local","ssh_profile_id":"profile"}`,
	))
	invalid.Header.Set("Content-Type", "application/json")
	invalidResponse := httptest.NewRecorder()
	router.ServeHTTP(invalidResponse, invalid)
	require.Equal(t, http.StatusBadRequest, invalidResponse.Code, invalidResponse.Body.String())
	require.Contains(t, invalidResponse.Body.String(), "ssh_profile_id is only valid for ssh runtime")
}
