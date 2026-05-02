package config

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestDatabaseFileURI(t *testing.T) {
	for _, tt := range []struct{ path, want string }{
		{"C:/Users/test/vibego.sqlite", "file:///C:/Users/test/vibego.sqlite"},
		{"D:/用户/test #1?/vibego.sqlite", "file:///D:/%E7%94%A8%E6%88%B7/test%20%231%3F/vibego.sqlite"},
		{"/tmp/test #1?/vibego.sqlite", "file:///tmp/test%20%231%3F/vibego.sqlite"},
		{"//server/share/vibego.sqlite", "file:////server/share/vibego.sqlite"},
	} {
		t.Run(tt.path, func(t *testing.T) {
			require.Equal(t, tt.want, databaseFileURI(tt.path))
		})
	}
}

func TestOpenDBPairFilePath(t *testing.T) {
	path := filepath.Join(t.TempDir(), "数据库 #1.sqlite")
	pair, err := OpenDBPair(path)
	require.NoError(t, err)
	writer, err := pair.Writer.DB()
	require.NoError(t, err)
	t.Cleanup(func() { _ = writer.Close() })
	reader, err := pair.Reader.DB()
	require.NoError(t, err)
	t.Cleanup(func() { _ = reader.Close() })
	require.NoError(t, pair.Writer.Exec("CREATE TABLE uri_test (value TEXT)").Error)
	require.NoError(t, pair.Writer.Exec("INSERT INTO uri_test VALUES (?)", "persisted").Error)
	var value string
	require.NoError(t, pair.Reader.Raw("SELECT value FROM uri_test").Scan(&value).Error)
	require.Equal(t, "persisted", value)
	_, err = os.Stat(path)
	require.NoError(t, err)
}
