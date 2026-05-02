package handler

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/xxnuo/vibego/internal/model"
	"github.com/xxnuo/vibego/internal/service/blocktermmodel"
	"github.com/xxnuo/vibego/internal/service/settings"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func setupTestSettingsHandler(t *testing.T) (*SettingsHandler, *gin.Engine) {
	gin.SetMode(gin.TestMode)
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Silent),
	})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&model.UserSetting{}))
	store := settings.New(db)
	h := &SettingsHandler{store: store}
	r := gin.New()
	g := r.Group("/api")
	h.Register(g)
	return h, r
}

func TestSettingsList(t *testing.T) {
	_, r := setupTestSettingsHandler(t)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/api/settings/list", nil)
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	var result map[string]string
	json.Unmarshal(w.Body.Bytes(), &result)
	assert.NotEmpty(t, result["gitUserName"])
	assert.NotEmpty(t, result["gitUserEmail"])
}

func TestSettingsSetAndGet(t *testing.T) {
	_, r := setupTestSettingsHandler(t)

	body := `{"key":"theme","value":"dark"}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/settings/set", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)

	w = httptest.NewRecorder()
	req, _ = http.NewRequest("GET", "/api/settings/get?key=theme", nil)
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	var result map[string]string
	json.Unmarshal(w.Body.Bytes(), &result)
	assert.Equal(t, "theme", result["key"])
	assert.Equal(t, "dark", result["value"])
}

func TestSettingsGetNotFound(t *testing.T) {
	_, r := setupTestSettingsHandler(t)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/api/settings/get?key=nonexistent", nil)
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusNotFound, w.Code)
}

func TestSettingsGetGitDefault(t *testing.T) {
	_, r := setupTestSettingsHandler(t)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/api/settings/get?key=gitUserName", nil)
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	var result map[string]string
	json.Unmarshal(w.Body.Bytes(), &result)
	assert.Equal(t, "gitUserName", result["key"])
	assert.NotEmpty(t, result["value"])
}

func TestSettingsGetMissingKey(t *testing.T) {
	_, r := setupTestSettingsHandler(t)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/api/settings/get", nil)
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestSettingsSetInvalidBody(t *testing.T) {
	_, r := setupTestSettingsHandler(t)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/settings/set", bytes.NewBufferString(`{}`))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestSettingsReset(t *testing.T) {
	_, r := setupTestSettingsHandler(t)

	body := `{"key":"theme","value":"dark"}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/settings/set", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	w = httptest.NewRecorder()
	req, _ = http.NewRequest("POST", "/api/settings/reset", nil)
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)

	w = httptest.NewRecorder()
	req, _ = http.NewRequest("GET", "/api/settings/list", nil)
	r.ServeHTTP(w, req)

	var result map[string]string
	json.Unmarshal(w.Body.Bytes(), &result)
	assert.NotEmpty(t, result["gitUserName"])
	assert.NotEmpty(t, result["gitUserEmail"])
}

func TestSettingsResetPreservesGitHubToken(t *testing.T) {
	h, r := setupTestSettingsHandler(t)
	require.NoError(t, h.store.Set("github.access_token", "server-secret"))
	require.NoError(t, h.store.Set("theme", "dark"))

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/settings/reset", nil)
	r.ServeHTTP(w, req)
	assert.Equal(t, http.StatusOK, w.Code)

	value, err := h.store.Get("github.access_token")
	require.NoError(t, err)
	assert.Equal(t, "server-secret", value)
	_, err = h.store.Get("theme")
	assert.Error(t, err)
}

func TestSettingsProtectsBlockTermModelConfiguration(t *testing.T) {
	h, r := setupTestSettingsHandler(t)
	require.NoError(t, h.store.Set(blocktermmodel.SettingAPIToken, "model-secret"))
	require.NoError(t, h.store.Set(blocktermmodel.SettingBaseURL, "https://example.com/v1"))
	require.NoError(t, h.store.Set("theme", "dark"))

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/settings/list", nil))
	require.Equal(t, http.StatusOK, w.Code)
	require.NotContains(t, w.Body.String(), "model-secret")
	require.NotContains(t, w.Body.String(), blocktermmodel.SettingAPIToken)
	require.NotContains(t, w.Body.String(), blocktermmodel.SettingBaseURL)

	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/settings/get?key="+blocktermmodel.SettingAPIToken, nil))
	require.Equal(t, http.StatusNotFound, w.Code)

	w = httptest.NewRecorder()
	setRequest := httptest.NewRequest(http.MethodPost, "/api/settings/set", bytes.NewBufferString(
		`{"key":"`+blocktermmodel.SettingAPIToken+`","value":"replacement"}`,
	))
	setRequest.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, setRequest)
	require.Equal(t, http.StatusForbidden, w.Code)

	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodDelete, "/api/settings/"+blocktermmodel.SettingAPIToken, nil))
	require.Equal(t, http.StatusForbidden, w.Code)

	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/api/settings/reset", nil))
	require.Equal(t, http.StatusOK, w.Code)
	value, err := h.store.Get(blocktermmodel.SettingAPIToken)
	require.NoError(t, err)
	require.Equal(t, "model-secret", value)
	_, err = h.store.Get("theme")
	require.Error(t, err)
}

func TestSettingsDelete(t *testing.T) {
	_, r := setupTestSettingsHandler(t)

	body := `{"key":"theme","value":"dark"}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/settings/set", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	w = httptest.NewRecorder()
	req, _ = http.NewRequest("DELETE", "/api/settings/theme", nil)
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)

	w = httptest.NewRecorder()
	req, _ = http.NewRequest("GET", "/api/settings/get?key=theme", nil)
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusNotFound, w.Code)
}

func TestSettingsListWithData(t *testing.T) {
	_, r := setupTestSettingsHandler(t)

	body := `{"key":"a","value":"1"}`
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/settings/set", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	body = `{"key":"b","value":"2"}`
	w = httptest.NewRecorder()
	req, _ = http.NewRequest("POST", "/api/settings/set", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	w = httptest.NewRecorder()
	req, _ = http.NewRequest("GET", "/api/settings/list", nil)
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	var result map[string]string
	json.Unmarshal(w.Body.Bytes(), &result)
	assert.Len(t, result, 4)
	assert.Equal(t, "1", result["a"])
	assert.Equal(t, "2", result["b"])
	assert.NotEmpty(t, result["gitUserName"])
	assert.NotEmpty(t, result["gitUserEmail"])
}
