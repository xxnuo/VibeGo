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
	"github.com/xxnuo/vibego/internal/service/kv"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func setupTestSettingsHandler(t *testing.T) (*SettingsHandler, *gin.Engine) {
	gin.SetMode(gin.TestMode)
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Silent),
	})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&kv.KV{}))
	store, err := kv.New(db)
	require.NoError(t, err)
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
	assert.Empty(t, result)
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
	assert.Empty(t, result)
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
	assert.Len(t, result, 2)
	assert.Equal(t, "1", result["a"])
	assert.Equal(t, "2", result["b"])
}
