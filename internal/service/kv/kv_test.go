package kv

import (
	"testing"

	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/xxnuo/vibego/internal/model"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func setupTestDB(t *testing.T) *gorm.DB {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Silent),
	})
	require.NoError(t, err)
	if err := db.AutoMigrate(&model.KV{}); err != nil {
		t.Fatalf("failed to migrate: %v", err)
	}
	return db
}

func TestNew(t *testing.T) {
	db := setupTestDB(t)
	store := New(db)
	assert.NotNil(t, store)
}

func TestSetAndGet(t *testing.T) {
	db := setupTestDB(t)
	store := New(db)

	err := store.Set("key1", "value1")
	require.NoError(t, err)

	val, err := store.Get("key1")
	require.NoError(t, err)
	assert.Equal(t, "value1", val)
}

func TestGetNotFound(t *testing.T) {
	db := setupTestDB(t)
	store := New(db)

	_, err := store.Get("nonexistent")
	assert.Error(t, err)
}

func TestSetOverwrite(t *testing.T) {
	db := setupTestDB(t)
	store := New(db)

	store.Set("key1", "value1")
	store.Set("key1", "value2")

	val, err := store.Get("key1")
	require.NoError(t, err)
	assert.Equal(t, "value2", val)
}

func TestDelete(t *testing.T) {
	db := setupTestDB(t)
	store := New(db)

	store.Set("key1", "value1")
	err := store.Delete("key1")
	require.NoError(t, err)

	assert.False(t, store.Exists("key1"))
}

func TestExists(t *testing.T) {
	db := setupTestDB(t)
	store := New(db)

	assert.False(t, store.Exists("key1"))

	store.Set("key1", "value1")
	assert.True(t, store.Exists("key1"))
}

func TestKeys(t *testing.T) {
	db := setupTestDB(t)
	store := New(db)

	store.Set("a", "1")
	store.Set("b", "2")
	store.Set("c", "3")

	keys, err := store.Keys()
	require.NoError(t, err)
	assert.Len(t, keys, 3)
	assert.ElementsMatch(t, []string{"a", "b", "c"}, keys)
}

func TestAll(t *testing.T) {
	db := setupTestDB(t)
	store := New(db)

	store.Set("a", "1")
	store.Set("b", "2")

	all, err := store.All()
	require.NoError(t, err)
	assert.Len(t, all, 2)
	assert.Equal(t, "1", all["a"])
	assert.Equal(t, "2", all["b"])
}

func TestClear(t *testing.T) {
	db := setupTestDB(t)
	store := New(db)

	store.Set("a", "1")
	store.Set("b", "2")

	err := store.Clear()
	require.NoError(t, err)

	keys, _ := store.Keys()
	assert.Len(t, keys, 0)
}

type TestUser struct {
	Name string `json:"name"`
	Age  int    `json:"age"`
}

func TestSetJSONAndGetJSON(t *testing.T) {
	db := setupTestDB(t)
	store := New(db)

	user := TestUser{Name: "Alice", Age: 30}
	err := store.SetJSON("user1", user)
	require.NoError(t, err)

	var result TestUser
	err = store.GetJSON("user1", &result)
	require.NoError(t, err)
	assert.Equal(t, "Alice", result.Name)
	assert.Equal(t, 30, result.Age)
}

func TestSetJSONOverwrite(t *testing.T) {
	db := setupTestDB(t)
	store := New(db)

	store.SetJSON("user", TestUser{Name: "Bob", Age: 25})
	store.SetJSON("user", TestUser{Name: "Charlie", Age: 35})

	var result TestUser
	store.GetJSON("user", &result)
	assert.Equal(t, "Charlie", result.Name)
	assert.Equal(t, 35, result.Age)
}

func TestGetJSONNotFound(t *testing.T) {
	db := setupTestDB(t)
	store := New(db)

	var result TestUser
	err := store.GetJSON("nonexistent", &result)
	assert.Error(t, err)
}

func TestSetJSONSlice(t *testing.T) {
	db := setupTestDB(t)
	store := New(db)

	users := []TestUser{
		{Name: "A", Age: 1},
		{Name: "B", Age: 2},
	}
	err := store.SetJSON("users", users)
	require.NoError(t, err)

	var result []TestUser
	err = store.GetJSON("users", &result)
	require.NoError(t, err)
	assert.Len(t, result, 2)
	assert.Equal(t, "A", result[0].Name)
	assert.Equal(t, "B", result[1].Name)
}

func TestSetJSONInvalidValue(t *testing.T) {
	db := setupTestDB(t)
	store := New(db)

	ch := make(chan int)
	err := store.SetJSON("invalid", ch)
	assert.Error(t, err)
}

func TestKeysEmpty(t *testing.T) {
	db := setupTestDB(t)
	store := New(db)

	keys, err := store.Keys()
	require.NoError(t, err)
	assert.Len(t, keys, 0)
}

func TestAllEmpty(t *testing.T) {
	db := setupTestDB(t)
	store := New(db)

	all, err := store.All()
	require.NoError(t, err)
	assert.Len(t, all, 0)
}
