package handler

import (
	"fmt"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"
	"github.com/xxnuo/vibego/internal/model"
)

func TestBlockTermOutputPutAndGetPreserveMoreThanOneMiB(t *testing.T) {
	env := setupBlockTermHandler(t)
	seedBlockTermTerminal(t, env.db, "term-output-over-one-mib")
	require.NoError(t, env.db.Create(&model.BlockTermBlock{
		ID:         "block-output-over-one-mib",
		TerminalID: "term-output-over-one-mib",
		LineNum:    0,
	}).Error)

	prefix := make([]byte, 1<<20+257)
	for index := range prefix {
		prefix[index] = "0123456789abcdef"[index%16]
	}
	output := append(prefix, []byte("终点")...)
	cursor := fmt.Sprintf("%d", len(output))

	put := doBlockTermOutputRequest(
		env.router,
		http.MethodPut,
		"/api/blockterm/blocks/block-output-over-one-mib/output",
		output,
		&cursor,
	)
	require.Equal(t, http.StatusNoContent, put.Code, put.Body.String())

	get := doBlockTermOutputRequest(
		env.router,
		http.MethodGet,
		"/api/blockterm/blocks/block-output-over-one-mib/output",
		nil,
		nil,
	)
	require.Equal(t, http.StatusOK, get.Code, get.Body.String())
	require.Equal(t, output, get.Body.Bytes())
	require.Equal(t, cursor, get.Header().Get(blockTermOutputCursorHeader))

	var metadata blockTermMetadata
	require.NoError(t, blockTermMetadataQuery(env.db).
		Where("id = ?", "block-output-over-one-mib").Take(&metadata).Error)
	require.Equal(t, int64(len(output)), metadata.OutputSize)
}

func TestBlockTermRawOutputUsesSegmentsAndDeletesThemWithBlock(t *testing.T) {
	env := setupBlockTermHandler(t)
	seedBlockTermTerminal(t, env.db, "term-raw-output")
	require.NoError(t, env.db.Create(&model.BlockTermBlock{
		ID:         "block-raw-output",
		TerminalID: "term-raw-output",
		LineNum:    0,
	}).Error)
	require.NoError(t, env.db.Create([]model.BlockTermOutputSegment{
		{ID: "raw-segment-1", TerminalID: "term-raw-output", BlockID: "block-raw-output", StartCursor: 10, EndCursor: 13, Data: []byte{0x1b, '[', 'm'}},
		{ID: "raw-segment-2", TerminalID: "term-raw-output", BlockID: "block-raw-output", StartCursor: 13, EndCursor: 17, Data: []byte{'x', 0x00, 0xff, 'y'}},
	}).Error)

	get := doBlockTermOutputRequest(
		env.router,
		http.MethodGet,
		"/api/blockterm/blocks/block-raw-output/raw-output",
		nil,
		nil,
	)
	require.Equal(t, http.StatusOK, get.Code, get.Body.String())
	require.Equal(t, []byte{0x1b, '[', 'm', 'x', 0x00, 0xff, 'y'}, get.Body.Bytes())
	require.Equal(t, "10", get.Header().Get(blockTermOutputStartHeader))
	require.Equal(t, "17", get.Header().Get(blockTermOutputEndHeader))
	require.Equal(t, "17", get.Header().Get(blockTermOutputCursorHeader))
	require.Equal(t, "7", get.Header().Get("Content-Length"))

	deleted := doBlockTermJSON(t, env.router, http.MethodDelete, "/api/blockterm/blocks/block-raw-output", nil)
	require.Equal(t, http.StatusOK, deleted.Code, deleted.Body.String())
	var count int64
	require.NoError(t, env.db.Model(&model.BlockTermOutputSegment{}).Where("block_id = ?", "block-raw-output").Count(&count).Error)
	require.Zero(t, count)
}
