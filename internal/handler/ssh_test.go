package handler

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/require"
	"github.com/xxnuo/vibego/internal/model"
	"github.com/xxnuo/vibego/internal/service/sshconnection"
	"github.com/xxnuo/vibego/internal/service/terminal"
	"gorm.io/gorm"
)

func setupSSHHandlerTest(t *testing.T) (*gorm.DB, *sshconnection.Service, *terminal.Manager, *gin.Engine) {
	t.Helper()
	db, err := gorm.Open(sqlite.Open("file:"+t.Name()+"?mode=memory&cache=shared"), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(
		&model.UserSession{},
		&model.TerminalSession{},
		&model.TerminalHistory{},
		&model.BlockTermBlock{},
		&model.BlockTermCommandHistory{},
		&model.SSHConnectionProfile{},
		&model.SSHKnownHost{},
	))
	service := sshconnection.New(db)
	t.Cleanup(service.Close)
	manager := terminal.NewManager(db, &terminal.ManagerConfig{Shell: "/bin/sh", RuntimeFactory: service})
	router := gin.New()
	api := router.Group("/api")
	NewSSHHandler(service).Register(api)
	NewTerminalHandler(manager).Register(api)
	return db, service, manager, router
}

func doSSHHandlerJSON(t *testing.T, router http.Handler, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var reader *bytes.Reader
	if body == nil {
		reader = bytes.NewReader(nil)
	} else {
		encoded, err := json.Marshal(body)
		require.NoError(t, err)
		reader = bytes.NewReader(encoded)
	}
	request := httptest.NewRequest(method, path, reader)
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	return response
}

func TestSSHProfileCRUDDoesNotPersistOrReturnSecrets(t *testing.T) {
	db, _, _, router := setupSSHHandlerTest(t)
	secret := "must-not-be-persisted"
	created := doSSHHandlerJSON(t, router, http.MethodPost, "/api/ssh/profiles", map[string]any{
		"name":            "dev host",
		"host":            "LOCALHOST",
		"port":            2222,
		"user":            "developer",
		"auth_method":     "password",
		"connect_timeout": 12,
		"password":        secret,
		"passphrase":      secret,
		"private_key":     secret,
	})
	require.Equal(t, http.StatusCreated, created.Code, created.Body.String())
	require.NotContains(t, created.Body.String(), secret)

	var body struct {
		Profile sshProfileResponse `json:"profile"`
	}
	require.NoError(t, json.Unmarshal(created.Body.Bytes(), &body))
	require.NotEmpty(t, body.Profile.ID)
	require.Equal(t, "localhost", body.Profile.Host)
	require.False(t, body.Profile.Connected)

	type tableColumn struct {
		Name string `gorm:"column:name"`
	}
	var columns []tableColumn
	require.NoError(t, db.Raw("PRAGMA table_info(ssh_connection_profiles)").Scan(&columns).Error)
	columnNames := make([]string, 0, len(columns))
	for _, column := range columns {
		columnNames = append(columnNames, column.Name)
	}
	for _, forbidden := range []string{"password", "passphrase", "private_key"} {
		require.NotContains(t, columnNames, forbidden)
	}

	listed := doSSHHandlerJSON(t, router, http.MethodGet, "/api/ssh/profiles", nil)
	require.Equal(t, http.StatusOK, listed.Code)
	require.NotContains(t, listed.Body.String(), secret)
	require.Contains(t, listed.Body.String(), body.Profile.ID)

	updated := doSSHHandlerJSON(t, router, http.MethodPatch, "/api/ssh/profiles/"+body.Profile.ID, map[string]any{
		"name": "renamed host",
	})
	require.Equal(t, http.StatusOK, updated.Code, updated.Body.String())
	require.Contains(t, updated.Body.String(), "renamed host")

	deleted := doSSHHandlerJSON(t, router, http.MethodDelete, "/api/ssh/profiles/"+body.Profile.ID, nil)
	require.Equal(t, http.StatusOK, deleted.Code)
	missing := doSSHHandlerJSON(t, router, http.MethodGet, "/api/ssh/profiles", nil)
	require.Equal(t, http.StatusOK, missing.Code)
	require.NotContains(t, missing.Body.String(), body.Profile.ID)
}

func TestSSHErrorsUseExplicitChallengeAndRuntimeCodes(t *testing.T) {
	_, _, _, router := setupSSHHandlerTest(t)
	secret := "request-only-password"

	connect := doSSHHandlerJSON(t, router, http.MethodPost, "/api/ssh/profiles/missing/connect", map[string]any{
		"auth": map[string]any{"password": secret},
	})
	require.Equal(t, http.StatusNotFound, connect.Code)
	require.Contains(t, connect.Body.String(), "ssh_profile_not_found")
	require.NotContains(t, connect.Body.String(), secret)

	createTerminal := doSSHHandlerJSON(t, router, http.MethodPost, "/api/terminal", map[string]any{
		"name":           "remote",
		"runtime_type":   "ssh",
		"ssh_profile_id": "missing",
		"ssh_auth":       map[string]any{"password": secret},
	})
	require.Equal(t, http.StatusNotFound, createTerminal.Code, createTerminal.Body.String())
	require.Contains(t, createTerminal.Body.String(), "ssh_profile_not_found")
	require.NotContains(t, createTerminal.Body.String(), secret)

	challenge := sshconnection.HostKeyChallenge{
		ID:          "challenge-1",
		ProfileID:   "profile-1",
		Endpoint:    "example.com:22",
		KeyType:     "ssh-ed25519",
		Fingerprint: "SHA256:test",
		ExpiresAt:   123,
	}
	response := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(response)
	require.True(t, writeSSHError(context, &sshconnection.HostKeyChallengeError{Challenge: challenge}))
	require.Equal(t, http.StatusConflict, response.Code)
	require.Contains(t, response.Body.String(), "host_key_confirmation_required")
	require.Contains(t, response.Body.String(), challenge.Fingerprint)

	invalidChallenge := doSSHHandlerJSON(t, router, http.MethodPost, "/api/ssh/host-key-challenges/missing/confirm", map[string]any{})
	require.Equal(t, http.StatusNotFound, invalidChallenge.Code)
	require.True(t, strings.Contains(invalidChallenge.Body.String(), "host_key_challenge_not_found"))
}

func TestSSHConnectAcceptsEmptyBodyWithUnknownLength(t *testing.T) {
	_, _, _, router := setupSSHHandlerTest(t)
	request := httptest.NewRequest(
		http.MethodPost,
		"/api/ssh/profiles/missing/connect",
		io.NopCloser(strings.NewReader("")),
	)
	request.ContentLength = -1
	request.TransferEncoding = []string{"chunked"}
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()

	router.ServeHTTP(response, request)

	require.Equal(t, http.StatusNotFound, response.Code, response.Body.String())
	require.Contains(t, response.Body.String(), "ssh_profile_not_found")
}

func TestSSHSecretRequestBodyLimit(t *testing.T) {
	_, _, _, router := setupSSHHandlerTest(t)
	oversizedSecret := strings.Repeat("x", sshSecretRequestMaxBody+1)

	for _, testCase := range []struct {
		name string
		path string
		body string
	}{
		{
			name: "connect",
			path: "/api/ssh/profiles/missing/connect",
			body: `{"auth":{"password":"` + oversizedSecret + `"}}`,
		},
		{
			name: "terminal",
			path: "/api/terminal",
			body: `{"runtime_type":"ssh","ssh_profile_id":"missing","ssh_auth":{"private_key":"` + oversizedSecret + `"}}`,
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, testCase.path, strings.NewReader(testCase.body))
			request.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			require.Equal(t, http.StatusRequestEntityTooLarge, response.Code, response.Body.String())
			require.Contains(t, response.Body.String(), "request body is too large")
		})
	}
}

func TestResetKnownHostRequiresExactCurrentFingerprint(t *testing.T) {
	db, service, _, router := setupSSHHandlerTest(t)
	profile, err := service.CreateProfile(sshconnection.ProfileInput{
		Name:       "known host",
		Host:       "example.com",
		Port:       22,
		User:       "tester",
		AuthMethod: sshconnection.AuthMethodAgent,
	})
	require.NoError(t, err)
	const fingerprint = "SHA256:current"
	require.NoError(t, db.Create(&model.SSHKnownHost{
		Endpoint:    "example.com:22",
		Host:        "example.com",
		Port:        22,
		KeyType:     "ssh-ed25519",
		PublicKey:   "AQ==",
		Fingerprint: fingerprint,
		CreatedAt:   1,
		UpdatedAt:   1,
	}).Error)

	mismatch := doSSHHandlerJSON(t, router, http.MethodDelete, "/api/ssh/profiles/"+profile.ID+"/known-host", map[string]any{
		"expected_fingerprint": "SHA256:stale",
	})
	require.Equal(t, http.StatusConflict, mismatch.Code, mismatch.Body.String())
	require.Contains(t, mismatch.Body.String(), "known_host_fingerprint_mismatch")

	reset := doSSHHandlerJSON(t, router, http.MethodDelete, "/api/ssh/profiles/"+profile.ID+"/known-host", map[string]any{
		"expected_fingerprint": fingerprint,
	})
	require.Equal(t, http.StatusOK, reset.Code, reset.Body.String())
	require.Contains(t, reset.Body.String(), fingerprint)

	missing := doSSHHandlerJSON(t, router, http.MethodDelete, "/api/ssh/profiles/"+profile.ID+"/known-host", map[string]any{
		"expected_fingerprint": fingerprint,
	})
	require.Equal(t, http.StatusNotFound, missing.Code, missing.Body.String())
	require.Contains(t, missing.Body.String(), "ssh_known_host_not_found")
}
