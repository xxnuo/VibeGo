package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/rs/zerolog/log"
	"github.com/xxnuo/vibego/internal/model"
	"github.com/xxnuo/vibego/internal/service/sshconnection"
	"github.com/xxnuo/vibego/internal/service/terminal"
	"gorm.io/gorm"
)

const (
	blockTermCompletionMaxBody       = 64 * 1024
	blockTermCompletionMaxDraft      = 32 * 1024
	blockTermCompletionMaxNewPrefix  = 4 * 1024
	blockTermCompletionMaxPrefixLen  = 16 * 1024
	blockTermCompletionMaxCwdLen     = 4096
	blockTermCompletionMaxBlockIDLen = 256
	blockTermCompletionLimit         = 100
	blockTermCompletionMaxPATHDirs   = 64
	blockTermCompletionMaxDirScan    = 4096
	blockTermCompletionMillisCutoff  = 10_000_000_000
)

var blockTermSafeBuiltinCommands = []string{
	".",
	"alias",
	"bg",
	"break",
	"cd",
	"command",
	"continue",
	"eval",
	"exec",
	"exit",
	"export",
	"false",
	"fc",
	"fg",
	"getopts",
	"hash",
	"jobs",
	"kill",
	"printf",
	"pwd",
	"read",
	"readonly",
	"return",
	"set",
	"shift",
	"source",
	"test",
	"times",
	"trap",
	"true",
	"type",
	"ulimit",
	"umask",
	"unalias",
	"unset",
	"wait",
}

var (
	errBlockTermCompletionBlockNotFound   = errors.New("completion block not found")
	errBlockTermCompletionBlockScope      = errors.New("completion block belongs to another terminal")
	errBlockTermCompletionTimestamp       = errors.New("completion block timestamp does not match")
	errBlockTermCompletionContextInvalid  = errors.New("completion connection context is invalid")
	errBlockTermCompletionContextConflict = errors.New("completion connection context conflicts with durable state")
	errBlockTermCompletionContextFailed   = errors.New("completion connection context lookup failed")
)

type blockTermCompletionRequest struct {
	TerminalID     string `json:"terminal_id"`
	BlockID        string `json:"block_id"`
	BlockCreatedAt *int64 `json:"block_created_at"`
	RuntimeType    string `json:"runtime_type"`
	SSHProfileID   string `json:"ssh_profile_id"`
	Cwd            string `json:"cwd"`
	Prefix         string `json:"prefix"`
	Draft          string `json:"draft"`
	Cursor         int    `json:"cursor"`
	Kind           string `json:"kind"`
	ExecutableOnly bool   `json:"executable_only"`
	CwdPresent     bool   `json:"-"`
	RuntimePresent bool   `json:"-"`
	ProfilePresent bool   `json:"-"`
}

type blockTermCompletionRuntimeSelection struct {
	RuntimeType  string
	SSHProfileID string
	Cwd          string
	Source       string
	Parent       model.TerminalSession
}

type blockTermCompletionDurableRecord struct {
	ID           string `gorm:"column:id"`
	TerminalID   string `gorm:"column:terminal_id"`
	RuntimeType  string `gorm:"column:runtime_type"`
	SSHProfileID string `gorm:"column:ssh_profile_id"`
	Cwd          string `gorm:"column:cwd"`
	CreatedAt    int64  `gorm:"column:created_at"`
}

type blockTermCompletionViewState struct {
	NextConnection json.RawMessage `json:"next_connection"`
}

type blockTermCompletionConnectionState struct {
	RuntimeType  string  `json:"runtime_type"`
	SSHProfileID *string `json:"ssh_profile_id"`
	Cwd          string  `json:"cwd"`
}

type blockTermCompletionSuggestion struct {
	Label       string `json:"label"`
	Replacement string `json:"replacement"`
	ReplaceText string `json:"replace_text"`
	Kind        string `json:"kind"`
}

type blockTermCompletionCandidate struct {
	Value       string `json:"value"`
	Display     string `json:"display"`
	IsDirectory bool   `json:"is_directory"`
}

type blockTermCompletionKind int

const (
	blockTermCompletionNone blockTermCompletionKind = iota
	blockTermCompletionCommand
	blockTermCompletionPath
	blockTermCompletionExecutablePath
)

type blockTermQuoteStyle int

const (
	blockTermQuoteNone blockTermQuoteStyle = iota
	blockTermQuoteSingle
	blockTermQuoteDouble
)

type blockTermShellToken struct {
	kind  byte
	raw   string
	value string
	start int
	end   int
}

type blockTermActiveWord struct {
	raw              string
	value            string
	quoteStyle       blockTermQuoteStyle
	unsafeExpansion  bool
	incompleteEscape bool
	comment          bool
}

type blockTermCompletionContext struct {
	word blockTermActiveWord
	kind blockTermCompletionKind
}

// blockTermUTF16Len matches the indexing convention used by browser text
// controls (selectionStart/selectionEnd), where astral code points occupy two
// code units.
func blockTermUTF16Len(value string) int {
	length := 0
	for _, char := range value {
		length += utf16.RuneLen(char)
	}
	return length
}

func blockTermUTF16CursorValid(value string, cursor int) bool {
	if cursor < 0 || cursor > blockTermUTF16Len(value) {
		return false
	}
	position := 0
	if cursor == 0 {
		return true
	}
	for _, char := range value {
		position += utf16.RuneLen(char)
		if cursor == position {
			return true
		}
	}
	return false
}

func blockTermCompletionJSONString(fields map[string]json.RawMessage, key string) (string, bool, error) {
	raw, ok := fields[key]
	if !ok {
		return "", false, nil
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return "", true, errors.New(key + " must be a string")
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", true, errors.New(key + " must be a string")
	}
	return value, true, nil
}

func blockTermCompletionJSONInt(fields map[string]json.RawMessage, key string) (int, bool, error) {
	raw, ok := fields[key]
	if !ok {
		return 0, false, nil
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return 0, true, errors.New(key + " must be an integer")
	}
	var value int
	if err := json.Unmarshal(raw, &value); err != nil {
		return 0, true, errors.New(key + " must be an integer")
	}
	return value, true, nil
}

func blockTermCompletionJSONInt64(fields map[string]json.RawMessage, key string) (int64, bool, error) {
	raw, ok := fields[key]
	if !ok {
		return 0, false, nil
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return 0, true, errors.New(key + " must be an integer")
	}
	var value int64
	if err := json.Unmarshal(raw, &value); err != nil {
		return 0, true, errors.New(key + " must be an integer")
	}
	return value, true, nil
}

func blockTermCompletionJSONBool(fields map[string]json.RawMessage, key string) (bool, bool, error) {
	raw, ok := fields[key]
	if !ok {
		return false, false, nil
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return false, true, errors.New(key + " must be a boolean")
	}
	var value bool
	if err := json.Unmarshal(raw, &value); err != nil {
		return false, true, errors.New(key + " must be a boolean")
	}
	return value, true, nil
}

func parseBlockTermCompletionRequest(fields map[string]json.RawMessage) (blockTermCompletionRequest, bool, error) {
	if fields == nil {
		return blockTermCompletionRequest{}, false, errors.New("request body must be a JSON object")
	}
	terminalID, _, err := blockTermCompletionJSONString(fields, "terminal_id")
	if err != nil {
		return blockTermCompletionRequest{}, false, err
	}
	if strings.TrimSpace(terminalID) == "" {
		return blockTermCompletionRequest{}, false, errors.New("terminal_id is required")
	}
	prefix, prefixPresent, err := blockTermCompletionJSONString(fields, "prefix")
	if err != nil {
		return blockTermCompletionRequest{}, false, err
	}
	draft, draftPresent, err := blockTermCompletionJSONString(fields, "draft")
	if err != nil {
		return blockTermCompletionRequest{}, false, err
	}
	cursor, cursorPresent, err := blockTermCompletionJSONInt(fields, "cursor")
	if err != nil {
		return blockTermCompletionRequest{}, false, err
	}
	kind, kindPresent, err := blockTermCompletionJSONString(fields, "kind")
	if err != nil {
		return blockTermCompletionRequest{}, false, err
	}
	executableOnly, executablePresent, err := blockTermCompletionJSONBool(fields, "executable_only")
	if err != nil {
		return blockTermCompletionRequest{}, false, err
	}
	blockID, blockPresent, err := blockTermCompletionJSONString(fields, "block_id")
	if err != nil {
		return blockTermCompletionRequest{}, false, err
	}
	createdAt, createdPresent, err := blockTermCompletionJSONInt64(fields, "block_created_at")
	if err != nil {
		return blockTermCompletionRequest{}, false, err
	}
	if blockPresent != createdPresent {
		return blockTermCompletionRequest{}, true, errors.New("block_id and block_created_at must be provided together")
	}
	if blockPresent {
		if blockID == "" {
			return blockTermCompletionRequest{}, true, errors.New("block_id must be a non-empty string")
		}
		if blockID != strings.TrimSpace(blockID) {
			return blockTermCompletionRequest{}, true, errors.New("block_id contains non-canonical whitespace")
		}
		if strings.IndexByte(blockID, 0) >= 0 {
			return blockTermCompletionRequest{}, true, errors.New("block_id contains an invalid NUL byte")
		}
		if len([]byte(blockID)) > blockTermCompletionMaxBlockIDLen {
			return blockTermCompletionRequest{}, true, errors.New("block_id is too long")
		}
	}
	if createdPresent && createdAt < 0 {
		return blockTermCompletionRequest{}, true, errors.New("block_created_at must be non-negative")
	}
	runtimeType, runtimePresent, err := blockTermCompletionJSONString(fields, "runtime_type")
	if err != nil {
		return blockTermCompletionRequest{}, false, err
	}
	sshProfileID, profilePresent, err := blockTermCompletionJSONString(fields, "ssh_profile_id")
	if err != nil {
		return blockTermCompletionRequest{}, false, err
	}
	runtimeType = strings.TrimSpace(runtimeType)
	sshProfileID = strings.TrimSpace(sshProfileID)
	if runtimePresent && runtimeType != terminal.RuntimeTypeLocal && runtimeType != terminal.RuntimeTypeSSH {
		return blockTermCompletionRequest{}, true, errors.New("runtime_type must be local or ssh")
	}

	// Any new-protocol marker selects the strict durable-context path. This
	// prevents a partially populated new request from silently falling back to
	// the legacy DB/cwd behavior.
	newProtocol := draftPresent || cursorPresent || kindPresent || executablePresent || blockPresent || runtimePresent || profilePresent

	// Cwd is intentionally parsed after the protocol marker. Older browser
	// builds sent a numeric cwd while migrating to the new request shape; that
	// value is advisory and must never override server-side state, so ignore a
	// malformed value on the new path for compatibility.
	var cwd string
	cwdPresent := false
	if _, present := fields["cwd"]; present {
		if value, valuePresent, valueErr := blockTermCompletionJSONString(fields, "cwd"); valueErr == nil {
			cwd, cwdPresent = value, valuePresent
		} else if !newProtocol {
			return blockTermCompletionRequest{}, false, valueErr
		}
	}

	var blockCreatedAt *int64
	if createdPresent {
		blockCreatedAt = &createdAt
	}
	request := blockTermCompletionRequest{
		TerminalID:     strings.TrimSpace(terminalID),
		BlockID:        blockID,
		BlockCreatedAt: blockCreatedAt,
		RuntimeType:    runtimeType,
		SSHProfileID:   sshProfileID,
		Cwd:            cwd,
		CwdPresent:     cwdPresent,
		RuntimePresent: runtimePresent,
		ProfilePresent: profilePresent,
		Prefix:         prefix,
		Draft:          draft,
		Cursor:         cursor,
		Kind:           kind,
		ExecutableOnly: executableOnly,
	}
	if newProtocol {
		if !draftPresent || !cursorPresent || !kindPresent || !prefixPresent {
			return blockTermCompletionRequest{}, true, errors.New("draft, cursor, prefix, and kind are required")
		}
		return request, true, nil
	}
	return request, false, nil
}

func normalizeBlockTermCompletionTimestamp(value int64) int64 {
	if value >= blockTermCompletionMillisCutoff {
		return value / 1000
	}
	return value
}

func blockTermCompletionRuntimeIdentityMatches(runtimeType, profileID, otherRuntimeType, otherProfileID string) bool {
	if runtimeType != otherRuntimeType {
		return false
	}
	if runtimeType == terminal.RuntimeTypeSSH {
		return profileID == otherProfileID
	}
	return runtimeType == terminal.RuntimeTypeLocal
}

func blockTermCompletionParentCwd(session model.TerminalSession) string {
	cwd := session.CurrentCwd
	if cwd == "" {
		cwd = session.Cwd
	}
	if cwd == "" && strings.TrimSpace(session.RuntimeType) == terminal.RuntimeTypeLocal {
		cwd, _ = os.Getwd()
	}
	if cwd == "" {
		cwd = "."
	}
	return cwd
}

func parseBlockTermCompletionNextConnection(raw string) (*blockTermCompletionConnectionState, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	var root map[string]json.RawMessage
	if err := json.Unmarshal([]byte(raw), &root); err != nil || root == nil {
		return nil, errBlockTermCompletionContextInvalid
	}
	nextRaw, exists := root["next_connection"]
	if !exists || bytes.Equal(bytes.TrimSpace(nextRaw), []byte("null")) {
		return nil, nil
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(nextRaw, &fields); err != nil || fields == nil {
		return nil, errBlockTermCompletionContextInvalid
	}
	runtimeType, runtimePresent, err := blockTermCompletionJSONString(fields, "runtime_type")
	if err != nil || !runtimePresent {
		return nil, errBlockTermCompletionContextInvalid
	}
	runtimeType = strings.TrimSpace(runtimeType)
	if runtimeType != terminal.RuntimeTypeLocal && runtimeType != terminal.RuntimeTypeSSH {
		return nil, errBlockTermCompletionContextInvalid
	}

	var profileID *string
	if profileRaw, profilePresent := fields["ssh_profile_id"]; profilePresent {
		if !bytes.Equal(bytes.TrimSpace(profileRaw), []byte("null")) {
			var value string
			if err := json.Unmarshal(profileRaw, &value); err != nil {
				return nil, errBlockTermCompletionContextInvalid
			}
			value = strings.TrimSpace(value)
			profileID = &value
		}
	}
	if runtimeType == terminal.RuntimeTypeLocal {
		if profileID != nil && *profileID != "" {
			return nil, errBlockTermCompletionContextInvalid
		}
		profileID = nil
	} else if profileID == nil || *profileID == "" || strings.IndexByte(*profileID, 0) >= 0 {
		return nil, errBlockTermCompletionContextInvalid
	}

	cwd, cwdPresent, err := blockTermCompletionJSONString(fields, "cwd")
	if err != nil {
		return nil, errBlockTermCompletionContextInvalid
	}
	if cwdPresent && (len([]byte(cwd)) > blockTermCompletionMaxCwdLen || strings.IndexByte(cwd, 0) >= 0) {
		return nil, errBlockTermCompletionContextInvalid
	}
	return &blockTermCompletionConnectionState{
		RuntimeType:  runtimeType,
		SSHProfileID: profileID,
		Cwd:          cwd,
	}, nil
}

func normalizeBlockTermCompletionSelection(selection blockTermCompletionRuntimeSelection) (blockTermCompletionRuntimeSelection, error) {
	selection.RuntimeType = strings.TrimSpace(selection.RuntimeType)
	selection.SSHProfileID = strings.TrimSpace(selection.SSHProfileID)
	switch selection.RuntimeType {
	case terminal.RuntimeTypeLocal:
		if selection.SSHProfileID != "" {
			return blockTermCompletionRuntimeSelection{}, errBlockTermCompletionContextInvalid
		}
	case terminal.RuntimeTypeSSH:
		if selection.SSHProfileID == "" || strings.IndexByte(selection.SSHProfileID, 0) >= 0 {
			return blockTermCompletionRuntimeSelection{}, errBlockTermCompletionContextInvalid
		}
	default:
		return blockTermCompletionRuntimeSelection{}, errBlockTermCompletionContextInvalid
	}
	if selection.Cwd == "" {
		selection.Cwd = "."
	}
	if len([]byte(selection.Cwd)) > blockTermCompletionMaxCwdLen || strings.IndexByte(selection.Cwd, 0) >= 0 {
		return blockTermCompletionRuntimeSelection{}, errBlockTermCompletionContextInvalid
	}
	return selection, nil
}

func validateBlockTermCompletionRequestContext(
	request blockTermCompletionRequest,
	selection blockTermCompletionRuntimeSelection,
) error {
	if request.RuntimePresent && request.RuntimeType != selection.RuntimeType {
		return fmt.Errorf("%w: runtime_type", errBlockTermCompletionContextConflict)
	}
	if request.ProfilePresent && request.SSHProfileID != selection.SSHProfileID {
		return fmt.Errorf("%w: ssh_profile_id", errBlockTermCompletionContextConflict)
	}
	if request.CwdPresent && request.Cwd != selection.Cwd {
		return fmt.Errorf("%w: cwd", errBlockTermCompletionContextConflict)
	}
	return nil
}

func (h *BlockTermHandler) resolveBlockTermCompletionContext(
	request blockTermCompletionRequest,
) (blockTermCompletionRuntimeSelection, error) {
	h.blockMu.RLock()
	defer h.blockMu.RUnlock()

	if request.BlockCreatedAt != nil {
		var record blockTermCompletionDurableRecord
		err := h.db.Model(&model.BlockTermBlock{}).
			Select("id", "terminal_id", "runtime_type", "ssh_profile_id", "cwd", "created_at").
			Where("id = ?", request.BlockID).
			Take(&record).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			err = h.db.Model(&model.BlockTermCommandHistory{}).
				Select("id", "terminal_id", "runtime_type", "ssh_profile_id", "cwd", "created_at").
				Where("id = ? AND history_purged_at IS NULL", request.BlockID).
				Take(&record).Error
		}
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return blockTermCompletionRuntimeSelection{}, errBlockTermCompletionBlockNotFound
		}
		if err != nil {
			return blockTermCompletionRuntimeSelection{}, fmt.Errorf("%w: %v", errBlockTermCompletionContextFailed, err)
		}
		if record.TerminalID != request.TerminalID {
			return blockTermCompletionRuntimeSelection{}, errBlockTermCompletionBlockScope
		}
		if normalizeBlockTermCompletionTimestamp(record.CreatedAt) != normalizeBlockTermCompletionTimestamp(*request.BlockCreatedAt) {
			return blockTermCompletionRuntimeSelection{}, errBlockTermCompletionTimestamp
		}
		selection, err := normalizeBlockTermCompletionSelection(blockTermCompletionRuntimeSelection{
			RuntimeType:  record.RuntimeType,
			SSHProfileID: record.SSHProfileID,
			Cwd:          record.Cwd,
			Source:       "block",
		})
		if err != nil {
			return blockTermCompletionRuntimeSelection{}, err
		}
		if err := validateBlockTermCompletionRequestContext(request, selection); err != nil {
			return blockTermCompletionRuntimeSelection{}, err
		}
		return selection, nil
	}

	var parent model.TerminalSession
	if err := h.db.Take(&parent, "id = ?", request.TerminalID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return blockTermCompletionRuntimeSelection{}, terminal.ErrTerminalNotFound
		}
		return blockTermCompletionRuntimeSelection{}, fmt.Errorf("%w: %v", errBlockTermCompletionContextFailed, err)
	}
	parentRuntimeType := strings.TrimSpace(parent.RuntimeType)
	parentProfileID := strings.TrimSpace(parent.SSHProfileID)
	selection := blockTermCompletionRuntimeSelection{
		RuntimeType:  parentRuntimeType,
		SSHProfileID: parentProfileID,
		Cwd:          blockTermCompletionParentCwd(parent),
		Source:       "terminal",
		Parent:       parent,
	}
	nextConnection, err := parseBlockTermCompletionNextConnection(parent.BlockTermViewJSON)
	if err != nil {
		return blockTermCompletionRuntimeSelection{}, err
	}
	if nextConnection != nil {
		nextProfileID := ""
		if nextConnection.SSHProfileID != nil {
			nextProfileID = *nextConnection.SSHProfileID
		}
		selection.RuntimeType = nextConnection.RuntimeType
		selection.SSHProfileID = nextProfileID
		selection.Source = "next_connection"
		if nextConnection.Cwd != "" {
			selection.Cwd = nextConnection.Cwd
		} else if blockTermCompletionRuntimeIdentityMatches(
			nextConnection.RuntimeType,
			nextProfileID,
			parentRuntimeType,
			parentProfileID,
		) {
			selection.Cwd = blockTermCompletionParentCwd(parent)
		} else {
			selection.Cwd = "."
		}
	}
	selection, err = normalizeBlockTermCompletionSelection(selection)
	if err != nil {
		return blockTermCompletionRuntimeSelection{}, err
	}
	if err := validateBlockTermCompletionRequestContext(request, selection); err != nil {
		return blockTermCompletionRuntimeSelection{}, err
	}
	return selection, nil
}

func blockTermCompletionCandidateDisplay(value string, directory bool) string {
	if directory {
		trimmed := strings.TrimSuffix(value, "/")
		if slash := strings.LastIndex(trimmed, "/"); slash >= 0 {
			return trimmed[slash+1:] + "/"
		}
		return trimmed + "/"
	}
	if slash := strings.LastIndex(value, "/"); slash >= 0 {
		return value[slash+1:]
	}
	return value
}

func blockTermCompletionCandidatesFromSuggestions(
	suggestions []blockTermCompletionSuggestion,
) []blockTermCompletionCandidate {
	candidates := make([]blockTermCompletionCandidate, 0, len(suggestions))
	for _, suggestion := range suggestions {
		directory := suggestion.Kind == "directory"
		candidates = append(candidates, blockTermCompletionCandidate{
			Value:       suggestion.Label,
			Display:     blockTermCompletionCandidateDisplay(suggestion.Label, directory),
			IsDirectory: directory,
		})
	}
	return candidates
}

func writeBlockTermCompletionRuntimeError(c *gin.Context, err error) {
	switch {
	case errors.Is(err, errBlockTermCompletionBlockNotFound):
		c.JSON(http.StatusNotFound, gin.H{"error": "completion block not found", "code": "completion_block_not_found"})
	case errors.Is(err, errBlockTermCompletionBlockScope):
		c.JSON(http.StatusBadRequest, gin.H{"error": "completion block belongs to another terminal", "code": "completion_block_scope"})
	case errors.Is(err, errBlockTermCompletionTimestamp):
		c.JSON(http.StatusConflict, gin.H{"error": "completion block timestamp does not match", "code": "completion_block_timestamp_mismatch"})
	case errors.Is(err, errBlockTermCompletionContextConflict):
		c.JSON(http.StatusBadRequest, gin.H{"error": "completion connection context conflicts with durable state", "code": "completion_context_conflict"})
	case errors.Is(err, errBlockTermCompletionContextInvalid):
		c.JSON(http.StatusBadRequest, gin.H{"error": "completion connection context is invalid", "code": "completion_context_invalid"})
	case errors.Is(err, errBlockTermCompletionContextFailed):
		log.Error().Err(err).Msg("blockterm completion context lookup failed")
		c.JSON(http.StatusInternalServerError, gin.H{"error": "completion context lookup failed", "code": "completion_context_lookup_failed"})
	case errors.Is(err, sshconnection.ErrProfileNotFound):
		c.JSON(http.StatusNotFound, gin.H{"error": "ssh profile not found", "code": "ssh_profile_not_found"})
	case errors.Is(err, sshconnection.ErrReconnectRequired):
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "ssh reconnect required", "code": "ssh_reconnect_required"})
	case errors.Is(err, sshconnection.ErrServiceClosed):
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "ssh connection service is closed", "code": "ssh_service_closed"})
	case errors.Is(err, sshconnection.ErrAuthenticationRequired), errors.Is(err, sshconnection.ErrAuthenticationFailed):
		c.JSON(http.StatusUnauthorized, gin.H{"error": "ssh authentication required", "code": "ssh_authentication_required"})
	case errors.Is(err, terminal.ErrTerminalNotFound):
		c.JSON(http.StatusNotFound, gin.H{"error": "active terminal not found"})
	case errors.Is(err, terminal.ErrCompletionUnsupported):
		c.JSON(http.StatusNotImplemented, gin.H{"error": err.Error(), "code": "terminal_completion_unsupported"})
	case errors.Is(err, context.DeadlineExceeded):
		c.JSON(http.StatusGatewayTimeout, gin.H{"error": err.Error(), "code": "terminal_completion_timeout"})
	case errors.Is(err, context.Canceled):
		c.JSON(http.StatusRequestTimeout, gin.H{"error": err.Error(), "code": "request_canceled"})
	default:
		log.Error().Err(err).Msg("blockterm remote completion failed")
		c.JSON(http.StatusBadGateway, gin.H{"error": "remote completion failed", "code": "remote_completion_failed"})
	}
}

func writeBlockTermCompletionResponse(
	c *gin.Context,
	kind string,
	prefix string,
	suggestions []blockTermCompletionSuggestion,
	hasMore bool,
) {
	sort.SliceStable(suggestions, func(i, j int) bool { return suggestions[i].Label < suggestions[j].Label })
	if len(suggestions) > blockTermCompletionLimit {
		suggestions = suggestions[:blockTermCompletionLimit]
		hasMore = true
	}
	candidates := blockTermCompletionCandidatesFromSuggestions(suggestions)
	commonPrefix := blockTermCompletionCandidateCommonPrefix(candidates)
	if hasMore {
		commonPrefix = prefix
	}
	c.JSON(http.StatusOK, gin.H{
		"kind":          kind,
		"prefix":        prefix,
		"common_prefix": commonPrefix,
		"has_more":      hasMore,
		"candidates":    candidates,
		"suggestions":   suggestions,
	})
}

func (h *BlockTermHandler) Complete(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, blockTermCompletionMaxBody)
	var fields map[string]json.RawMessage
	if err := c.ShouldBindJSON(&fields); err != nil {
		var maxBytesErr *http.MaxBytesError
		if errors.As(err, &maxBytesErr) {
			c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "request body is too large"})
			return
		}
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	req, newProtocol, err := parseBlockTermCompletionRequest(fields)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if newProtocol {
		if len(req.Draft) > blockTermCompletionMaxDraft {
			c.JSON(http.StatusBadRequest, gin.H{"error": "draft is too long"})
			return
		}
		if len(req.Prefix) > blockTermCompletionMaxNewPrefix {
			c.JSON(http.StatusBadRequest, gin.H{"error": "prefix is too long"})
			return
		}
		if req.CwdPresent && (len([]byte(req.Cwd)) > blockTermCompletionMaxCwdLen || strings.IndexByte(req.Cwd, 0) >= 0) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "cwd is invalid"})
			return
		}
		if !blockTermUTF16CursorValid(req.Draft, req.Cursor) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "cursor is outside draft"})
			return
		}
		if req.Kind != "command" && req.Kind != "file" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "kind must be command or file"})
			return
		}

		selection, resolveErr := h.resolveBlockTermCompletionContext(req)
		if resolveErr != nil {
			writeBlockTermCompletionRuntimeError(c, resolveErr)
			return
		}
		cwd := selection.Cwd
		word := blockTermActiveWord{raw: req.Prefix, value: req.Prefix}
		var suggestions []blockTermCompletionSuggestion
		hasMore := false
		switch selection.RuntimeType {
		case terminal.RuntimeTypeLocal:
			if req.Kind == terminal.CompletionKindCommand {
				suggestions = completeBlockTermCommands(c.Request.Context(), cwd, os.Getenv("PATH"), word)
			} else {
				suggestions = completeBlockTermPath(c.Request.Context(), cwd, word, req.ExecutableOnly)
			}
			hasMore = len(suggestions) > blockTermCompletionLimit
			if hasMore {
				suggestions = suggestions[:blockTermCompletionLimit]
			}
		case terminal.RuntimeTypeSSH:
			completionRequest := terminal.CompletionRequest{
				Cwd:            cwd,
				Prefix:         req.Prefix,
				Kind:           req.Kind,
				ExecutableOnly: req.ExecutableOnly,
				Limit:          blockTermCompletionLimit,
			}
			var result terminal.CompletionResult
			var runtimeErr error
			active, activeOK := h.manager.Get(req.TerminalID)
			if activeOK && blockTermCompletionRuntimeIdentityMatches(
				selection.RuntimeType,
				selection.SSHProfileID,
				active.RuntimeType,
				active.SSHProfileID,
			) {
				result, runtimeErr = h.manager.Complete(c.Request.Context(), req.TerminalID, completionRequest)
			} else {
				result, runtimeErr = h.manager.CompleteProfile(c.Request.Context(), selection.SSHProfileID, completionRequest)
			}
			if runtimeErr != nil {
				writeBlockTermCompletionRuntimeError(c, runtimeErr)
				return
			}
			hasMore = result.HasMore
			remoteCandidates := make(map[string]bool, len(result.Candidates))
			for _, candidate := range result.Candidates {
				value := strings.TrimRight(candidate.Value, "/")
				if value == "" {
					continue
				}
				if !isBlockTermCompletionName(value) {
					continue
				}
				remoteCandidates[value] = remoteCandidates[value] || candidate.IsDirectory
			}
			suggestions = make([]blockTermCompletionSuggestion, 0, len(remoteCandidates))
			for value, isDirectory := range remoteCandidates {
				if isDirectory {
					value += "/"
				}
				kind := req.Kind
				if isDirectory {
					kind = "directory"
				}
				suggestions = append(suggestions, makeBlockTermCompletionSuggestion(
					word,
					value,
					kind,
					isDirectory,
				))
			}
		default:
			writeBlockTermCompletionRuntimeError(c, terminal.ErrCompletionUnsupported)
			return
		}
		writeBlockTermCompletionResponse(c, req.Kind, req.Prefix, suggestions, hasMore)
		return
	}

	if len(req.Prefix) > blockTermCompletionMaxPrefixLen {
		c.JSON(http.StatusBadRequest, gin.H{"error": "prefix is too long"})
		return
	}
	if len(req.Cwd) > blockTermCompletionMaxCwdLen {
		c.JSON(http.StatusBadRequest, gin.H{"error": "cwd is too long"})
		return
	}

	var session model.TerminalSession
	if err := h.db.First(&session, "id = ?", req.TerminalID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "terminal not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if session.RuntimeType != "local" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "completion is only available for local terminals"})
		return
	}

	cwd := req.Cwd
	if cwd == "" {
		cwd = session.CurrentCwd
	}
	if cwd == "" {
		cwd = session.Cwd
	}
	if cwd == "" {
		cwd = "."
	}
	completionContext := parseBlockTermCompletionContext(req.Prefix)
	suggestions := completeBlockTermPrefix(c.Request.Context(), cwd, req.Prefix, os.Getenv("PATH"))
	commonPrefix := blockTermCompletionCommonPrefix(suggestions)
	hasMore := len(suggestions) > blockTermCompletionLimit
	if hasMore {
		commonPrefix = completionContext.word.value
		suggestions = suggestions[:blockTermCompletionLimit]
	}
	c.JSON(http.StatusOK, gin.H{
		"kind":          blockTermCompletionKindName(completionContext.kind),
		"prefix":        completionContext.word.value,
		"common_prefix": commonPrefix,
		"has_more":      hasMore,
		"candidates":    blockTermCompletionCandidates(suggestions),
		"suggestions":   suggestions,
	})
}

func completeBlockTermPrefix(ctx context.Context, cwd, prefix, pathEnv string) []blockTermCompletionSuggestion {
	completionContext := parseBlockTermCompletionContext(prefix)
	if completionContext.kind == blockTermCompletionNone || completionContext.word.comment ||
		completionContext.word.unsafeExpansion || completionContext.word.incompleteEscape {
		return []blockTermCompletionSuggestion{}
	}

	switch completionContext.kind {
	case blockTermCompletionCommand:
		return completeBlockTermCommands(ctx, cwd, pathEnv, completionContext.word)
	case blockTermCompletionPath, blockTermCompletionExecutablePath:
		return completeBlockTermPath(
			ctx,
			cwd,
			completionContext.word,
			completionContext.kind == blockTermCompletionExecutablePath,
		)
	default:
		return []blockTermCompletionSuggestion{}
	}
}

func blockTermCompletionKindName(kind blockTermCompletionKind) string {
	switch kind {
	case blockTermCompletionCommand:
		return "command"
	case blockTermCompletionPath, blockTermCompletionExecutablePath:
		return "file"
	default:
		return ""
	}
}

func blockTermCompletionCommonPrefix(suggestions []blockTermCompletionSuggestion) string {
	if len(suggestions) == 0 {
		return ""
	}
	prefix := []rune(suggestions[0].Label)
	for _, suggestion := range suggestions[1:] {
		value := []rune(suggestion.Label)
		limit := min(len(prefix), len(value))
		index := 0
		for index < limit && prefix[index] == value[index] {
			index++
		}
		prefix = prefix[:index]
		if len(prefix) == 0 {
			break
		}
	}
	return string(prefix)
}

func blockTermCompletionCandidateCommonPrefix(candidates []blockTermCompletionCandidate) string {
	if len(candidates) == 0 {
		return ""
	}
	prefix := []rune(candidates[0].Value)
	for _, candidate := range candidates[1:] {
		value := []rune(candidate.Value)
		limit := min(len(prefix), len(value))
		index := 0
		for index < limit && prefix[index] == value[index] {
			index++
		}
		prefix = prefix[:index]
		if len(prefix) == 0 {
			break
		}
	}
	return string(prefix)
}

func blockTermCompletionCandidates(suggestions []blockTermCompletionSuggestion) []blockTermCompletionCandidate {
	candidates := make([]blockTermCompletionCandidate, 0, len(suggestions))
	for _, suggestion := range suggestions {
		candidates = append(candidates, blockTermCompletionCandidate{
			Value:       suggestion.Label,
			Display:     suggestion.Label,
			IsDirectory: suggestion.Kind == "directory",
		})
	}
	return candidates
}

func parseBlockTermCompletionContext(prefix string) blockTermCompletionContext {
	tokens, active := lexBlockTermShellPrefix(prefix)
	if active.comment || active.unsafeExpansion || active.incompleteEscape {
		return blockTermCompletionContext{word: active, kind: blockTermCompletionNone}
	}

	expectCommand := true
	expectRedirectTarget := false
	for index, token := range tokens {
		if token.kind == 'o' {
			if isBlockTermRedirectionOperator(token.raw) {
				expectRedirectTarget = true
				continue
			}
			if isBlockTermCommandSeparator(token.raw) {
				expectCommand = true
				expectRedirectTarget = false
			}
			continue
		}

		if index+1 < len(tokens) && tokens[index+1].kind == 'o' &&
			isBlockTermRedirectionOperator(tokens[index+1].raw) && token.end == tokens[index+1].start &&
			isBlockTermDigits(token.value) {
			continue
		}
		if expectRedirectTarget {
			expectRedirectTarget = false
			continue
		}
		if expectCommand && isBlockTermAssignment(token.value) {
			continue
		}
		expectCommand = false
	}

	if expectRedirectTarget {
		return blockTermCompletionContext{word: active, kind: blockTermCompletionPath}
	}
	if expectCommand {
		if isBlockTermAssignment(active.value) {
			return blockTermCompletionContext{word: active, kind: blockTermCompletionNone}
		}
		if strings.Contains(active.value, "/") {
			return blockTermCompletionContext{word: active, kind: blockTermCompletionExecutablePath}
		}
		return blockTermCompletionContext{word: active, kind: blockTermCompletionCommand}
	}
	return blockTermCompletionContext{word: active, kind: blockTermCompletionPath}
}

func lexBlockTermShellPrefix(prefix string) ([]blockTermShellToken, blockTermActiveWord) {
	tokens := make([]blockTermShellToken, 0)
	var value strings.Builder
	wordStart := -1
	quote := rune(0)
	quoteStyle := blockTermQuoteNone
	unsafeExpansion := false
	incompleteEscape := false

	startWord := func(index int) {
		if wordStart < 0 {
			wordStart = index
		}
	}
	finishWord := func(end int) {
		if wordStart < 0 {
			return
		}
		tokens = append(tokens, blockTermShellToken{
			kind:  'w',
			raw:   prefix[wordStart:end],
			value: value.String(),
			start: wordStart,
			end:   end,
		})
		wordStart = -1
		value.Reset()
		quoteStyle = blockTermQuoteNone
		unsafeExpansion = false
		incompleteEscape = false
	}

	for index := 0; index < len(prefix); {
		r, size := utf8.DecodeRuneInString(prefix[index:])
		if r == utf8.RuneError && size == 1 {
			startWord(index)
			value.WriteByte(prefix[index])
			index++
			continue
		}

		if quote == '\'' {
			if r == '\'' {
				quote = 0
				index += size
				continue
			}
			value.WriteRune(r)
			index += size
			continue
		}
		if quote == '"' {
			if r == '"' {
				quote = 0
				index += size
				continue
			}
			if r == '\\' {
				startWord(index)
				nextIndex := index + size
				if nextIndex >= len(prefix) {
					incompleteEscape = true
					index = nextIndex
					continue
				}
				next, nextSize := utf8.DecodeRuneInString(prefix[nextIndex:])
				if strings.ContainsRune("$`\"\\\n", next) {
					if next != '\n' {
						value.WriteRune(next)
					}
				} else {
					value.WriteRune('\\')
					value.WriteRune(next)
				}
				index = nextIndex + nextSize
				continue
			}
			if r == '$' || r == '`' {
				unsafeExpansion = true
			}
			value.WriteRune(r)
			index += size
			continue
		}

		if unicode.IsSpace(r) {
			finishWord(index)
			if r == '\n' || r == '\r' {
				tokens = append(tokens, blockTermShellToken{kind: 'o', raw: "\n", start: index, end: index + size})
			}
			index += size
			continue
		}
		if r == '#' && wordStart < 0 {
			return tokens, blockTermActiveWord{comment: true}
		}
		if isBlockTermOperatorRune(r) {
			finishWord(index)
			op, end := readBlockTermOperator(prefix, index, r, size)
			tokens = append(tokens, blockTermShellToken{kind: 'o', raw: op, start: index, end: end})
			index = end
			continue
		}

		startWord(index)
		switch r {
		case '\\':
			nextIndex := index + size
			if nextIndex >= len(prefix) {
				incompleteEscape = true
				index = nextIndex
				continue
			}
			next, nextSize := utf8.DecodeRuneInString(prefix[nextIndex:])
			if next != '\n' {
				value.WriteRune(next)
			}
			index = nextIndex + nextSize
			continue
		case '\'':
			quote = '\''
			if quoteStyle == blockTermQuoteNone {
				quoteStyle = blockTermQuoteSingle
			}
		case '"':
			quote = '"'
			if quoteStyle == blockTermQuoteNone {
				quoteStyle = blockTermQuoteDouble
			}
		default:
			if r == '$' || r == '`' || r == '*' || r == '?' || r == '[' || r == ']' || r == '{' || r == '}' {
				unsafeExpansion = true
			}
			value.WriteRune(r)
		}
		index += size
	}

	if wordStart < 0 {
		return tokens, blockTermActiveWord{}
	}
	if quote == '\'' {
		quoteStyle = blockTermQuoteSingle
	} else if quote == '"' {
		quoteStyle = blockTermQuoteDouble
	}
	return tokens, blockTermActiveWord{
		raw:              prefix[wordStart:],
		value:            value.String(),
		quoteStyle:       quoteStyle,
		unsafeExpansion:  unsafeExpansion,
		incompleteEscape: incompleteEscape,
	}
}

func isBlockTermOperatorRune(r rune) bool {
	return r == ';' || r == '|' || r == '&' || r == '<' || r == '>' || r == '(' || r == ')'
}

func readBlockTermOperator(prefix string, index int, first rune, firstSize int) (string, int) {
	end := index + firstSize
	if end >= len(prefix) {
		return prefix[index:end], end
	}
	next, nextSize := utf8.DecodeRuneInString(prefix[end:])
	if (first == '&' && next == '&') || (first == '|' && (next == '|' || next == '&')) ||
		((first == '<' || first == '>') && (next == first || next == '&' || next == '|')) ||
		(first == ';' && next == ';') {
		end += nextSize
	}
	return prefix[index:end], end
}

func isBlockTermRedirectionOperator(operator string) bool {
	return strings.HasPrefix(operator, "<") || strings.HasPrefix(operator, ">")
}

func isBlockTermCommandSeparator(operator string) bool {
	return operator == ";" || operator == ";;" || operator == "&" || operator == "&&" ||
		operator == "|" || operator == "||" || operator == "|&" || operator == "\n" || operator == "("
}

func isBlockTermDigits(value string) bool {
	if value == "" {
		return false
	}
	for _, r := range value {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func isBlockTermAssignment(value string) bool {
	equals := strings.IndexByte(value, '=')
	if equals <= 0 {
		return false
	}
	for index, r := range value[:equals] {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || r == '_' || (index > 0 && r >= '0' && r <= '9') {
			continue
		}
		return false
	}
	return true
}

func completeBlockTermCommands(
	ctx context.Context,
	cwd string,
	pathEnv string,
	word blockTermActiveWord,
) []blockTermCompletionSuggestion {
	if strings.Contains(word.value, "/") {
		return completeBlockTermPath(ctx, cwd, word, true)
	}

	names := make(map[string]string)
	for _, builtin := range blockTermSafeBuiltinCommands {
		if strings.HasPrefix(builtin, word.value) {
			names[builtin] = builtin
		}
	}
	pathDirs := filepath.SplitList(pathEnv)
	if len(pathDirs) > blockTermCompletionMaxPATHDirs {
		pathDirs = pathDirs[:blockTermCompletionMaxPATHDirs]
	}
	for _, pathDir := range pathDirs {
		if ctx.Err() != nil {
			return []blockTermCompletionSuggestion{}
		}
		if pathDir == "" {
			pathDir = cwd
		} else if !filepath.IsAbs(pathDir) {
			pathDir = filepath.Join(cwd, pathDir)
		}
		entries, err := readBlockTermCompletionDir(pathDir)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			name := entry.Name()
			if !isBlockTermCompletionName(name) || !strings.HasPrefix(name, word.value) {
				continue
			}
			info, err := os.Stat(filepath.Join(pathDir, name))
			if err != nil || info.IsDir() || !isBlockTermExecutable(name, info.Mode()) {
				continue
			}
			key := name
			if runtime.GOOS == "windows" {
				key = strings.ToLower(name)
			}
			if _, exists := names[key]; !exists {
				names[key] = name
			}
		}
	}

	ordered := make([]string, 0, len(names))
	for _, name := range names {
		ordered = append(ordered, name)
	}
	sort.Strings(ordered)
	if len(ordered) > blockTermCompletionLimit+1 {
		ordered = ordered[:blockTermCompletionLimit+1]
	}
	suggestions := make([]blockTermCompletionSuggestion, 0, len(ordered))
	for _, name := range ordered {
		suggestions = append(suggestions, makeBlockTermCompletionSuggestion(word, name, "command", false))
	}
	return suggestions
}

func completeBlockTermPath(
	ctx context.Context,
	cwd string,
	word blockTermActiveWord,
	executableOnly bool,
) []blockTermCompletionSuggestion {
	if word.value == "~" && !executableOnly {
		return []blockTermCompletionSuggestion{makeBlockTermCompletionSuggestion(word, "~/", "directory", true)}
	}
	directoryPart, namePrefix := splitBlockTermLiteralPath(word.value)
	searchDir := filepath.FromSlash(directoryPart)
	if directoryPart == "~/" || strings.HasPrefix(directoryPart, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return []blockTermCompletionSuggestion{}
		}
		searchDir = filepath.Join(home, filepath.FromSlash(strings.TrimPrefix(directoryPart, "~/")))
	} else if searchDir == "" {
		searchDir = cwd
	} else if !filepath.IsAbs(searchDir) {
		searchDir = filepath.Join(cwd, searchDir)
	}
	entries, err := readBlockTermCompletionDir(searchDir)
	if err != nil {
		return []blockTermCompletionSuggestion{}
	}

	type candidate struct {
		name        string
		isDirectory bool
	}
	candidates := make([]candidate, 0)
	for _, entry := range entries {
		if ctx.Err() != nil {
			return []blockTermCompletionSuggestion{}
		}
		name := entry.Name()
		if !isBlockTermCompletionName(name) || !strings.HasPrefix(name, namePrefix) ||
			(strings.HasPrefix(name, ".") && !strings.HasPrefix(namePrefix, ".")) {
			continue
		}
		info, err := os.Stat(filepath.Join(searchDir, name))
		if err != nil {
			continue
		}
		isDirectory := info.IsDir()
		if executableOnly && !isDirectory && !isBlockTermExecutable(name, info.Mode()) {
			continue
		}
		candidates = append(candidates, candidate{name: name, isDirectory: isDirectory})
	}
	sort.Slice(candidates, func(i, j int) bool {
		if candidates[i].isDirectory != candidates[j].isDirectory {
			return candidates[i].isDirectory
		}
		return candidates[i].name < candidates[j].name
	})
	if len(candidates) > blockTermCompletionLimit+1 {
		candidates = candidates[:blockTermCompletionLimit+1]
	}
	suggestions := make([]blockTermCompletionSuggestion, 0, len(candidates))
	for _, candidate := range candidates {
		value := directoryPart + candidate.name
		kind := "file"
		if candidate.isDirectory {
			value += "/"
			kind = "directory"
		}
		suggestions = append(suggestions, makeBlockTermCompletionSuggestion(word, value, kind, candidate.isDirectory))
	}
	return suggestions
}

func splitBlockTermLiteralPath(value string) (string, string) {
	index := strings.LastIndex(value, "/")
	if index < 0 {
		return "", value
	}
	return value[:index+1], value[index+1:]
}

func makeBlockTermCompletionSuggestion(
	word blockTermActiveWord,
	value string,
	kind string,
	directory bool,
) blockTermCompletionSuggestion {
	return blockTermCompletionSuggestion{
		Label:       value,
		Replacement: quoteBlockTermCompletion(value, word.quoteStyle, !directory),
		ReplaceText: word.raw,
		Kind:        kind,
	}
}

func quoteBlockTermCompletion(value string, style blockTermQuoteStyle, trailingSpace bool) string {
	suffix := ""
	if trailingSpace {
		suffix = " "
	}
	switch style {
	case blockTermQuoteSingle:
		return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'" + suffix
	case blockTermQuoteDouble:
		replacer := strings.NewReplacer("\\", "\\\\", "\"", "\\\"", "$", "\\$", "`", "\\`")
		return "\"" + replacer.Replace(value) + "\"" + suffix
	default:
		return escapeBlockTermCompletionWord(value) + suffix
	}
}

func escapeBlockTermCompletionWord(value string) string {
	var escaped strings.Builder
	for _, r := range value {
		if unicode.IsLetter(r) || unicode.IsDigit(r) || strings.ContainsRune("_@%+=:,./-", r) {
			escaped.WriteRune(r)
			continue
		}
		escaped.WriteRune('\\')
		escaped.WriteRune(r)
	}
	return escaped.String()
}

func isBlockTermCompletionName(name string) bool {
	return name != "" && utf8.ValidString(name) && strings.IndexFunc(name, unicode.IsControl) < 0
}

func readBlockTermCompletionDir(path string) ([]os.DirEntry, error) {
	directory, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer directory.Close()
	entries, err := directory.ReadDir(blockTermCompletionMaxDirScan)
	if errors.Is(err, io.EOF) {
		err = nil
	}
	return entries, err
}

func isBlockTermExecutable(name string, mode os.FileMode) bool {
	if !mode.IsRegular() {
		return false
	}
	if runtime.GOOS != "windows" {
		return mode.Perm()&0o111 != 0
	}
	extension := strings.ToLower(filepath.Ext(name))
	pathExt := os.Getenv("PATHEXT")
	if pathExt == "" {
		pathExt = ".COM;.EXE;.BAT;.CMD"
	}
	for _, allowed := range strings.Split(pathExt, ";") {
		if extension == strings.ToLower(strings.TrimSpace(allowed)) {
			return true
		}
	}
	return false
}
