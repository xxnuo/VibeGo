package handler

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

func testPNG(t *testing.T, value color.RGBA) []byte {
	t.Helper()
	var buf bytes.Buffer
	img := image.NewRGBA(image.Rect(0, 0, 2, 2))
	for y := 0; y < 2; y++ {
		for x := 0; x < 2; x++ {
			img.SetRGBA(x, y, value)
		}
	}
	require.NoError(t, png.Encode(&buf, img))
	return buf.Bytes()
}

func assertImagePayload(t *testing.T, payload *GitImageDiff, old, current []byte) {
	t.Helper()
	require.NotNil(t, payload)
	require.Equal(t, "image/png", payload.MimeType)
	gotOld, err := base64.StdEncoding.DecodeString(payload.Old)
	require.NoError(t, err)
	gotCurrent, err := base64.StdEncoding.DecodeString(payload.New)
	require.NoError(t, err)
	require.Equal(t, old, gotOld)
	require.Equal(t, current, gotCurrent)
}

func TestGitFileDiffReportsBinaryMetadataWithoutSerializingBytes(t *testing.T) {
	dir := newRealGitRepo(t)
	original := []byte{'P', 'N', 'G', 0, 1, 2, 3, 4}
	path := filepath.Join(dir, "image.bin")
	require.NoError(t, os.WriteFile(path, original, 0644))
	runRealGit(t, dir, "add", "--", "image.bin")
	runRealGit(t, dir, "commit", "-m", "binary base")

	modified := []byte{'P', 'N', 'G', 0, 9, 8, 7, 6, 5}
	require.NoError(t, os.WriteFile(path, modified, 0644))
	r, _ := setupRouter()
	w := postJSON(r, "/git/file-diff", map[string]interface{}{
		"path": dir, "filePath": "image.bin", "mode": "working",
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	var diff InteractiveDiff
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &diff))
	require.True(t, diff.Binary)
	require.True(t, diff.OldBinary)
	require.True(t, diff.NewBinary)
	require.Equal(t, int64(len(original)), diff.OldSize)
	require.Equal(t, int64(len(modified)), diff.NewSize)
	require.Empty(t, diff.Old)
	require.Empty(t, diff.New)
	require.Empty(t, diff.Hunks)
	require.False(t, diff.Capability.LineSelectable)
}

func TestGitDiffImagePayloadSupportsWorkingAndHistoryPreviews(t *testing.T) {
	dir := newRealGitRepo(t)
	original := testPNG(t, color.RGBA{R: 220, A: 255})
	modified := testPNG(t, color.RGBA{B: 220, A: 255})
	path := filepath.Join(dir, "image.png")
	require.NoError(t, os.WriteFile(path, original, 0644))
	runRealGit(t, dir, "add", "--", "image.png")
	runRealGit(t, dir, "commit", "-m", "image base")
	baseCommit := runRealGit(t, dir, "rev-parse", "HEAD")

	require.NoError(t, os.WriteFile(path, modified, 0644))
	r, _ := setupRouter()
	w := postJSON(r, "/git/diff", map[string]interface{}{"path": dir, "filePath": "image.png"})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var working struct {
		Old     string        `json:"old"`
		New     string        `json:"new"`
		OldSize int64         `json:"oldSize"`
		NewSize int64         `json:"newSize"`
		Binary  bool          `json:"binary"`
		Image   *GitImageDiff `json:"image"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &working))
	require.True(t, working.Binary)
	require.Empty(t, working.Old)
	require.Empty(t, working.New)
	require.Equal(t, int64(len(original)), working.OldSize)
	require.Equal(t, int64(len(modified)), working.NewSize)
	assertImagePayload(t, working.Image, original, modified)

	w = postJSON(r, "/git/file-diff", map[string]interface{}{"path": dir, "filePath": "image.png", "mode": "working"})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var structured InteractiveDiff
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &structured))
	assertImagePayload(t, structured.Image, original, modified)
	require.False(t, structured.Capability.LineSelectable)

	runRealGit(t, dir, "add", "--", "image.png")
	runRealGit(t, dir, "commit", "-m", "image modified")
	latestCommit := runRealGit(t, dir, "rev-parse", "HEAD")
	require.NotEqual(t, baseCommit, latestCommit)
	w = postJSON(r, "/git/commit-diff", map[string]interface{}{"path": dir, "commit": latestCommit, "filePath": "image.png"})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var history struct {
		Old    string        `json:"old"`
		New    string        `json:"new"`
		Binary bool          `json:"binary"`
		Image  *GitImageDiff `json:"image"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &history))
	require.True(t, history.Binary)
	require.Empty(t, history.Old)
	require.Empty(t, history.New)
	assertImagePayload(t, history.Image, original, modified)
}

func TestGitDiffImagePayloadKeepsOversizedImagesBounded(t *testing.T) {
	dir := newRealGitRepo(t)
	oversized := append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte{0}, gitDiffImageLimit)...)
	require.NoError(t, os.WriteFile(filepath.Join(dir, "large.png"), oversized, 0644))
	r, _ := setupRouter()

	w := postJSON(r, "/git/diff", map[string]interface{}{"path": dir, "filePath": "large.png"})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Less(t, w.Body.Len(), 64*1024)
	var response struct {
		NewSize      int64         `json:"newSize"`
		NewTruncated bool          `json:"newTruncated"`
		Image        *GitImageDiff `json:"image"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &response))
	require.Equal(t, int64(len(oversized)), response.NewSize)
	require.True(t, response.NewTruncated)
	require.NotNil(t, response.Image)
	require.Equal(t, "image/png", response.Image.MimeType)
	require.Empty(t, response.Image.New)
}

func TestGitFileDiffBoundsLargeTextAndDisablesPartialSelection(t *testing.T) {
	dir := newRealGitRepo(t)
	line := []byte("base line with enough bytes to make the patch expensive\n")
	original := bytes.Repeat(line, int(gitDiffPatchLimit/int64(len(line)))+4096)
	path := filepath.Join(dir, "large.txt")
	require.NoError(t, os.WriteFile(path, original, 0644))
	runRealGit(t, dir, "add", "--", "large.txt")
	runRealGit(t, dir, "commit", "-m", "large base")

	modifiedLine := []byte("changed line with enough bytes to make the patch expensive\n")
	modified := bytes.Repeat(modifiedLine, len(original)/len(line))
	require.NoError(t, os.WriteFile(path, modified, 0644))
	r, _ := setupRouter()
	w := postJSON(r, "/git/file-diff", map[string]interface{}{
		"path": dir, "filePath": "large.txt", "mode": "working",
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	var diff InteractiveDiff
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &diff))
	require.True(t, diff.Large)
	require.True(t, diff.PatchTruncated)
	require.Greater(t, diff.PatchSize, int64(gitDiffPatchLimit))
	require.True(t, diff.OldTruncated)
	require.True(t, diff.NewTruncated)
	require.Equal(t, int64(len(original)), diff.OldSize)
	require.Equal(t, int64(len(modified)), diff.NewSize)
	require.Empty(t, diff.Hunks)
	require.False(t, diff.Capability.LineSelectable)
	require.False(t, diff.Binary)
	// The bounded response contains at most the configured patch limit.
	require.LessOrEqual(t, int64(len(diff.Patch)), int64(gitDiffPatchLimit))
}
