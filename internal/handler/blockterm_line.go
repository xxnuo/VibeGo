package handler

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"

	"github.com/xxnuo/vibego/internal/model"
	"github.com/xxnuo/vibego/internal/service/blocktermhistory"
)

const (
	blockTermKindCommand        = "command"
	blockTermKindNote           = "note"
	blockTermKindRenderer       = "renderer"
	blockTermRendererTerminal   = "terminal"
	blockTermRendererNone       = "none"
	blockTermRendererOpenAI     = "openai"
	blockTermRendererSourcePTY  = "pty"
	blockTermMaxPresentationLen = 4 * 1024
	blockTermMaxTextLen         = 256 * 1024
	blockTermJSONOverheadBytes  = 2 * 1024 * 1024
	blockTermMaxBodyBytes       = ((blockTermMaxOutputBytes + 2) / 3 * 4) + blockTermJSONOverheadBytes
	blockTermMinHeight          = -1
	blockTermMaxHeight          = 10000
	blockTermMinTermCols        = 10
	blockTermMaxTermCols        = 1024
	blockTermMinTermRows        = 2
	blockTermMaxTermRows        = 1024
	blockTermMaxPID             = int64(^uint64(0) >> 1)
	blockTermMaxCommandStateLen = 4 * 1024
)

var blockTermSidebarWidthRe = regexp.MustCompile(`^([1-9][0-9]{0,3})(px|%)$`)
var blockTermPresentationIntegerRe = regexp.MustCompile(`^-?(0|[1-9][0-9]*)$`)

var blockTermKnownPluginRenderers = map[string]struct{}{
	"code":     {},
	"csv":      {},
	"image":    {},
	"markdown": {},
	"media":    {},
	"mustache": {},
	"pdf":      {},
}

func validateBlockTermKind(kind string) error {
	switch kind {
	case blockTermKindCommand, blockTermKindNote, blockTermKindRenderer:
		return nil
	default:
		return errors.New("kind must be command, note, or renderer")
	}
}

func normalizeBlockTermKind(kind, renderer string) (string, error) {
	if kind == "" {
		if renderer != "" {
			return blockTermKindRenderer, nil
		}
		return blockTermKindCommand, nil
	}
	if err := validateBlockTermKind(kind); err != nil {
		return "", err
	}
	return kind, nil
}

func validateBlockTermText(text string) error {
	if len(text) > blockTermMaxTextLen {
		return fmt.Errorf("text too long, max length is %d", blockTermMaxTextLen)
	}
	return nil
}

func isBlockTermKnownPluginRenderer(renderer string) bool {
	_, ok := blockTermKnownPluginRenderers[renderer]
	return ok
}

func validateBlockTermCommandRenderer(renderer string) error {
	if renderer == "" || renderer == blockTermRendererTerminal || renderer == blockTermRendererNone ||
		isBlockTermKnownPluginRenderer(renderer) {
		return nil
	}
	return fmt.Errorf("renderer %q is not available for command blocks", renderer)
}

func parseBlockTermRendererState(stateJSON string) (map[string]json.RawMessage, error) {
	if stateJSON == "" {
		return nil, nil
	}
	var state map[string]json.RawMessage
	if err := json.Unmarshal([]byte(stateJSON), &state); err != nil || state == nil {
		return nil, errors.New("state_json must be a valid JSON object")
	}
	return state, nil
}

func validateBlockTermCommandRendererState(renderer, stateJSON string) error {
	if err := validateBlockTermCommandRenderer(renderer); err != nil {
		return err
	}
	state, err := parseBlockTermRendererState(stateJSON)
	if err != nil {
		return err
	}
	if renderer == "" || renderer == blockTermRendererTerminal || renderer == blockTermRendererNone {
		if stateJSON != "" {
			return errors.New("state_json must be empty for terminal and none renderers")
		}
		return nil
	}
	// WaveTerm simple renderers default an omitted source to PTY. Persisted
	// command renderers may therefore use either an empty object or an explicit
	// prompt:source=pty, but never a file source owned by a different line type.
	rawSource, hasSource := state["prompt:source"]
	if !hasSource {
		if _, hasFile := state["prompt:file"]; hasFile {
			return errors.New("state_json.prompt:file is not valid for command renderers")
		}
		return nil
	}
	var source string
	if err := json.Unmarshal(rawSource, &source); err != nil {
		return errors.New("state_json.prompt:source must be pty for command renderers")
	}
	if source != blockTermRendererSourcePTY {
		return errors.New("state_json.prompt:source must be pty for command renderers")
	}
	if _, hasFile := state["prompt:file"]; hasFile {
		return errors.New("state_json.prompt:file is not valid for command renderers")
	}
	return nil
}

func parseBlockTermPresentationInt(raw json.RawMessage, field string, min, max int) error {
	// Keep the persisted JSON contract strict. json.Unmarshal accepts null for
	// scalar destinations and would silently turn it into zero; it also has
	// implementation-specific number coercion differences from the frontend.
	raw = bytes.TrimSpace(raw)
	if !blockTermPresentationIntegerRe.Match(raw) {
		return fmt.Errorf("presentation_json.%s must be an integer", field)
	}
	var value int
	if err := json.Unmarshal(raw, &value); err != nil {
		return fmt.Errorf("presentation_json.%s must be an integer", field)
	}
	if value < min || value > max {
		return fmt.Errorf("presentation_json.%s must be between %d and %d", field, min, max)
	}
	return nil
}

func validateBlockTermSidebar(raw json.RawMessage) error {
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return errors.New("presentation_json.sidebar must be a boolean or object")
	}
	var boolean bool
	if err := json.Unmarshal(raw, &boolean); err == nil {
		return nil
	}

	var sidebar map[string]json.RawMessage
	if err := json.Unmarshal(raw, &sidebar); err != nil || sidebar == nil {
		return errors.New("presentation_json.sidebar must be a boolean or object")
	}
	for key, value := range sidebar {
		switch key {
		case "open":
			if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
				return errors.New("presentation_json.sidebar.open must be a boolean")
			}
			var open bool
			if err := json.Unmarshal(value, &open); err != nil {
				return errors.New("presentation_json.sidebar.open must be a boolean")
			}
		case "width":
			if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
				return errors.New("presentation_json.sidebar.width must be a bounded px or percent value")
			}
			var width string
			if err := json.Unmarshal(value, &width); err != nil {
				return errors.New("presentation_json.sidebar.width must be a bounded px or percent value")
			}
			matches := blockTermSidebarWidthRe.FindStringSubmatch(width)
			if len(matches) != 3 {
				return errors.New("presentation_json.sidebar.width must be a bounded px or percent value")
			}
			widthValue, err := strconv.Atoi(matches[1])
			if err != nil || (matches[2] == "%" && widthValue > 100) || (matches[2] == "px" && widthValue > 4000) {
				return errors.New("presentation_json.sidebar.width must be a bounded px or percent value")
			}
		case "line_id", "sidebarlineid":
			if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
				return errors.New("presentation_json.sidebar.line_id is invalid")
			}
			var lineID string
			if err := json.Unmarshal(value, &lineID); err != nil || len(lineID) > 256 {
				return errors.New("presentation_json.sidebar.line_id is invalid")
			}
		default:
			return fmt.Errorf("presentation_json.sidebar.%s is not supported", key)
		}
	}
	return nil
}

func validateBlockTermTerminalPresentation(raw json.RawMessage) error {
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return errors.New("presentation_json.terminal must be an object")
	}
	var terminal map[string]json.RawMessage
	if err := json.Unmarshal(raw, &terminal); err != nil || terminal == nil {
		return errors.New("presentation_json.terminal must be an object")
	}
	for key, value := range terminal {
		switch key {
		case "cols":
			if err := parseBlockTermPresentationInt(value, "terminal.cols", blockTermMinTermCols, blockTermMaxTermCols); err != nil {
				return err
			}
		case "rows":
			if err := parseBlockTermPresentationInt(value, "terminal.rows", blockTermMinTermRows, blockTermMaxTermRows); err != nil {
				return err
			}
		default:
			return fmt.Errorf("presentation_json.terminal.%s is not supported", key)
		}
	}
	return nil
}

func validateBlockTermPresentationJSON(presentationJSON string) error {
	if presentationJSON == "" {
		return nil
	}
	if len(presentationJSON) > blockTermMaxPresentationLen {
		return fmt.Errorf("presentation_json too long, max length is %d", blockTermMaxPresentationLen)
	}

	var presentation map[string]json.RawMessage
	if err := json.Unmarshal([]byte(presentationJSON), &presentation); err != nil || presentation == nil {
		return errors.New("presentation_json must be a valid JSON object")
	}
	for key, value := range presentation {
		switch key {
		case "height":
			if err := parseBlockTermPresentationInt(value, "height", blockTermMinHeight, blockTermMaxHeight); err != nil {
				return err
			}
		case "sidebar":
			if err := validateBlockTermSidebar(value); err != nil {
				return err
			}
		case "terminal":
			if err := validateBlockTermTerminalPresentation(value); err != nil {
				return err
			}
		case "terminal_cols":
			if err := parseBlockTermPresentationInt(value, "terminal_cols", blockTermMinTermCols, blockTermMaxTermCols); err != nil {
				return err
			}
		case "terminal_rows":
			if err := parseBlockTermPresentationInt(value, "terminal_rows", blockTermMinTermRows, blockTermMaxTermRows); err != nil {
				return err
			}
		default:
			return fmt.Errorf("presentation_json.%s is not supported", key)
		}
	}
	return nil
}

func validateBlockTermMetadata(kind, text, renderer, stateJSON, presentationJSON string) error {
	normalizedKind, err := normalizeBlockTermKind(kind, renderer)
	if err != nil {
		return err
	}
	if normalizedKind == blockTermKindRenderer && renderer == "" {
		return errors.New("renderer kind requires a renderer")
	}
	if normalizedKind == blockTermKindNote && renderer != "" {
		return errors.New("renderer is not valid for note blocks")
	}
	if err := validateBlockTermText(text); err != nil {
		return err
	}
	if err := validateBlockTermRendererState(&renderer, &stateJSON); err != nil {
		return err
	}
	if normalizedKind == blockTermKindCommand {
		if err := validateBlockTermCommandRendererState(renderer, stateJSON); err != nil {
			return err
		}
	}
	return validateBlockTermPresentationJSON(presentationJSON)
}

func validateBlockTermPID(value *int64, field string) error {
	if value == nil {
		return nil
	}
	if *value <= 0 || *value > blockTermMaxPID {
		return fmt.Errorf("%s must be a positive integer", field)
	}
	return nil
}

func validateBlockTermGeometry(cols, rows int) error {
	if cols != 0 && (cols < blockTermMinTermCols || cols > blockTermMaxTermCols) {
		return fmt.Errorf("term_cols must be between %d and %d", blockTermMinTermCols, blockTermMaxTermCols)
	}
	if rows != 0 && (rows < blockTermMinTermRows || rows > blockTermMaxTermRows) {
		return fmt.Errorf("term_rows must be between %d and %d", blockTermMinTermRows, blockTermMaxTermRows)
	}
	return nil
}

func validateBlockTermMaxPTYSize(value int) error {
	if value < 0 || value > blockTermMaxOutputBytes {
		return fmt.Errorf("term_max_pty_size must be between 0 and %d", blockTermMaxOutputBytes)
	}
	return nil
}

func validateBlockTermCommandState(value, field string) error {
	if value == "" {
		return nil
	}
	if len(value) > blockTermMaxCommandStateLen {
		return fmt.Errorf("%s too long, max length is %d", field, blockTermMaxCommandStateLen)
	}
	var state map[string]json.RawMessage
	if err := json.Unmarshal([]byte(value), &state); err != nil || state == nil {
		return fmt.Errorf("%s must be a valid JSON object", field)
	}
	return nil
}

func blockTermBlockWritesHistory(block model.BlockTermBlock) bool {
	return blocktermhistory.ShouldWrite(block)
}
