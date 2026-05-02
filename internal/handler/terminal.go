package handler

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"github.com/rs/zerolog/log"
	"github.com/xxnuo/vibego/internal/model"
	"github.com/xxnuo/vibego/internal/service/terminal"
	"gorm.io/gorm"
)

type TerminalHandler struct {
	manager  *terminal.Manager
	upgrader websocket.Upgrader
}

// NewTerminalHandler accepts the shared manager used by the server. For
// compatibility with older integrations it also accepts (db, shell), creating
// and initializing a manager for that legacy call shape.
func NewTerminalHandler(source any, shells ...string) *TerminalHandler {
	var manager *terminal.Manager
	switch value := source.(type) {
	case *terminal.Manager:
		manager = value
	case *gorm.DB:
		shell := ""
		if len(shells) > 0 {
			shell = shells[0]
		}
		manager = terminal.NewManager(value, &terminal.ManagerConfig{Shell: shell})
		manager.CleanupOnStart()
	case nil:
		// Keep a nil manager for lightweight tests that only exercise routing;
		// callers that create terminals should use the shared-manager form.
	}
	return &TerminalHandler{
		manager: manager,
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool {
				return true
			},
		},
	}
}

func (h *TerminalHandler) Register(r *gin.RouterGroup) {
	g := r.Group("/terminal")
	g.GET("", h.List)
	g.POST("", h.New)
	g.POST("/sync-workspace", h.SyncWorkspace)
	g.POST("/rename", h.Rename)
	g.POST("/runtime-info", h.UpdateRuntimeInfo)
	g.PATCH("/:id/settings", h.UpdateSettings)
	g.POST("/:id/reset", h.Reset)
	g.GET("/:id/process-identity", h.ProcessIdentity)
	g.POST("/close", h.Close)
	g.POST("/delete", h.Delete)
	g.POST("/delete-batch", h.DeleteBatch)
	g.GET("/ws/:id", h.WebSocket)
	// BlockTerm view state is terminal-scoped but lives alongside the terminal
	// lifecycle routes so ownership and deletion use the same manager lock.
	r.GET("/blockterm/sessions/:terminal_id/view", h.GetBlockTermView)
	r.PATCH("/blockterm/sessions/:terminal_id/view", h.PatchBlockTermView)
}

type TerminalInfo struct {
	ID                  string                        `json:"id"`
	Name                string                        `json:"name"`
	TabColor            string                        `json:"tab_color"`
	TabIcon             string                        `json:"tab_icon"`
	Shell               string                        `json:"shell"`
	Cwd                 string                        `json:"cwd"`
	CurrentCwd          string                        `json:"current_cwd"`
	Cols                int                           `json:"cols"`
	Rows                int                           `json:"rows"`
	RuntimeType         string                        `json:"runtime_type"`
	SSHProfileID        string                        `json:"ssh_profile_id,omitempty"`
	Readonly            bool                          `json:"readonly"`
	Capabilities        terminal.TerminalCapabilities `json:"capabilities"`
	Status              string                        `json:"status"`
	WorkspaceSessionID  string                        `json:"workspace_session_id"`
	GroupID             string                        `json:"group_id"`
	ParentID            string                        `json:"parent_id"`
	ExitCode            int                           `json:"exit_code"`
	HistorySize         int64                         `json:"history_size"`
	ShellType           string                        `json:"shell_type"`
	ShellState          string                        `json:"shell_state"`
	ShellIntegration    bool                          `json:"shell_integration"`
	LastCommand         string                        `json:"last_command"`
	LastCommandExitCode *int                          `json:"last_command_exit_code"`
	CreatedAt           int64                         `json:"created_at"`
	UpdatedAt           int64                         `json:"updated_at"`
}

// List godoc
// @Summary List terminal sessions
// @Tags Terminal
// @Produce json
// @Success 200 {object} map[string][]TerminalInfo
// @Failure 500 {object} map[string]string
// @Router /api/terminal/list [get]
func (h *TerminalHandler) List(c *gin.Context) {
	workspaceSessionID := c.Query("workspace_session_id")
	groupID := c.Query("group_id")
	sessions, err := h.manager.List(workspaceSessionID, groupID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	list := make([]TerminalInfo, len(sessions))
	for i, s := range sessions {
		list[i] = TerminalInfo{
			ID:                  s.ID,
			Name:                s.Name,
			TabColor:            s.TabColor,
			TabIcon:             s.TabIcon,
			Shell:               s.Shell,
			Cwd:                 s.Cwd,
			CurrentCwd:          s.CurrentCwd,
			Cols:                s.Cols,
			Rows:                s.Rows,
			RuntimeType:         s.RuntimeType,
			SSHProfileID:        s.SSHProfileID,
			Readonly:            s.Readonly,
			Capabilities:        s.Capabilities,
			Status:              s.Status,
			WorkspaceSessionID:  s.WorkspaceSessionID,
			GroupID:             s.GroupID,
			ParentID:            s.ParentID,
			ExitCode:            s.ExitCode,
			HistorySize:         s.HistorySize,
			ShellType:           s.ShellType,
			ShellState:          s.ShellState,
			ShellIntegration:    s.ShellIntegration,
			LastCommand:         s.LastCommand,
			LastCommandExitCode: s.LastCommandExitCode,
			CreatedAt:           s.CreatedAt,
			UpdatedAt:           s.UpdatedAt,
		}
	}
	c.JSON(http.StatusOK, gin.H{"terminals": list})
}

type NewTerminalRequest struct {
	Name               string         `json:"name"`
	Cwd                string         `json:"cwd"`
	Cols               int            `json:"cols"`
	Rows               int            `json:"rows"`
	UserID             string         `json:"user_id"`
	WorkspaceSessionID string         `json:"workspace_session_id"`
	GroupID            string         `json:"group_id"`
	ParentID           string         `json:"parent_id"`
	RuntimeType        string         `json:"runtime_type"`
	SSHProfileID       string         `json:"ssh_profile_id"`
	SSHAuth            sshAuthRequest `json:"ssh_auth"`
}

// New godoc
// @Summary Create new terminal session
// @Tags Terminal
// @Accept json
// @Produce json
// @Param request body NewTerminalRequest true "Terminal options"
// @Success 200 {object} map[string]interface{}
// @Failure 500 {object} map[string]string
// @Router /api/terminal/new [post]
func (h *TerminalHandler) New(c *gin.Context) {
	var req NewTerminalRequest
	if !bindLimitedJSON(c, &req, sshSecretRequestMaxBody) {
		return
	}

	info, err := h.manager.CreateInWorkspace(terminal.CreateOptions{
		Name:               req.Name,
		Cwd:                req.Cwd,
		Cols:               req.Cols,
		Rows:               req.Rows,
		UserID:             req.UserID,
		WorkspaceSessionID: req.WorkspaceSessionID,
		GroupID:            req.GroupID,
		ParentID:           req.ParentID,
		RuntimeType:        req.RuntimeType,
		SSHProfileID:       req.SSHProfileID,
		SSHAuth:            req.SSHAuth.secrets(),
		Context:            c.Request.Context(),
	})
	if err != nil {
		if writeSSHError(c, err) {
			return
		}
		if errors.Is(err, terminal.ErrWorkspaceNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "session not found"})
			return
		}
		if errors.Is(err, terminal.ErrTerminalNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		if errors.Is(err, terminal.ErrTerminalScopeMismatch) || errors.Is(err, terminal.ErrInvalidTerminalParent) {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "id": info.ID, "name": info.Name})
}

type CloseTerminalRequest struct {
	ID string `json:"id" binding:"required"`
}

type SyncWorkspaceTerminalRequest struct {
	ID       string `json:"id" binding:"required"`
	GroupID  string `json:"group_id"`
	ParentID string `json:"parent_id"`
}

type SyncWorkspaceStateRequest struct {
	TerminalsByGroup       map[string][]WorkspaceTerminalSession `json:"terminalsByGroup"`
	ActiveTerminalByGroup  map[string]*string                    `json:"activeTerminalByGroup"`
	ListManagerOpenByGroup map[string]bool                       `json:"listManagerOpenByGroup"`
	TerminalLayouts        map[string]WorkspaceLayoutNode        `json:"terminalLayouts"`
	FocusedIDByGroup       map[string]*string                    `json:"focusedIdByGroup"`
}

type SyncWorkspaceRequest struct {
	WorkspaceSessionID string                         `json:"workspace_session_id" binding:"required"`
	Terminals          []SyncWorkspaceTerminalRequest `json:"terminals"`
	WorkspaceState     *SyncWorkspaceStateRequest     `json:"workspace_state,omitempty"`
}

func invalidSyncWorkspaceState(format string, args ...any) error {
	return fmt.Errorf("%w: %s", errWorkspaceStatePatchInvalid, fmt.Sprintf(format, args...))
}

func validateSyncWorkspaceState(
	assignments []terminal.WorkspaceTerminalAssignment,
	state SyncWorkspaceStateRequest,
) error {
	if err := validateWorkspaceState(WorkspaceState{
		TerminalsByGroup: state.TerminalsByGroup,
		TerminalLayouts:  state.TerminalLayouts,
	}); err != nil {
		return invalidSyncWorkspaceState("%v", err)
	}

	assignmentByID := make(map[string]terminal.WorkspaceTerminalAssignment, len(assignments))
	for _, assignment := range assignments {
		if assignment.ID == "" {
			return invalidSyncWorkspaceState("terminal id is required")
		}
		if _, exists := assignmentByID[assignment.ID]; exists {
			return invalidSyncWorkspaceState("duplicate terminal assignment %s", assignment.ID)
		}
		assignmentByID[assignment.ID] = assignment
	}

	stateTerminalIDs := make(map[string]struct{}, len(assignments))
	for groupID, terminals := range state.TerminalsByGroup {
		for _, stateTerminal := range terminals {
			if _, exists := stateTerminalIDs[stateTerminal.ID]; exists {
				return invalidSyncWorkspaceState("terminal %s appears more than once in terminalsByGroup", stateTerminal.ID)
			}
			stateTerminalIDs[stateTerminal.ID] = struct{}{}

			assignment, exists := assignmentByID[stateTerminal.ID]
			if !exists {
				return invalidSyncWorkspaceState("terminal %s is not in terminal assignments", stateTerminal.ID)
			}
			if assignment.GroupID != groupID {
				return invalidSyncWorkspaceState(
					"terminal %s belongs to group %q in assignments, not %q",
					stateTerminal.ID,
					assignment.GroupID,
					groupID,
				)
			}
			parentID := ""
			if stateTerminal.ParentID != nil {
				parentID = *stateTerminal.ParentID
			}
			if assignment.ParentID != parentID {
				return invalidSyncWorkspaceState(
					"terminal %s parent is %q in assignments, not %q",
					stateTerminal.ID,
					assignment.ParentID,
					parentID,
				)
			}
		}
	}
	for terminalID := range assignmentByID {
		if _, exists := stateTerminalIDs[terminalID]; !exists {
			return invalidSyncWorkspaceState("terminal %s is missing from terminalsByGroup", terminalID)
		}
	}

	if err := validateSyncWorkspaceGroupReferences("activeTerminalByGroup", state.ActiveTerminalByGroup, assignmentByID, true); err != nil {
		return err
	}
	if err := validateSyncWorkspaceGroupReferences("focusedIdByGroup", state.FocusedIDByGroup, assignmentByID, false); err != nil {
		return err
	}
	for rootID, layout := range state.TerminalLayouts {
		if err := validateSyncWorkspaceLayout(rootID, layout, assignmentByID); err != nil {
			return err
		}
	}

	return nil
}

func validateSyncWorkspaceGroupReferences(
	field string,
	references map[string]*string,
	assignments map[string]terminal.WorkspaceTerminalAssignment,
	requireRoot bool,
) error {
	for groupID, terminalID := range references {
		if terminalID == nil {
			continue
		}
		if *terminalID == "" {
			return invalidSyncWorkspaceState("%s[%q] cannot reference an empty terminal id", field, groupID)
		}
		assignment, exists := assignments[*terminalID]
		if !exists {
			return invalidSyncWorkspaceState("%s[%q] references unknown terminal %s", field, groupID, *terminalID)
		}
		if assignment.GroupID != groupID {
			return invalidSyncWorkspaceState(
				"%s[%q] references terminal %s from group %q",
				field,
				groupID,
				*terminalID,
				assignment.GroupID,
			)
		}
		if requireRoot && assignment.ParentID != "" {
			return invalidSyncWorkspaceState("%s[%q] references child terminal %s", field, groupID, *terminalID)
		}
	}
	return nil
}

func validateSyncWorkspaceLayout(
	rootID string,
	layout WorkspaceLayoutNode,
	assignments map[string]terminal.WorkspaceTerminalAssignment,
) error {
	root, exists := assignments[rootID]
	if !exists {
		return invalidSyncWorkspaceState("terminalLayouts[%q] has an unknown root terminal", rootID)
	}
	if root.ParentID != "" {
		return invalidSyncWorkspaceState("terminalLayouts[%q] uses a child terminal as its root", rootID)
	}

	seen := make(map[string]struct{})
	var walk func(WorkspaceLayoutNode) error
	walk = func(node WorkspaceLayoutNode) error {
		if node.Type == "split" {
			if err := walk(*node.First); err != nil {
				return err
			}
			return walk(*node.Second)
		}

		terminalID := *node.TerminalID
		if _, duplicate := seen[terminalID]; duplicate {
			return invalidSyncWorkspaceState("terminalLayouts[%q] references terminal %s more than once", rootID, terminalID)
		}
		seen[terminalID] = struct{}{}
		assignment, exists := assignments[terminalID]
		if !exists {
			return invalidSyncWorkspaceState("terminalLayouts[%q] references unknown terminal %s", rootID, terminalID)
		}
		if assignment.GroupID != root.GroupID {
			return invalidSyncWorkspaceState(
				"terminalLayouts[%q] references terminal %s from group %q",
				rootID,
				terminalID,
				assignment.GroupID,
			)
		}
		if terminalID == rootID {
			if assignment.ParentID != "" {
				return invalidSyncWorkspaceState("terminalLayouts[%q] root terminal has parent %s", rootID, assignment.ParentID)
			}
			return nil
		}
		if assignment.ParentID != rootID {
			return invalidSyncWorkspaceState(
				"terminalLayouts[%q] references terminal %s with parent %q",
				rootID,
				terminalID,
				assignment.ParentID,
			)
		}
		return nil
	}
	if err := walk(layout); err != nil {
		return err
	}
	if _, exists := seen[rootID]; !exists {
		return invalidSyncWorkspaceState("terminalLayouts[%q] does not contain its root terminal", rootID)
	}
	return nil
}

func (h *TerminalHandler) SyncWorkspace(c *gin.Context) {
	var req SyncWorkspaceRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	assignments := make([]terminal.WorkspaceTerminalAssignment, 0, len(req.Terminals))
	for _, item := range req.Terminals {
		assignments = append(assignments, terminal.WorkspaceTerminalAssignment{
			ID:       item.ID,
			GroupID:  item.GroupID,
			ParentID: item.ParentID,
		})
	}

	status := http.StatusInternalServerError
	var updateState func(*gorm.DB) error
	if req.WorkspaceState != nil {
		if err := validateSyncWorkspaceState(assignments, *req.WorkspaceState); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		updateState = func(tx *gorm.DB) error {
			if err := canonicalizeWorkspaceTerminalSettings(
				tx,
				req.WorkspaceSessionID,
				req.WorkspaceState.TerminalsByGroup,
			); err != nil {
				return err
			}
			_, err := updateSessionWorkspaceState(tx, req.WorkspaceSessionID, WorkspaceStatePatch{
				TerminalsByGroup:       &req.WorkspaceState.TerminalsByGroup,
				ActiveTerminalByGroup:  &req.WorkspaceState.ActiveTerminalByGroup,
				ListManagerOpenByGroup: &req.WorkspaceState.ListManagerOpenByGroup,
				TerminalLayouts:        &req.WorkspaceState.TerminalLayouts,
				FocusedIDByGroup:       &req.WorkspaceState.FocusedIDByGroup,
			})
			if errors.Is(err, errWorkspaceStatePatchInvalid) {
				status = http.StatusBadRequest
			}
			return err
		}
	}
	err := h.manager.SyncWorkspaceMetadataWithTransaction(req.WorkspaceSessionID, assignments, updateState)
	if err != nil {
		if errors.Is(err, terminal.ErrWorkspaceNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "session not found"})
			return
		}
		if errors.Is(err, terminal.ErrTerminalNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		if errors.Is(err, terminal.ErrTerminalScopeMismatch) || errors.Is(err, terminal.ErrInvalidTerminalParent) || errors.Is(err, errWorkspaceStatePatchInvalid) {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		c.JSON(status, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func canonicalizeWorkspaceTerminalSettings(
	tx *gorm.DB,
	workspaceSessionID string,
	terminalsByGroup map[string][]WorkspaceTerminalSession,
) error {
	ids := make([]string, 0)
	expectedGroupByID := make(map[string]string)
	for groupID, terminals := range terminalsByGroup {
		for _, item := range terminals {
			if strings.TrimSpace(item.ID) == "" {
				return fmt.Errorf("%w: terminal id is required", errWorkspaceStatePatchInvalid)
			}
			if _, duplicate := expectedGroupByID[item.ID]; duplicate {
				return fmt.Errorf("%w: terminal %s appears more than once", errWorkspaceStatePatchInvalid, item.ID)
			}
			expectedGroupByID[item.ID] = groupID
			ids = append(ids, item.ID)
		}
	}
	if len(ids) == 0 {
		return nil
	}

	var sessions []struct {
		ID                 string `gorm:"column:id"`
		WorkspaceSessionID string `gorm:"column:workspace_session_id"`
		GroupID            string `gorm:"column:group_id"`
		Name               string `gorm:"column:name"`
		TabColor           string `gorm:"column:tab_color"`
		TabIcon            string `gorm:"column:tab_icon"`
	}
	if err := tx.Model(&model.TerminalSession{}).
		Select("id", "workspace_session_id", "group_id", "name", "tab_color", "tab_icon").
		Where("id IN ?", ids).
		Find(&sessions).Error; err != nil {
		return err
	}
	byID := make(map[string]struct {
		Name     string
		TabColor string
		TabIcon  string
	}, len(sessions))
	for _, session := range sessions {
		expectedGroup := expectedGroupByID[session.ID]
		if session.WorkspaceSessionID != workspaceSessionID || session.GroupID != expectedGroup {
			return fmt.Errorf(
				"%w: terminal %s belongs to workspace %q group %q",
				terminal.ErrTerminalScopeMismatch,
				session.ID,
				session.WorkspaceSessionID,
				session.GroupID,
			)
		}
		tabColor, err := terminal.NormalizeTabColor(session.TabColor)
		if err != nil {
			return err
		}
		tabIcon, err := terminal.NormalizeTabIcon(session.TabIcon)
		if err != nil {
			return err
		}
		byID[session.ID] = struct {
			Name     string
			TabColor string
			TabIcon  string
		}{Name: session.Name, TabColor: tabColor, TabIcon: tabIcon}
	}
	for groupID, terminals := range terminalsByGroup {
		for i := range terminals {
			settings, ok := byID[terminals[i].ID]
			if !ok {
				return fmt.Errorf("%w: terminal %s", terminal.ErrTerminalNotFound, terminals[i].ID)
			}
			terminals[i].Name = settings.Name
			terminals[i].TabColor = settings.TabColor
			terminals[i].TabIcon = settings.TabIcon
		}
		terminalsByGroup[groupID] = terminals
	}
	return nil
}

type RenameTerminalRequest struct {
	ID   string `json:"id" binding:"required"`
	Name string `json:"name" binding:"required"`
}

type UpdateTerminalSettingsRequest struct {
	Name     *string `json:"name,omitempty"`
	TabColor *string `json:"tab_color,omitempty"`
	TabIcon  *string `json:"tab_icon,omitempty"`
}

type optionalIntPatch struct {
	Set   bool
	Value *int
}

func (p *optionalIntPatch) UnmarshalJSON(data []byte) error {
	p.Set = true
	if strings.TrimSpace(string(data)) == "null" {
		p.Value = nil
		return nil
	}
	var value int
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	p.Value = &value
	return nil
}

type UpdateTerminalRuntimeInfoRequest struct {
	ID                  string           `json:"id" binding:"required"`
	CurrentCwd          *string          `json:"current_cwd,omitempty"`
	ShellType           *string          `json:"shell_type,omitempty"`
	ShellState          *string          `json:"shell_state,omitempty"`
	ShellIntegration    *bool            `json:"shell_integration,omitempty"`
	LastCommand         *string          `json:"last_command,omitempty"`
	LastCommandExitCode optionalIntPatch `json:"last_command_exit_code,omitempty"`
}

func (h *TerminalHandler) Rename(c *gin.Context) {
	var req RenameTerminalRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.manager.Rename(req.ID, req.Name); err != nil {
		writeTerminalSettingsError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *TerminalHandler) UpdateSettings(c *gin.Context) {
	id := strings.TrimSpace(c.Param("id"))
	if id == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id is required"})
		return
	}

	var req UpdateTerminalSettingsRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	err := h.manager.UpdateSettings(id, terminal.SettingsUpdate{
		Name:     req.Name,
		TabColor: req.TabColor,
		TabIcon:  req.TabIcon,
	})
	if err != nil {
		writeTerminalSettingsError(c, err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func writeTerminalSettingsError(c *gin.Context, err error) {
	switch {
	case errors.Is(err, terminal.ErrTerminalNotFound):
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
	case errors.Is(err, terminal.ErrWorkspaceNotFound):
		c.JSON(http.StatusNotFound, gin.H{"error": "session not found"})
	case errors.Is(err, terminal.ErrInvalidTerminalSettings):
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
	case errors.Is(err, terminal.ErrInvalidWorkspaceState), errors.Is(err, terminal.ErrTerminalScopeMismatch):
		c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
	default:
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
	}
}

func (h *TerminalHandler) UpdateRuntimeInfo(c *gin.Context) {
	var req UpdateTerminalRuntimeInfoRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	err := h.manager.UpdateShellMetadata(req.ID, terminal.ShellMetadataUpdate{
		CurrentCwd:             req.CurrentCwd,
		ShellType:              req.ShellType,
		ShellState:             req.ShellState,
		ShellIntegration:       req.ShellIntegration,
		LastCommand:            req.LastCommand,
		LastCommandExitCode:    req.LastCommandExitCode.Value,
		LastCommandExitCodeSet: req.LastCommandExitCode.Set,
	})
	if err != nil {
		status := http.StatusInternalServerError
		if err == terminal.ErrTerminalNotFound {
			status = http.StatusNotFound
		}
		c.JSON(status, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// Reset replaces a live local PTY while retaining the terminal identity and
// its durable BlockTerm data.
func (h *TerminalHandler) Reset(c *gin.Context) {
	id := strings.TrimSpace(c.Param("id"))
	if id == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id is required"})
		return
	}

	info, err := h.manager.Reset(id)
	if err != nil {
		switch {
		case errors.Is(err, terminal.ErrTerminalNotFound):
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		case errors.Is(err, terminal.ErrTerminalResetBusy):
			c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
		case errors.Is(err, terminal.ErrTerminalResetUnsupported):
			c.JSON(http.StatusNotImplemented, gin.H{"error": err.Error()})
		default:
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		}
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "terminal": info})
}

// ProcessIdentity returns process identifiers only when the active runtime
// can observe them. In particular, a remote SSH runtime does not report a
// guessed local PID.
func (h *TerminalHandler) ProcessIdentity(c *gin.Context) {
	id := strings.TrimSpace(c.Param("id"))
	if id == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id is required"})
		return
	}
	identity, err := h.manager.ProcessIdentity(id)
	if err != nil {
		switch {
		case errors.Is(err, terminal.ErrTerminalNotFound):
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		case errors.Is(err, terminal.ErrProcessIdentityUnsupported):
			c.JSON(http.StatusNotImplemented, gin.H{"error": err.Error()})
		default:
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		}
		return
	}
	c.JSON(http.StatusOK, identity)
}

// Close godoc
// @Summary Close terminal session
// @Tags Terminal
// @Accept json
// @Produce json
// @Param request body CloseTerminalRequest true "Terminal ID"
// @Success 200 {object} map[string]bool
// @Failure 400 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/terminal/close [post]
func (h *TerminalHandler) Close(c *gin.Context) {
	var req CloseTerminalRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.manager.Close(req.ID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

type DeleteTerminalRequest struct {
	ID string `json:"id" binding:"required"`
}

// Delete godoc
// @Summary Delete terminal session and its history
// @Tags Terminal
// @Accept json
// @Produce json
// @Param request body DeleteTerminalRequest true "Terminal ID"
// @Success 200 {object} map[string]bool
// @Failure 400 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/terminal/delete [post]
func (h *TerminalHandler) Delete(c *gin.Context) {
	var req DeleteTerminalRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.manager.Delete(req.ID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

type DeleteBatchRequest struct {
	IDs []string `json:"ids" binding:"required"`
}

// DeleteBatch godoc
// @Summary Delete multiple terminal sessions and their history
// @Tags Terminal
// @Accept json
// @Produce json
// @Param request body DeleteBatchRequest true "Terminal IDs"
// @Success 200 {object} map[string]interface{}
// @Failure 400 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/terminal/delete-batch [post]
func (h *TerminalHandler) DeleteBatch(c *gin.Context) {
	var req DeleteBatchRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	deleted := 0
	for _, id := range req.IDs {
		if err := h.manager.Delete(id); err == nil {
			deleted++
		}
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "deleted": deleted})
}

// WebSocket godoc
// @Summary Connect to terminal websocket
// @Tags Terminal
// @Param id path string true "Terminal ID"
// @Router /api/terminal/ws/{id} [get]
func (h *TerminalHandler) WebSocket(c *gin.Context) {
	id := c.Param("id")
	if id == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id is required"})
		return
	}

	conn, err := h.upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		log.Error().Err(err).Msg("Failed to upgrade websocket")
		return
	}

	cursor := uint64(0)
	if raw := c.Query("cursor"); raw != "" {
		if parsed, parseErr := strconv.ParseUint(raw, 10, 64); parseErr == nil {
			cursor = parsed
		}
	}

	termConn, err := h.manager.AttachWithOptions(id, conn, terminal.AttachOptions{Cursor: cursor})
	if err != nil {
		log.Error().Err(err).Str("id", id).Msg("Failed to attach to terminal")
		conn.Close()
		return
	}

	log.Info().Str("id", id).Msg("Terminal attached via WebSocket")

	<-termConn.Done
}
