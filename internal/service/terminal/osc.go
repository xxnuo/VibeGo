package terminal

import (
	"encoding/base64"
	"encoding/json"
	"log"
	"net/url"
	"strings"
)

// Only the PTY reader owns this parser. Non-OSC control strings are skipped,
// so image/DCS payloads cannot manufacture notifications or unbounded buffers.
type oscParser struct {
	state    byte
	escaped  bool
	data     []byte
	overflow bool
}

func (p *oscParser) feed(data []byte, emit func(string)) {
	for _, b := range data {
		switch p.state {
		case 0:
			if b == 27 {
				p.state = 1
			}
		case 1:
			switch b {
			case ']':
				p.state = 2
				p.data = p.data[:0]
				p.overflow = false
				p.escaped = false
			case 'P', '_', '^', 'X':
				p.state = 3
				p.escaped = false
			case '[':
				p.state = 4
			default:
				p.state = 0
			}
		case 2, 3:
			if (p.escaped && b == '\\') || (p.state == 2 && b == 7) {
				if p.state == 2 && !p.overflow {
					emit(string(p.data))
				}
				p.state = 0
				p.data = nil
				p.escaped = false
				continue
			}
			if p.state == 2 && !p.overflow {
				if p.escaped {
					p.data = append(p.data, 27)
				}
				if b != 27 {
					p.data = append(p.data, b)
				}
				if len(p.data) > 64*1024 {
					p.data = nil
					p.overflow = true
				}
			}
			p.escaped = b == 27
		case 4:
			if b >= 0x40 && b <= 0x7e {
				p.state = 0
			}
		}
	}
}

func (m *Manager) terminalEvent(at *activeTerminal, kind string, payload map[string]any) {
	if m.terminalEvents == nil {
		return
	}
	at.sessionMu.RLock()
	workspaceID := at.Session.WorkspaceSessionID
	at.sessionMu.RUnlock()
	if workspaceID == "" {
		return
	}
	_, cursor := at.historyBuffer.CursorRange()
	payload["type"], payload["terminal_id"], payload["workspace_id"], payload["cursor"] = kind, at.ID, workspaceID, cursor
	data, err := json.Marshal(payload)
	if err == nil {
		m.terminalEvents(workspaceID, data)
	}
}

func (m *Manager) consumeOSC(at *activeTerminal, raw string) {
	code, data, ok := strings.Cut(raw, ";")
	if !ok {
		return
	}
	var update ShellMetadataUpdate
	switch code {
	case "9", "777":
		at.sessionMu.RLock()
		title := at.Session.Name
		at.sessionMu.RUnlock()
		body := strings.TrimSpace(data)
		if code == "777" {
			command, rest, ok := strings.Cut(data, ";")
			if !ok || command != "notify" {
				return
			}
			title, body, ok = strings.Cut(rest, ";")
			if !ok {
				return
			}
		}
		title, body = strings.TrimSpace(title), strings.TrimSpace(body)
		if title != "" && body != "" {
			m.terminalEvent(at, "terminal:notification", map[string]any{"title": title, "body": body})
		}
		return
	case "7":
		u, err := url.Parse(data)
		if err != nil || u.Scheme != "file" || u.Path == "" {
			return
		}
		update.CurrentCwd = &u.Path
	case "16162":
		command, payload, _ := strings.Cut(data, ";")
		var value struct {
			Cmd64       string  `json:"cmd64"`
			Shell       *string `json:"shell"`
			Integration *bool   `json:"integration"`
			ExitCode    *int    `json:"exitcode"`
		}
		if payload != "" {
			_ = json.Unmarshal([]byte(payload), &value)
		}
		yes := true
		state := "ready"
		switch command {
		case "A":
			update.ShellState = &state
			update.ShellIntegration = &yes
		case "C":
			state = "running-command"
			update.ShellState = &state
			update.ShellIntegration = &yes
			if decoded, err := base64.StdEncoding.DecodeString(value.Cmd64); err == nil {
				s := string(decoded)
				update.LastCommand = &s
			}
		case "M":
			update.ShellType = value.Shell
			update.ShellIntegration = value.Integration
			if update.ShellIntegration == nil {
				update.ShellIntegration = &yes
			}
		case "D":
			update.ShellState = &state
			update.LastCommandExitCode = value.ExitCode
			update.LastCommandExitCodeSet = true
		case "R":
			state = ""
			yes = false
			update.ShellState = &state
			update.ShellIntegration = &yes
		default:
			return
		}
	default:
		return
	}
	if err := m.UpdateShellMetadata(at.ID, update); err != nil {
		log.Printf("terminal metadata update failed for %s: %v", at.ID, err)
		return
	}
	at.sessionMu.RLock()
	session := cloneTerminalSession(at.Session)
	at.sessionMu.RUnlock()
	m.terminalEvent(at, "terminal:runtime", map[string]any{"terminal": sessionToInfo(&session)})
}
