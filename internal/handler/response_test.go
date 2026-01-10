package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
)

func TestOK(t *testing.T) {
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)

	OK(c, map[string]string{"key": "value"})

	assert.Equal(t, http.StatusOK, w.Code)
	var resp Response
	json.Unmarshal(w.Body.Bytes(), &resp)
	assert.True(t, resp.Success)
}

func TestCreated(t *testing.T) {
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)

	Created(c, map[string]string{"id": "123"})

	assert.Equal(t, http.StatusCreated, w.Code)
	var resp Response
	json.Unmarshal(w.Body.Bytes(), &resp)
	assert.True(t, resp.Success)
}

func TestBadRequest(t *testing.T) {
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)

	BadRequest(c, "invalid input")

	assert.Equal(t, http.StatusBadRequest, w.Code)
	var resp Response
	json.Unmarshal(w.Body.Bytes(), &resp)
	assert.False(t, resp.Success)
	assert.Equal(t, "invalid input", resp.Error)
}

func TestNotFound(t *testing.T) {
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)

	NotFound(c, "resource not found")

	assert.Equal(t, http.StatusNotFound, w.Code)
	var resp Response
	json.Unmarshal(w.Body.Bytes(), &resp)
	assert.False(t, resp.Success)
}

func TestConflict(t *testing.T) {
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)

	Conflict(c, "already exists")

	assert.Equal(t, http.StatusConflict, w.Code)
}

func TestServerError(t *testing.T) {
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)

	ServerError(c, "internal error")

	assert.Equal(t, http.StatusInternalServerError, w.Code)
}

func TestUnauthorized(t *testing.T) {
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)

	Unauthorized(c, "not authorized")

	assert.Equal(t, http.StatusUnauthorized, w.Code)
}

func TestTooManyRequests(t *testing.T) {
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)

	TooManyRequests(c, "rate limited")

	assert.Equal(t, http.StatusTooManyRequests, w.Code)
}

func TestOKPaginated(t *testing.T) {
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)

	OKPaginated(c, []string{"a", "b"}, 1, 10, 100)

	assert.Equal(t, http.StatusOK, w.Code)
	var resp PaginatedResponse
	json.Unmarshal(w.Body.Bytes(), &resp)
	assert.True(t, resp.Success)
	assert.Equal(t, 1, resp.Pagination.Page)
	assert.Equal(t, 10, resp.Pagination.PageSize)
	assert.Equal(t, int64(100), resp.Pagination.Total)
}
