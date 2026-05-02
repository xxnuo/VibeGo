package blocktermmodel

import (
	"testing"

	"github.com/glebarez/sqlite"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"github.com/xxnuo/vibego/internal/model"
	"github.com/xxnuo/vibego/internal/service/settings"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func newConfigBoundaryTestService(t *testing.T) (*Service, *settings.Store) {
	t.Helper()
	db, err := gorm.Open(sqlite.Open("file:"+uuid.NewString()+"?mode=memory&cache=shared"), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Silent),
	})
	require.NoError(t, err)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	sqlDB.SetMaxOpenConns(1)
	require.NoError(t, db.AutoMigrate(&model.UserSetting{}))
	service := New(db)
	t.Cleanup(func() {
		service.Close()
		require.NoError(t, sqlDB.Close())
	})
	return service, settings.New(db)
}

func TestSetConfigTokenOnlyMigratesLegacyAliasesWithoutDNS(t *testing.T) {
	service, store := newConfigBoundaryTestService(t)
	require.NoError(t, store.Set(SettingBaseURL, "https://provider.invalid/v1"))
	for _, key := range tokenSettingKeys()[1:] {
		require.NoError(t, store.Set(key, "legacy-token"))
	}

	newToken := "replacement-token"
	cfg, err := service.SetConfig(ConfigPatch{APIToken: &newToken})
	require.NoError(t, err)
	require.Equal(t, "https://provider.invalid/v1", cfg.BaseURL)
	require.Equal(t, newToken, cfg.APIToken)

	persisted, err := store.Get(SettingAPIToken)
	require.NoError(t, err)
	require.Equal(t, newToken, persisted)
	for _, key := range tokenSettingKeys()[1:] {
		_, err := store.Get(key)
		require.ErrorIs(t, err, gorm.ErrRecordNotFound)
	}
}

func TestSetConfigClearsCanonicalAndLegacyTokensWithoutDNS(t *testing.T) {
	service, store := newConfigBoundaryTestService(t)
	require.NoError(t, store.Set(SettingBaseURL, "https://provider.invalid/v1"))
	for _, key := range tokenSettingKeys() {
		require.NoError(t, store.Set(key, "persisted-token"))
	}

	emptyToken := ""
	cfg, err := service.SetConfig(ConfigPatch{APIToken: &emptyToken})
	require.NoError(t, err)
	require.False(t, cfg.APITokenSet())
	for _, key := range tokenSettingKeys() {
		_, err := store.Get(key)
		require.ErrorIs(t, err, gorm.ErrRecordNotFound)
	}

	reloaded, err := service.Config()
	require.NoError(t, err)
	require.False(t, reloaded.APITokenSet())
}

func TestValidateBaseURLRequiresHTTPSForPublicTargets(t *testing.T) {
	require.ErrorContains(t, ValidateBaseURL("http://1.1.1.1/v1", false), "must use https")
	require.ErrorContains(t, ValidateBaseURL("http://1.1.1.1/v1", true), "only to private or local addresses")
	require.NoError(t, ValidateBaseURL("https://1.1.1.1/v1", false))

	require.ErrorContains(t, ValidateBaseURL("http://127.0.0.1:11434/v1", false), "private or local address")
	require.NoError(t, ValidateBaseURL("http://127.0.0.1:11434/v1", true))
}

func TestSetConfigRejectsPublicHTTPWithoutPersistingToken(t *testing.T) {
	service, store := newConfigBoundaryTestService(t)
	baseURL := "http://1.1.1.1/v1"
	allowPrivate := true
	token := "must-not-be-saved"

	_, err := service.SetConfig(ConfigPatch{
		BaseURL: &baseURL, AllowPrivateNetwork: &allowPrivate, APIToken: &token,
	})
	require.ErrorContains(t, err, "only to private or local addresses")
	_, err = store.Get(SettingAPIToken)
	require.ErrorIs(t, err, gorm.ErrRecordNotFound)
}

func TestSetConfigAllowsExplicitPrivateHTTP(t *testing.T) {
	service, _ := newConfigBoundaryTestService(t)
	baseURL := "http://127.0.0.1:11434/v1"
	allowPrivate := true
	token := "local-token"

	cfg, err := service.SetConfig(ConfigPatch{
		BaseURL: &baseURL, AllowPrivateNetwork: &allowPrivate, APIToken: &token,
	})
	require.NoError(t, err)
	require.Equal(t, baseURL, cfg.BaseURL)
	require.True(t, cfg.AllowPrivateNetwork)
	require.Equal(t, token, cfg.APIToken)
}
