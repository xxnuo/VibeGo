//go:build !windows

package sshconnection

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"golang.org/x/sys/unix"
)

func TestReadIdentityFileRejectsFIFOWithoutBlocking(t *testing.T) {
	path := filepath.Join(t.TempDir(), "identity.fifo")
	require.NoError(t, unix.Mkfifo(path, 0o600))
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()

	startedAt := time.Now()
	_, err := readIdentityFile(ctx, path)
	require.ErrorContains(t, err, "regular file")
	require.Less(t, time.Since(startedAt), 100*time.Millisecond)
}
