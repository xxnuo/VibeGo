package handler

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
	"github.com/xxnuo/vibego/internal/model"
	"github.com/xxnuo/vibego/internal/service/terminal"
	"gorm.io/gorm"
)

type blockTermViewResponse struct {
	View terminal.BlockTermViewState `json:"view"`
}

func setupBlockTermViewHandler(t *testing.T) (*TerminalHandler, *gin.Engine) {
	t.Helper()
	handler, cleanup := setupTestHandler(t)
	t.Cleanup(cleanup)
	require.NoError(t, handler.manager.DB().AutoMigrate(&model.SSHConnectionProfile{}))
	gin.SetMode(gin.TestMode)
	router := gin.New()
	handler.Register(router.Group("/api"))
	return handler, router
}

func doBlockTermViewRequest(router http.Handler, method, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	response := httptest.NewRecorder()
	router.ServeHTTP(response, req)
	return response
}

func TestTerminalHandlerBlockTermViewRoutesAndPatch(t *testing.T) {
	handler, router := setupBlockTermViewHandler(t)
	require.NoError(t, handler.manager.DB().Create(&model.TerminalSession{
		ID:     "terminal-view-handler",
		Name:   "view",
		Status: model.StatusClosed,
	}).Error)
	require.NoError(t, handler.manager.DB().Create(&model.BlockTermBlock{
		ID:         "block-view-handler",
		TerminalID: "terminal-view-handler",
		LineNum:    0,
	}).Error)

	response := doBlockTermViewRequest(
		router,
		http.MethodGet,
		"/api/blockterm/sessions/terminal-view-handler/view",
		"",
	)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	var body blockTermViewResponse
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &body))
	require.False(t, body.View.Sidebar.Open)
	require.Equal(t, "50%", body.View.Sidebar.Width)
	require.Nil(t, body.View.Sidebar.BlockID)

	response = doBlockTermViewRequest(
		router,
		http.MethodPatch,
		"/api/blockterm/sessions/terminal-view-handler/view",
		`{"sidebar":{"open":true,"width":"500px","block_id":"block-view-handler"}}`,
	)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	body = blockTermViewResponse{}
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &body))
	require.True(t, body.View.Sidebar.Open)
	require.Equal(t, "500px", body.View.Sidebar.Width)
	require.Equal(t, "block-view-handler", *body.View.Sidebar.BlockID)

	response = doBlockTermViewRequest(
		router,
		http.MethodPatch,
		"/api/blockterm/sessions/terminal-view-handler/view",
		`{"sidebar":{"block_id":null}}`,
	)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	body = blockTermViewResponse{}
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &body))
	require.True(t, body.View.Sidebar.Open)
	require.Equal(t, "500px", body.View.Sidebar.Width)
	require.Nil(t, body.View.Sidebar.BlockID)
}

func TestTerminalHandlerBlockTermViewNextConnectionPatch(t *testing.T) {
	handler, router := setupBlockTermViewHandler(t)
	require.NoError(t, handler.manager.DB().Create(&model.TerminalSession{
		ID:          "terminal-view-connection",
		Name:        "connection",
		Cwd:         "/terminal/cwd",
		CurrentCwd:  "/terminal/current",
		RuntimeType: terminal.RuntimeTypeLocal,
		Status:      model.StatusClosed,
	}).Error)
	require.NoError(t, handler.manager.DB().Create(&model.BlockTermBlock{
		ID:         "block-view-connection",
		TerminalID: "terminal-view-connection",
		LineNum:    0,
	}).Error)
	require.NoError(t, handler.manager.DB().Create(&model.SSHConnectionProfile{
		ID:             "profile-view-connection",
		Name:           "connection",
		Host:           "127.0.0.1",
		Port:           22,
		User:           "test",
		AuthMethod:     "password",
		ConnectTimeout: 10,
		CreatedAt:      1,
		UpdatedAt:      1,
	}).Error)

	path := "/api/blockterm/sessions/terminal-view-connection/view"
	response := doBlockTermViewRequest(
		router,
		http.MethodPatch,
		path,
		`{"sidebar":{"open":true,"width":"500px","block_id":"block-view-connection"},"next_connection":{"runtime_type":"local","cwd":" /selected/local "}}`,
	)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	var body blockTermViewResponse
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &body))
	require.True(t, body.View.Sidebar.Open)
	require.Equal(t, "500px", body.View.Sidebar.Width)
	require.Equal(t, "block-view-connection", *body.View.Sidebar.BlockID)
	require.NotNil(t, body.View.NextConnection)
	require.Equal(t, terminal.RuntimeTypeLocal, body.View.NextConnection.RuntimeType)
	require.Nil(t, body.View.NextConnection.SSHProfileID)
	require.Equal(t, "/selected/local", body.View.NextConnection.Cwd)

	response = doBlockTermViewRequest(
		router,
		http.MethodPatch,
		path,
		`{"sidebar":{"width":"60%"}}`,
	)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	body = blockTermViewResponse{}
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &body))
	require.Equal(t, "60%", body.View.Sidebar.Width)
	require.NotNil(t, body.View.NextConnection)
	require.Equal(t, "/selected/local", body.View.NextConnection.Cwd)

	response = doBlockTermViewRequest(
		router,
		http.MethodPatch,
		path,
		`{"next_connection":{"runtime_type":"ssh","ssh_profile_id":" profile-view-connection ","cwd":" /selected/remote "}}`,
	)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	body = blockTermViewResponse{}
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &body))
	require.True(t, body.View.Sidebar.Open)
	require.Equal(t, "60%", body.View.Sidebar.Width)
	require.Equal(t, "block-view-connection", *body.View.Sidebar.BlockID)
	require.NotNil(t, body.View.NextConnection)
	require.Equal(t, terminal.RuntimeTypeSSH, body.View.NextConnection.RuntimeType)
	require.Equal(t, "profile-view-connection", *body.View.NextConnection.SSHProfileID)
	require.Equal(t, "/selected/remote", body.View.NextConnection.Cwd)

	response = doBlockTermViewRequest(
		router,
		http.MethodPatch,
		path,
		`{"next_connection":{"runtime_type":"local","ssh_profile_id":"profile-view-connection","cwd":""}}`,
	)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	body = blockTermViewResponse{}
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &body))
	require.NotNil(t, body.View.NextConnection)
	require.Equal(t, terminal.RuntimeTypeLocal, body.View.NextConnection.RuntimeType)
	require.Nil(t, body.View.NextConnection.SSHProfileID)
	require.Equal(t, "/terminal/current", body.View.NextConnection.Cwd)

	response = doBlockTermViewRequest(router, http.MethodPatch, path, `{"next_connection":null}`)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	body = blockTermViewResponse{}
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &body))
	require.Nil(t, body.View.NextConnection)
	require.True(t, body.View.Sidebar.Open)
	require.Equal(t, "60%", body.View.Sidebar.Width)
	require.Equal(t, "block-view-connection", *body.View.Sidebar.BlockID)
}

func TestTerminalHandlerBlockTermViewNextConnectionValidationIsAtomic(t *testing.T) {
	handler, router := setupBlockTermViewHandler(t)
	require.NoError(t, handler.manager.DB().Create(&model.TerminalSession{
		ID:          "terminal-view-connection-validation",
		Name:        "connection validation",
		CurrentCwd:  "/terminal/current",
		RuntimeType: terminal.RuntimeTypeLocal,
		Status:      model.StatusClosed,
	}).Error)
	require.NoError(t, handler.manager.DB().Create(&model.BlockTermBlock{
		ID:         "block-view-connection-validation",
		TerminalID: "terminal-view-connection-validation",
		LineNum:    0,
	}).Error)

	path := "/api/blockterm/sessions/terminal-view-connection-validation/view"
	response := doBlockTermViewRequest(
		router,
		http.MethodPatch,
		path,
		`{"sidebar":{"open":true,"width":"500px","block_id":"block-view-connection-validation"},"next_connection":{"runtime_type":"local","cwd":"/saved/cwd"}}`,
	)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	var expected blockTermViewResponse
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &expected))

	tests := []struct {
		name   string
		body   string
		status int
		code   string
	}{
		{name: "unknown root", body: `{"other":true}`, status: http.StatusBadRequest},
		{name: "unknown sidebar", body: `{"sidebar":{"extra":true}}`, status: http.StatusBadRequest},
		{name: "unknown next connection", body: `{"next_connection":{"runtime_type":"local","extra":true}}`, status: http.StatusBadRequest},
		{name: "next connection array", body: `{"next_connection":[]}`, status: http.StatusBadRequest},
		{name: "runtime null", body: `{"next_connection":{"runtime_type":null}}`, status: http.StatusBadRequest},
		{name: "runtime wrong type", body: `{"next_connection":{"runtime_type":1}}`, status: http.StatusBadRequest},
		{name: "invalid runtime", body: `{"next_connection":{"runtime_type":"container"}}`, status: http.StatusBadRequest},
		{name: "ssh missing profile", body: `{"next_connection":{"runtime_type":"ssh"}}`, status: http.StatusBadRequest},
		{name: "ssh null profile", body: `{"next_connection":{"runtime_type":"ssh","ssh_profile_id":null}}`, status: http.StatusBadRequest},
		{name: "profile wrong type", body: `{"next_connection":{"runtime_type":"ssh","ssh_profile_id":1}}`, status: http.StatusBadRequest},
		{name: "cwd null", body: `{"next_connection":{"runtime_type":"local","cwd":null}}`, status: http.StatusBadRequest},
		{name: "cwd wrong type", body: `{"next_connection":{"runtime_type":"local","cwd":1}}`, status: http.StatusBadRequest},
		{name: "missing profile", body: `{"next_connection":{"runtime_type":"ssh","ssh_profile_id":"missing"}}`, status: http.StatusNotFound, code: "ssh_profile_not_found"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response := doBlockTermViewRequest(router, http.MethodPatch, path, test.body)
			require.Equal(t, test.status, response.Code, response.Body.String())
			if test.code != "" {
				var errorBody struct {
					Code string `json:"code"`
				}
				require.NoError(t, json.Unmarshal(response.Body.Bytes(), &errorBody))
				require.Equal(t, test.code, errorBody.Code)
			}

			response = doBlockTermViewRequest(router, http.MethodGet, path, "")
			require.Equal(t, http.StatusOK, response.Code, response.Body.String())
			var actual blockTermViewResponse
			require.NoError(t, json.Unmarshal(response.Body.Bytes(), &actual))
			require.Equal(t, expected.View, actual.View)
		})
	}
}

func TestTerminalHandlerBlockTermViewValidation(t *testing.T) {
	handler, router := setupBlockTermViewHandler(t)
	for _, terminalID := range []string{"terminal-view-a", "terminal-view-b"} {
		require.NoError(t, handler.manager.DB().Create(&model.TerminalSession{
			ID:     terminalID,
			Name:   terminalID,
			Status: model.StatusClosed,
		}).Error)
	}
	require.NoError(t, handler.manager.DB().Create([]model.BlockTermBlock{
		{ID: "block-view-b", TerminalID: "terminal-view-b", LineNum: 0},
		{ID: "block-view-archived", TerminalID: "terminal-view-a", LineNum: 0, Archived: true},
	}).Error)

	tests := []struct {
		name   string
		path   string
		body   string
		status int
	}{
		{name: "missing terminal", path: "/api/blockterm/sessions/missing/view", body: `{}`, status: http.StatusNotFound},
		{name: "cross terminal", path: "/api/blockterm/sessions/terminal-view-a/view", body: `{"sidebar":{"block_id":"block-view-b"}}`, status: http.StatusBadRequest},
		{name: "archived owner", path: "/api/blockterm/sessions/terminal-view-a/view", body: `{"sidebar":{"block_id":"block-view-archived"}}`, status: http.StatusBadRequest},
		{name: "missing owner", path: "/api/blockterm/sessions/terminal-view-a/view", body: `{"sidebar":{"block_id":"missing"}}`, status: http.StatusNotFound},
		{name: "invalid percent", path: "/api/blockterm/sessions/terminal-view-a/view", body: `{"sidebar":{"width":"91%"}}`, status: http.StatusBadRequest},
		{name: "invalid pixel", path: "/api/blockterm/sessions/terminal-view-a/view", body: `{"sidebar":{"width":"199px"}}`, status: http.StatusBadRequest},
		{name: "unknown nested", path: "/api/blockterm/sessions/terminal-view-a/view", body: `{"sidebar":{"extra":true}}`, status: http.StatusBadRequest},
		{name: "unknown root", path: "/api/blockterm/sessions/terminal-view-a/view", body: `{"other":true}`, status: http.StatusBadRequest},
		{name: "null open", path: "/api/blockterm/sessions/terminal-view-a/view", body: `{"sidebar":{"open":null}}`, status: http.StatusBadRequest},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response := doBlockTermViewRequest(router, http.MethodPatch, test.path, test.body)
			require.Equal(t, test.status, response.Code, response.Body.String())
		})
	}

	oversized := bytes.Repeat([]byte("x"), blockTermViewMaxBodyBytes+1)
	response := doBlockTermViewRequest(
		router,
		http.MethodPatch,
		"/api/blockterm/sessions/terminal-view-a/view",
		string(oversized),
	)
	require.Equal(t, http.StatusRequestEntityTooLarge, response.Code, response.Body.String())
}

func TestBlockTermMutationsClearTerminalSidebarOwner(t *testing.T) {
	env := setupBlockTermHandler(t)
	seedBlockTermTerminal(t, env.db, "terminal-view-mutations")
	seedBlockTermTerminal(t, env.db, "terminal-view-move-target")
	require.NoError(t, env.db.Create([]model.BlockTermBlock{
		{ID: "block-view-archive", TerminalID: "terminal-view-mutations", LineNum: 0},
		{ID: "block-view-delete", TerminalID: "terminal-view-mutations", LineNum: 1},
		{ID: "block-view-move", TerminalID: "terminal-view-mutations", LineNum: 2},
	}).Error)

	setOwner := func(blockID string) {
		t.Helper()
		open := true
		width := terminal.BlockTermSidebarFixedWidth
		state, err := env.manager.PatchBlockTermView("terminal-view-mutations", terminal.BlockTermSidebarPatch{
			Open:       &open,
			Width:      &width,
			BlockIDSet: true,
			BlockID:    &blockID,
		})
		require.NoError(t, err)
		require.True(t, state.Sidebar.Open)
		require.Equal(t, blockID, *state.Sidebar.BlockID)
	}
	assertCleared := func() {
		t.Helper()
		state, err := env.manager.GetBlockTermView("terminal-view-mutations")
		require.NoError(t, err)
		require.False(t, state.Sidebar.Open)
		require.Equal(t, terminal.BlockTermSidebarFixedWidth, state.Sidebar.Width)
		require.Nil(t, state.Sidebar.BlockID)
	}

	setOwner("block-view-archive")
	response := doBlockTermJSON(
		t,
		env.router,
		http.MethodPatch,
		"/api/blockterm/blocks/block-view-archive",
		map[string]any{"archived": true},
	)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	assertCleared()

	setOwner("block-view-delete")
	response = doBlockTermJSON(
		t,
		env.router,
		http.MethodDelete,
		"/api/blockterm/blocks/block-view-delete",
		nil,
	)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	assertCleared()

	setOwner("block-view-move")
	response = doBlockTermJSON(
		t,
		env.router,
		http.MethodPatch,
		"/api/blockterm/blocks/block-view-move",
		map[string]any{"terminal_id": "terminal-view-move-target", "line_num": 0},
	)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	assertCleared()
}

func TestBlockTermMutationsDoNotClearUnrelatedTerminalSidebarOwner(t *testing.T) {
	env := setupBlockTermHandler(t)
	seedBlockTermTerminal(t, env.db, "terminal-view-unrelated")
	seedBlockTermTerminal(t, env.db, "terminal-view-unrelated-target")
	require.NoError(t, env.db.Create([]model.BlockTermBlock{
		{ID: "block-view-owner", TerminalID: "terminal-view-unrelated", LineNum: 0},
		{ID: "block-view-other-archive", TerminalID: "terminal-view-unrelated", LineNum: 1},
		{ID: "block-view-other-delete", TerminalID: "terminal-view-unrelated", LineNum: 2, Kind: "note"},
		{ID: "block-view-other-move", TerminalID: "terminal-view-unrelated", LineNum: 3},
	}).Error)

	open := true
	width := terminal.BlockTermSidebarFixedWidth
	ownerID := "block-view-owner"
	_, err := env.manager.PatchBlockTermView("terminal-view-unrelated", terminal.BlockTermSidebarPatch{
		Open:       &open,
		Width:      &width,
		BlockIDSet: true,
		BlockID:    &ownerID,
	})
	require.NoError(t, err)

	assertOwner := func() {
		t.Helper()
		state, err := env.manager.GetBlockTermView("terminal-view-unrelated")
		require.NoError(t, err)
		require.True(t, state.Sidebar.Open)
		require.Equal(t, terminal.BlockTermSidebarFixedWidth, state.Sidebar.Width)
		require.Equal(t, ownerID, *state.Sidebar.BlockID)
	}

	response := doBlockTermJSON(
		t,
		env.router,
		http.MethodPatch,
		"/api/blockterm/blocks/block-view-other-archive",
		map[string]any{"archived": true},
	)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	assertOwner()

	response = doBlockTermJSON(
		t,
		env.router,
		http.MethodDelete,
		"/api/blockterm/blocks/block-view-other-delete",
		nil,
	)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	assertOwner()

	response = doBlockTermJSON(
		t,
		env.router,
		http.MethodPatch,
		"/api/blockterm/blocks/block-view-other-move",
		map[string]any{"terminal_id": "terminal-view-unrelated-target", "line_num": 0},
	)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	assertOwner()
}

func TestBlockTermMoveClearsStaleTargetTerminalSidebarOwner(t *testing.T) {
	env := setupBlockTermHandler(t)
	seedBlockTermTerminal(t, env.db, "terminal-view-stale-source")
	seedBlockTermTerminal(t, env.db, "terminal-view-stale-target")
	require.NoError(t, env.db.Create(&model.BlockTermBlock{
		ID:         "block-view-stale-move",
		TerminalID: "terminal-view-stale-source",
		LineNum:    0,
	}).Error)

	open := true
	width := terminal.BlockTermSidebarFixedWidth
	blockID := "block-view-stale-move"
	_, err := env.manager.PatchBlockTermView("terminal-view-stale-source", terminal.BlockTermSidebarPatch{
		Open:       &open,
		Width:      &width,
		BlockIDSet: true,
		BlockID:    &blockID,
	})
	require.NoError(t, err)
	require.NoError(t, env.db.Model(&model.TerminalSession{}).
		Where("id = ?", "terminal-view-stale-target").
		Update("blockterm_view_json", `{"sidebar":{"open":true,"width":"500px","block_id":"block-view-stale-move"}}`).Error)

	response := doBlockTermJSON(
		t,
		env.router,
		http.MethodPatch,
		"/api/blockterm/blocks/block-view-stale-move",
		map[string]any{"terminal_id": "terminal-view-stale-target", "line_num": 0},
	)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())

	for _, terminalID := range []string{"terminal-view-stale-source", "terminal-view-stale-target"} {
		state, err := env.manager.GetBlockTermView(terminalID)
		require.NoError(t, err)
		require.False(t, state.Sidebar.Open, terminalID)
		require.Equal(t, terminal.BlockTermSidebarFixedWidth, state.Sidebar.Width, terminalID)
		require.Nil(t, state.Sidebar.BlockID, terminalID)
	}
}

func TestBlockTermSidebarCleanupFailureRollsBackMutation(t *testing.T) {
	tests := []struct {
		name   string
		method string
		body   map[string]any
	}{
		{name: "archive", method: http.MethodPatch, body: map[string]any{"archived": true}},
		{name: "delete", method: http.MethodDelete},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			env := setupBlockTermHandler(t)
			terminalID := "terminal-view-rollback-" + test.name
			blockID := "block-view-rollback-" + test.name
			seedBlockTermTerminal(t, env.db, terminalID)
			require.NoError(t, env.db.Create(&model.BlockTermBlock{
				ID:         blockID,
				TerminalID: terminalID,
				LineNum:    0,
				Kind:       "note",
			}).Error)

			open := true
			width := terminal.BlockTermSidebarFixedWidth
			_, err := env.manager.PatchBlockTermView(terminalID, terminal.BlockTermSidebarPatch{
				Open:       &open,
				Width:      &width,
				BlockIDSet: true,
				BlockID:    &blockID,
			})
			require.NoError(t, err)

			forcedErr := errors.New("forced sidebar cleanup failure")
			callbackName := "test:blockterm_sidebar_cleanup_failure_" + test.name
			require.NoError(t, env.db.Callback().Update().Before("gorm:update").Register(callbackName, func(tx *gorm.DB) {
				if tx.Statement.Schema != nil && tx.Statement.Schema.Table == (model.TerminalSession{}).TableName() {
					tx.AddError(forcedErr)
				}
			}))
			callbackRegistered := true
			t.Cleanup(func() {
				if callbackRegistered {
					_ = env.db.Callback().Update().Remove(callbackName)
				}
			})

			response := doBlockTermJSON(
				t,
				env.router,
				test.method,
				"/api/blockterm/blocks/"+blockID,
				test.body,
			)
			require.Equal(t, http.StatusInternalServerError, response.Code, response.Body.String())
			require.Contains(t, response.Body.String(), forcedErr.Error())
			require.NoError(t, env.db.Callback().Update().Remove(callbackName))
			callbackRegistered = false

			var block model.BlockTermBlock
			require.NoError(t, env.db.First(&block, "id = ?", blockID).Error)
			require.False(t, block.Archived)

			state, err := env.manager.GetBlockTermView(terminalID)
			require.NoError(t, err)
			require.True(t, state.Sidebar.Open)
			require.Equal(t, terminal.BlockTermSidebarFixedWidth, state.Sidebar.Width)
			require.Equal(t, blockID, *state.Sidebar.BlockID)
		})
	}
}
