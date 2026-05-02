package handler

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestReadGitFileBoundedDistinguishesExactAndTruncatedContent(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "content.txt")
	require.NoError(t, os.WriteFile(path, []byte("12345"), 0600))

	content, truncated, err := readGitFileBounded(path, 5)
	require.NoError(t, err)
	require.False(t, truncated)
	require.Equal(t, []byte("12345"), content)

	content, truncated, err = readGitFileBounded(path, 4)
	require.NoError(t, err)
	require.True(t, truncated)
	require.Equal(t, []byte("1234"), content)
}

func TestReadGitBlobRejectsOversizedObjectBeforeReadingIt(t *testing.T) {
	dir := newRealGitRepo(t)
	path := filepath.Join(dir, "large.bin")
	content := bytes.Repeat([]byte{'x'}, gitConflictContentLimit+1)
	require.NoError(t, os.WriteFile(path, content, 0600))
	runRealGit(t, dir, "add", "--", "large.bin")
	runRealGit(t, dir, "commit", "-m", "large blob")

	got, exists, err := readGitBlob(dir, "HEAD:large.bin")
	require.Error(t, err)
	require.False(t, exists)
	require.Nil(t, got)
}
