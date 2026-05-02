package handler

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/xxnuo/vibego/internal/service/terminal"
)

const blockTermViewMaxBodyBytes = 64 * 1024

type blockTermViewSidebarPatchRequest struct {
	Open       *bool
	Width      *string
	BlockIDSet bool
	BlockID    *string
}

func parseBlockTermViewPatchBody(data []byte) (terminal.BlockTermSidebarPatch, error) {
	var root map[string]json.RawMessage
	if err := json.Unmarshal(data, &root); err != nil || root == nil {
		return terminal.BlockTermSidebarPatch{}, errors.New("request body must be a JSON object")
	}
	for key := range root {
		if key != "sidebar" && key != "next_connection" {
			return terminal.BlockTermSidebarPatch{}, errors.New("only sidebar or next_connection may be patched")
		}
	}
	patch := terminal.BlockTermSidebarPatch{}
	sidebarRaw, exists := root["sidebar"]
	if exists {
		if bytes.Equal(bytes.TrimSpace(sidebarRaw), []byte("null")) {
			return terminal.BlockTermSidebarPatch{}, errors.New("sidebar must be a JSON object")
		}
		var sidebar map[string]json.RawMessage
		if err := json.Unmarshal(sidebarRaw, &sidebar); err != nil || sidebar == nil {
			return terminal.BlockTermSidebarPatch{}, errors.New("sidebar must be a JSON object")
		}
		for key, value := range sidebar {
			switch key {
			case "open":
				if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
					return terminal.BlockTermSidebarPatch{}, errors.New("sidebar.open must be a boolean")
				}
				var open bool
				if err := json.Unmarshal(value, &open); err != nil {
					return terminal.BlockTermSidebarPatch{}, errors.New("sidebar.open must be a boolean")
				}
				patch.Open = &open
			case "width":
				if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
					return terminal.BlockTermSidebarPatch{}, errors.New("sidebar.width must be a string")
				}
				var width string
				if err := json.Unmarshal(value, &width); err != nil {
					return terminal.BlockTermSidebarPatch{}, errors.New("sidebar.width must be a string")
				}
				patch.Width = &width
			case "block_id":
				patch.BlockIDSet = true
				if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
					patch.BlockID = nil
					continue
				}
				var blockID string
				if err := json.Unmarshal(value, &blockID); err != nil {
					return terminal.BlockTermSidebarPatch{}, errors.New("sidebar.block_id must be a string or null")
				}
				patch.BlockID = &blockID
			default:
				return terminal.BlockTermSidebarPatch{}, errors.New("unsupported sidebar field: " + key)
			}
		}
	}
	if nextRaw, exists := root["next_connection"]; exists {
		patch.NextConnectionSet = true
		if bytes.Equal(bytes.TrimSpace(nextRaw), []byte("null")) {
			patch.NextConnection = nil
		} else {
			next, err := parseBlockTermViewConnectionPatch(nextRaw)
			if err != nil {
				return terminal.BlockTermSidebarPatch{}, err
			}
			patch.NextConnection = next
		}
	}
	return patch, nil
}

func parseBlockTermViewConnectionPatch(data []byte) (*terminal.BlockTermConnectionState, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil || fields == nil {
		return nil, errors.New("next_connection must be an object")
	}
	state := &terminal.BlockTermConnectionState{}
	for key, value := range fields {
		switch key {
		case "runtime_type":
			if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
				return nil, errors.New("next_connection.runtime_type must be a string")
			}
			if err := json.Unmarshal(value, &state.RuntimeType); err != nil {
				return nil, errors.New("next_connection.runtime_type must be a string")
			}
		case "ssh_profile_id":
			if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
				state.SSHProfileID = nil
				continue
			}
			var profileID string
			if err := json.Unmarshal(value, &profileID); err != nil {
				return nil, errors.New("next_connection.ssh_profile_id must be a string or null")
			}
			state.SSHProfileID = &profileID
		case "cwd":
			if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
				return nil, errors.New("next_connection.cwd must be a string")
			}
			if err := json.Unmarshal(value, &state.Cwd); err != nil {
				return nil, errors.New("next_connection.cwd must be a string")
			}
		default:
			return nil, errors.New("unsupported next_connection field: " + key)
		}
	}
	return state, nil
}

func writeBlockTermViewError(c *gin.Context, err error) {
	switch {
	case errors.Is(err, terminal.ErrTerminalNotFound):
		c.JSON(http.StatusNotFound, gin.H{"error": "terminal not found"})
	case errors.Is(err, terminal.ErrBlockTermViewBlockNotFound):
		c.JSON(http.StatusNotFound, gin.H{"error": "sidebar block not found"})
	case errors.Is(err, terminal.ErrBlockTermViewBlockScope):
		c.JSON(http.StatusBadRequest, gin.H{"error": "sidebar block belongs to another terminal"})
	case errors.Is(err, terminal.ErrBlockTermViewBlockArchived):
		c.JSON(http.StatusBadRequest, gin.H{"error": "sidebar block is archived"})
	case errors.Is(err, terminal.ErrBlockTermViewInvalid):
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
	case errors.Is(err, terminal.ErrBlockTermViewSSHProfile):
		c.JSON(http.StatusNotFound, gin.H{"error": "next connection SSH profile not found", "code": "ssh_profile_not_found"})
	default:
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
	}
}

// GetBlockTermView serves terminal-scoped desktop presentation state.
func (h *TerminalHandler) GetBlockTermView(c *gin.Context) {
	if h.manager == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "terminal manager unavailable"})
		return
	}
	state, err := h.manager.GetBlockTermView(strings.TrimSpace(c.Param("terminal_id")))
	if err != nil {
		writeBlockTermViewError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"view": state})
}

// PatchBlockTermView updates only fields present in sidebar/next_connection.
// Explicit null clears a nullable owner or the complete next connection.
func (h *TerminalHandler) PatchBlockTermView(c *gin.Context) {
	if h.manager == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "terminal manager unavailable"})
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, blockTermViewMaxBodyBytes)
	data, err := io.ReadAll(c.Request.Body)
	if err != nil {
		var maxBytesErr *http.MaxBytesError
		if errors.As(err, &maxBytesErr) {
			c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "request body is too large"})
			return
		}
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	patch, err := parseBlockTermViewPatchBody(data)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	state, err := h.manager.PatchBlockTermView(strings.TrimSpace(c.Param("terminal_id")), patch)
	if err != nil {
		writeBlockTermViewError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"view": state})
}
