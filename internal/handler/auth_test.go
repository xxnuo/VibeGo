package handler

import (
	"errors"
	"path/filepath"
	"testing"

	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/require"
	"github.com/xxnuo/vibego/internal/model"
	"gorm.io/gorm"
)

func TestAuthCreateSessionPropagatesInsertFailure(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "auth.sqlite")), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&model.UserSession{}))

	forcedErr := errors.New("forced session insert failure")
	const callbackName = "test:auth_session_create_failure"
	require.NoError(t, db.Callback().Create().Before("gorm:create").Register(callbackName, func(tx *gorm.DB) {
		if tx.Statement.Schema != nil && tx.Statement.Schema.Table == (model.UserSession{}).TableName() {
			tx.AddError(forcedErr)
		}
	}))
	t.Cleanup(func() { _ = db.Callback().Create().Remove(callbackName) })

	handler := NewAuthHandler(db, "", false)
	session, err := handler.createSession("user-1", "")
	require.ErrorIs(t, err, forcedErr)
	require.Nil(t, session)

	var count int64
	require.NoError(t, db.Model(&model.UserSession{}).Count(&count).Error)
	require.Zero(t, count)
}
