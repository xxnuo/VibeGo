package handler

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/xxnuo/vibego/internal/service/kv"
	"github.com/xxnuo/vibego/internal/service/settings"
	"gorm.io/gorm"
)

type GitHandler struct {
	settings       *settings.Store
	selectionStore *gitSelectionStore
	wsHandler      *GitWSHandler
}

func NewGitHandler(db *gorm.DB) *GitHandler {
	h := &GitHandler{
		selectionStore: newGitSelectionStore(nil),
	}
	if db != nil {
		h.settings = settings.New(db)
		h.selectionStore = newGitSelectionStore(kv.New(db))
	}
	return h
}

func (h *GitHandler) SetWSHandler(wsHandler *GitWSHandler) {
	h.wsHandler = wsHandler
}

func (h *GitHandler) getGitAuthor() (string, string) {
	author := ""
	email := ""
	if h.settings != nil {
		author, _ = h.settings.Get("gitUserName")
		email, _ = h.settings.Get("gitUserEmail")
	}
	if author == "" {
		author = defaultGitUserNameValue()
	}
	if email == "" {
		email = defaultGitUserEmailValue()
	}
	return author, email
}

func gitCommandError(err error, output []byte) error {
	msg := strings.TrimSpace(string(output))
	if msg == "" {
		msg = err.Error()
	}
	return fmt.Errorf("%s", msg)
}

func buildCommitMessageArgs(summary, description string) []string {
	args := []string{"-m", summary}
	if strings.TrimSpace(description) != "" {
		args = append(args, "-m", description)
	}
	return args
}

func buildGitScopeKey(workspaceSessionID, groupID, repoRoot string) string {
	return buildGitDraftScopeKey(workspaceSessionID, groupID, repoRoot)
}

func (h *GitHandler) commitOnlySelectedFiles(repoRoot string, files []string, summary, description, author, email string, amend bool) (string, error) {
	addArgs := append([]string{"add", "--"}, files...)
	addCmd := newGitCommand(addArgs...)
	addCmd.Dir = repoRoot
	if output, err := addCmd.CombinedOutput(); err != nil {
		return "", gitCommandError(err, output)
	}

	commitArgs := []string{"-c", "user.name=" + author, "-c", "user.email=" + email, "commit", "--only"}
	if amend {
		commitArgs = append(commitArgs, "--amend")
	}
	commitArgs = append(commitArgs, buildCommitMessageArgs(summary, description)...)
	commitArgs = append(commitArgs, "--")
	commitArgs = append(commitArgs, files...)

	commitCmd := newGitCommand(commitArgs...)
	commitCmd.Dir = repoRoot
	commitCmd.Env = append(commitCmd.Env,
		"GIT_AUTHOR_NAME="+author,
		"GIT_AUTHOR_EMAIL="+email,
		"GIT_COMMITTER_NAME="+author,
		"GIT_COMMITTER_EMAIL="+email,
	)
	if output, err := commitCmd.CombinedOutput(); err != nil {
		return "", gitCommandError(err, output)
	}

	hashCmd := newGitCommand("rev-parse", "HEAD")
	hashCmd.Dir = repoRoot
	output, err := hashCmd.Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(output)), nil
}

func (h *GitHandler) Register(r *gin.RouterGroup) {
	g := r.Group("/git")
	g.POST("/check", h.Check)
	g.POST("/init", h.Init)
	g.POST("/clone", h.Clone)
	g.POST("/status", h.Status)
	g.POST("/log", h.Log)
	g.POST("/diff", h.Diff)
	g.POST("/file-diff", h.FileDiff)
	g.POST("/show", h.Show)
	g.POST("/add", h.Add)
	g.POST("/reset", h.Reset)
	g.POST("/apply-selection", h.ApplySelection)
	g.POST("/apply-selection-batch", h.ApplySelectionBatch)
	g.GET("/draft", h.GetDraft)
	g.POST("/draft", h.UpdateDraft)
	g.POST("/checkout", h.Checkout)
	g.POST("/commit", h.Commit)
	g.POST("/undo", h.UndoCommit)
	g.POST("/branches", h.Branches)
	g.POST("/switch-branch", h.SwitchBranch)
	g.POST("/commit-files", h.CommitFiles)
	g.POST("/commit-diff", h.CommitDiff)
	g.POST("/remotes", h.Remotes)
	g.POST("/tags", h.Tags)
	g.POST("/create-tag", h.CreateTag)
	g.POST("/delete-tag", h.DeleteTag)
	g.POST("/fetch", h.Fetch)
	g.POST("/pull", h.Pull)
	g.POST("/push", h.Push)
	g.POST("/stash", h.Stash)
	g.POST("/stash-list", h.StashList)
	g.POST("/stash-files", h.StashFiles)
	g.POST("/stash-diff", h.StashDiff)
	g.POST("/stash-pop", h.StashPop)
	g.POST("/stash-drop", h.StashDrop)
	g.POST("/conflicts", h.Conflicts)
	g.POST("/conflict-details", h.ConflictDetails)
	g.POST("/conflict-resolve", h.ConflictResolve)
	g.POST("/create-branch", h.CreateBranch)
	g.POST("/delete-branch", h.DeleteBranch)
	g.POST("/add-patch", h.AddPatch)
	g.POST("/commit-selected", h.CommitSelected)
	g.POST("/amend", h.Amend)
	g.POST("/branch-status", h.BranchStatus)
	g.POST("/smart-switch-branch", h.SmartSwitchBranch)
}

func (h *GitHandler) getRepoRoot(path string) (string, error) {
	cmd := newGitCommand("rev-parse", "--show-toplevel")
	cmd.Dir = path
	output, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("not a git repository")
	}
	return strings.TrimSpace(string(output)), nil
}

// Check godoc
// @Summary Check if path is a git repository
// @Tags Git
// @Accept json
// @Produce json
// @Param request body GitPathRequest true "Repository path"
// @Success 200 {object} map[string]bool
// @Router /api/git/check [post]
func (h *GitHandler) Check(c *gin.Context) {
	var req GitPathRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	_, err := h.getRepoRoot(req.Path)
	c.JSON(http.StatusOK, gin.H{"isRepo": err == nil})
}

type GitInitRequest struct {
	Path string `json:"path" binding:"required"`
}

type GitScopeRequest struct {
	WorkspaceSessionID string `json:"workspace_session_id"`
	GroupID            string `json:"group_id"`
}

// Init godoc
// @Summary Initialize a new git repository
// @Tags Git
// @Accept json
// @Produce json
// @Param request body GitInitRequest true "Repository path"
// @Success 200 {object} map[string]bool
// @Failure 500 {object} map[string]string
// @Router /api/git/init [post]
func (h *GitHandler) Init(c *gin.Context) {
	var req GitInitRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	cmd := newGitCommand("init", req.Path)
	output, err := cmd.CombinedOutput()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gitCommandError(err, output).Error()})
		return
	}

	h.broadcastStatus(req.Path)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

type GitCloneRequest struct {
	URL  string `json:"url" binding:"required"`
	Path string `json:"path" binding:"required"`
}

// Clone godoc
// @Summary Clone a git repository
// @Tags Git
// @Accept json
// @Produce json
// @Param request body GitCloneRequest true "Clone URL and destination path"
// @Success 200 {object} map[string]bool
// @Failure 500 {object} map[string]string
// @Router /api/git/clone [post]
func (h *GitHandler) Clone(c *gin.Context) {
	var req GitCloneRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	cmd := newGitCommand("clone", req.URL, req.Path)
	output, err := cmd.CombinedOutput()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gitCommandError(err, output).Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"ok": true})
	h.broadcastStatus(req.Path)
}

type GitPathRequest struct {
	Path string `json:"path" binding:"required"`
	GitScopeRequest
}

type FileStatus struct {
	Path   string `json:"path"`
	Status string `json:"status"`
	Staged bool   `json:"staged"`
}

// Status godoc
// @Summary Get structured file status of git repository
// @Tags Git
// @Accept json
// @Produce json
// @Param request body GitPathRequest true "Repository path"
// @Success 200 {object} map[string]interface{}
// @Failure 400 {object} map[string]string
// @Router /api/git/status [post]
func (h *GitHandler) Status(c *gin.Context) {
	var req GitPathRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	repoRoot, err := h.getRepoRoot(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	scopeKey := buildGitScopeKey(req.WorkspaceSessionID, req.GroupID, repoRoot)
	files, summary := h.collectStructuredStatusWithScope(repoRoot, scopeKey)
	c.JSON(http.StatusOK, gin.H{"files": files, "summary": summary})
}

type GitLogRequest struct {
	Path  string `json:"path" binding:"required"`
	Limit int    `json:"limit"`
	Skip  int    `json:"skip"`
}

type CommitInfo struct {
	Hash        string   `json:"hash"`
	Message     string   `json:"message"`
	Author      string   `json:"author"`
	AuthorEmail string   `json:"authorEmail"`
	Date        string   `json:"date"`
	ParentCount int      `json:"parentCount"`
	Tags        []string `json:"tags"`
}

// Log godoc
// @Summary Get commit log
// @Tags Git
// @Accept json
// @Produce json
// @Param request body GitLogRequest true "Repository path and pagination"
// @Success 200 {object} map[string][]CommitInfo
// @Failure 400 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/git/log [post]
func (h *GitHandler) Log(c *gin.Context) {
	var req GitLogRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	repoRoot, err := h.getRepoRoot(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	headCmd := newGitCommand("rev-parse", "HEAD")
	headCmd.Dir = repoRoot
	if err := headCmd.Run(); err != nil {
		c.JSON(http.StatusOK, gin.H{"commits": []CommitInfo{}})
		return
	}

	limit := req.Limit
	if limit <= 0 {
		limit = 20
	}
	skip := req.Skip
	if skip < 0 {
		skip = 0
	}

	format := "%x1e%H%x00%s%x00%an%x00%ae%x00%aI%x00%P%x00%D"
	args := []string{"log", "-n", fmt.Sprintf("%d", limit),
		fmt.Sprintf("--format=%s", format)}
	if skip > 0 {
		args = append(args, fmt.Sprintf("--skip=%d", skip))
	}

	cmd := newGitCommand(args...)
	cmd.Dir = repoRoot
	output, err := cmd.Output()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	var commits []CommitInfo
	rawOutput := strings.TrimSpace(string(output))
	if rawOutput == "" {
		c.JSON(http.StatusOK, gin.H{"commits": []CommitInfo{}})
		return
	}

	entries := strings.Split(rawOutput, "\x1e")
	for _, entry := range entries {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		parts := strings.SplitN(entry, "\x00", 7)
		if len(parts) < 7 {
			continue
		}
		parentCount := 0
		if strings.TrimSpace(parts[5]) != "" {
			parentCount = len(strings.Fields(parts[5]))
		}
		commits = append(commits, CommitInfo{
			Hash:        parts[0],
			Message:     strings.TrimSpace(parts[1]),
			Author:      parts[2],
			AuthorEmail: parts[3],
			Date:        parts[4],
			ParentCount: parentCount,
			Tags:        parseGitDecorationTags(parts[6]),
		})
	}

	c.JSON(http.StatusOK, gin.H{"commits": commits})
}

type GitDiffRequest struct {
	Path     string `json:"path" binding:"required"`
	FilePath string `json:"filePath" binding:"required"`
}

// Diff godoc
// @Summary Get file diff between HEAD and working tree
// @Tags Git
// @Accept json
// @Produce json
// @Param request body GitDiffRequest true "Repository path and file path"
// @Success 200 {object} map[string]string
// @Failure 400 {object} map[string]string
// @Router /api/git/diff [post]
func (h *GitHandler) Diff(c *gin.Context) {
	var req GitDiffRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	repoRoot, err := h.getRepoRoot(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	var oldContent string
	showCmd := newGitCommand("show", "HEAD:"+req.FilePath)
	showCmd.Dir = repoRoot
	showOutput, err := showCmd.Output()
	if err == nil {
		oldContent = string(showOutput)
	}

	absPath := filepath.Join(repoRoot, req.FilePath)
	newContentBytes, err := os.ReadFile(absPath)
	if err != nil {
		newContentBytes = []byte{}
	}

	c.JSON(http.StatusOK, gin.H{
		"path": req.FilePath,
		"old":  oldContent,
		"new":  string(newContentBytes),
	})
}

type GitShowRequest struct {
	Path     string `json:"path" binding:"required"`
	FilePath string `json:"filePath" binding:"required"`
	Ref      string `json:"ref"`
}

// Show godoc
// @Summary Show file content at a specific ref
// @Tags Git
// @Accept json
// @Produce json
// @Param request body GitShowRequest true "Repository path, file path and ref"
// @Success 200 {object} map[string]string
// @Failure 400 {object} map[string]string
// @Failure 404 {object} map[string]string
// @Router /api/git/show [post]
func (h *GitHandler) Show(c *gin.Context) {
	var req GitShowRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	if req.Ref == "" {
		req.Ref = "HEAD"
	}

	repoRoot, err := h.getRepoRoot(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	verifyCmd := newGitCommand("rev-parse", "--verify", req.Ref)
	verifyCmd.Dir = repoRoot
	if err := verifyCmd.Run(); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid ref: " + err.Error()})
		return
	}

	showCmd := newGitCommand("show", req.Ref+":"+req.FilePath)
	showCmd.Dir = repoRoot
	output, err := showCmd.Output()
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "file not found"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"content": string(output)})
}

type GitFilesRequest struct {
	Path  string   `json:"path" binding:"required"`
	Files []string `json:"files" binding:"required"`
}

// Add godoc
// @Summary Stage files
// @Tags Git
// @Accept json
// @Produce json
// @Param request body GitFilesRequest true "Repository path and file list"
// @Success 200 {object} map[string]bool
// @Failure 400 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/git/add [post]
func (h *GitHandler) Add(c *gin.Context) {
	var req GitFilesRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	repoRoot, err := h.getRepoRoot(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	args := append([]string{"add", "--"}, req.Files...)
	cmd := newGitCommand(args...)
	cmd.Dir = repoRoot
	output, err := cmd.CombinedOutput()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gitCommandError(err, output).Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"ok": true})
	h.broadcastStatus(req.Path)
}

type GitResetRequest struct {
	Path  string   `json:"path" binding:"required"`
	Files []string `json:"files"`
}

// Reset godoc
// @Summary Unstage files
// @Tags Git
// @Accept json
// @Produce json
// @Param request body GitResetRequest true "Repository path and optional file list"
// @Success 200 {object} map[string]bool
// @Failure 400 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/git/reset [post]
func (h *GitHandler) Reset(c *gin.Context) {
	var req GitResetRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	repoRoot, err := h.getRepoRoot(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	args := []string{"reset", "HEAD"}
	if len(req.Files) > 0 {
		args = append(args, "--")
		args = append(args, req.Files...)
	}
	cmd := newGitCommand(args...)
	cmd.Dir = repoRoot
	output, err := cmd.CombinedOutput()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gitCommandError(err, output).Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// Checkout godoc
// @Summary Discard working tree changes for specified files
// @Tags Git
// @Accept json
// @Produce json
// @Param request body GitFilesRequest true "Repository path and file list"
// @Success 200 {object} map[string]interface{}
// @Failure 400 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/git/checkout [post]
func (h *GitHandler) Checkout(c *gin.Context) {
	var req GitFilesRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	repoRoot, err := h.getRepoRoot(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	for _, p := range req.Files {
		checkCmd := newGitCommand("ls-files", "--error-unmatch", p)
		checkCmd.Dir = repoRoot
		if err := checkCmd.Run(); err != nil {
			absP := filepath.Join(repoRoot, p)
			if _, e := os.Stat(absP); e == nil {
				os.Remove(absP)
			}
			continue
		}

		restoreCmd := newGitCommand("checkout", "--", p)
		restoreCmd.Dir = repoRoot
		if output, err := restoreCmd.CombinedOutput(); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": gitCommandError(err, output).Error()})
			return
		}
	}

	checkoutFiles := collectFileStatus(repoRoot)
	h.broadcastStatus(req.Path)
	h.broadcastRepoSyncNeeded(req.Path, gin.H{"conflicts": true})
	c.JSON(http.StatusOK, gin.H{"ok": true, "status": gin.H{"files": checkoutFiles}})
}

type GitCommitRequest struct {
	Path    string `json:"path" binding:"required"`
	Message string `json:"message" binding:"required"`
	Author  string `json:"author"`
	Email   string `json:"email"`
}

// Commit godoc
// @Summary Create a git commit
// @Tags Git
// @Accept json
// @Produce json
// @Param request body GitCommitRequest true "Repository path, message, and author info"
// @Success 200 {object} map[string]interface{}
// @Failure 400 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/git/commit [post]
func (h *GitHandler) Commit(c *gin.Context) {
	var req GitCommitRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	repoRoot, err := h.getRepoRoot(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	author, email := h.getGitAuthor()
	if req.Author != "" {
		author = req.Author
	}
	if req.Email != "" {
		email = req.Email
	}

	commitCmd := newGitCommand("-c", "user.name="+author, "-c", "user.email="+email,
		"commit", "-m", req.Message)
	commitCmd.Dir = repoRoot
	commitCmd.Env = append(commitCmd.Env,
		"GIT_AUTHOR_NAME="+author,
		"GIT_AUTHOR_EMAIL="+email,
		"GIT_COMMITTER_NAME="+author,
		"GIT_COMMITTER_EMAIL="+email,
	)
	output, err := commitCmd.CombinedOutput()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gitCommandError(err, output).Error()})
		return
	}

	hashCmd := newGitCommand("rev-parse", "HEAD")
	hashCmd.Dir = repoRoot
	hashOut, _ := hashCmd.Output()

	h.broadcastStatus(req.Path)
	h.broadcastBranchStatus(req.Path)
	h.broadcastRepoSyncNeeded(req.Path, gin.H{"history": true, "conflicts": true})
	c.JSON(http.StatusOK, gin.H{"ok": true, "hash": strings.TrimSpace(string(hashOut))})
}

// UndoCommit godoc
// @Summary Undo the last commit (soft reset)
// @Tags Git
// @Accept json
// @Produce json
// @Param request body GitPathRequest true "Repository path"
// @Success 200 {object} map[string]interface{}
// @Failure 400 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/git/undo [post]
func (h *GitHandler) UndoCommit(c *gin.Context) {
	var req GitPathRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	repoRoot, err := h.getRepoRoot(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	parentCmd := newGitCommand("rev-parse", "HEAD~1")
	parentCmd.Dir = repoRoot
	if err := parentCmd.Run(); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "initial commit cannot be undone"})
		return
	}

	resetCmd := newGitCommand("reset", "--soft", "HEAD~1")
	resetCmd.Dir = repoRoot
	output, err := resetCmd.CombinedOutput()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gitCommandError(err, output).Error()})
		return
	}

	undoFiles := collectFileStatus(repoRoot)
	undoCommits := collectCommitLog(repoRoot, 20)
	h.broadcastStatus(req.Path)
	h.broadcastBranchStatus(req.Path)
	h.broadcastRepoSyncNeeded(req.Path, gin.H{"history": true, "conflicts": true})
	c.JSON(http.StatusOK, gin.H{"ok": true, "status": gin.H{"files": undoFiles}, "commits": undoCommits})
}

type CommitSelectedRequest struct {
	Path        string            `json:"path" binding:"required"`
	Files       []string          `json:"files"`
	Patches     []GitPatchPayload `json:"patches"`
	Summary     string            `json:"summary" binding:"required"`
	Description string            `json:"description"`
	Author      string            `json:"author"`
	Email       string            `json:"email"`
	GitScopeRequest
}

type GitDraftRequest struct {
	Path        string  `json:"path" binding:"required"`
	Summary     *string `json:"summary,omitempty"`
	Description *string `json:"description,omitempty"`
	IsAmend     *bool   `json:"isAmend,omitempty"`
	GitScopeRequest
}

type GitDraftResponse struct {
	Summary     string `json:"summary"`
	Description string `json:"description"`
	IsAmend     bool   `json:"isAmend"`
}

// GetDraft godoc
// @Summary Get commit draft (summary, description, isAmend)
// @Tags Git
// @Produce json
// @Param path query string true "Repository path"
// @Param workspace_session_id query string false "Workspace session ID"
// @Param group_id query string false "Group ID"
// @Success 200 {object} GitDraftResponse
// @Failure 400 {object} map[string]string
// @Router /api/git/draft [get]
func (h *GitHandler) GetDraft(c *gin.Context) {
	path := c.Query("path")
	if path == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "path is required"})
		return
	}

	repoRoot, err := h.getRepoRoot(path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	scopeKey := buildGitScopeKey(c.Query("workspace_session_id"), c.Query("group_id"), repoRoot)
	draft, _ := h.selectionStore.getDraftFields(scopeKey)
	c.JSON(http.StatusOK, GitDraftResponse{
		Summary:     draft.Summary,
		Description: draft.Description,
		IsAmend:     draft.IsAmend,
	})
}

// UpdateDraft godoc
// @Summary Update commit draft fields
// @Tags Git
// @Accept json
// @Produce json
// @Param request body GitDraftRequest true "Draft fields to update"
// @Success 200 {object} GitDraftResponse
// @Failure 400 {object} map[string]string
// @Router /api/git/draft [post]
func (h *GitHandler) UpdateDraft(c *gin.Context) {
	var req GitDraftRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	repoRoot, err := h.getRepoRoot(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	scopeKey := buildGitScopeKey(req.WorkspaceSessionID, req.GroupID, repoRoot)
	h.selectionStore.setDraftFields(scopeKey, req.Summary, req.Description, req.IsAmend)
	draft, _ := h.selectionStore.getDraftFields(scopeKey)
	h.broadcastRepoSyncNeededScoped(req.Path, req.WorkspaceSessionID, req.GroupID, gin.H{"draft": true})
	c.JSON(http.StatusOK, GitDraftResponse{
		Summary:     draft.Summary,
		Description: draft.Description,
		IsAmend:     draft.IsAmend,
	})
}

func (h *GitHandler) buildSelectedCommitPayload(repoRoot string, scopeKey string) ([]string, []GitPatchPayload, error) {
	files, _ := h.collectStructuredStatusWithScope(repoRoot, scopeKey)
	selectedFiles := make([]string, 0)
	selectedPatches := make([]GitPatchPayload, 0)

	for _, file := range files {
		switch file.IncludedState {
		case "all":
			selectedFiles = append(selectedFiles, file.Path)
		case "partial":
			diff, err := getGitDiff(repoRoot, file.Path, "working")
			if err != nil {
				return nil, nil, err
			}

			selectionState := resolveSelectionState(h.selectionStore, scopeKey, file.Path, diff)
			patch := buildSelectionPatch(diff, getSelectedLineIDsForState(selectionState, diff))
			if patch == "" {
				continue
			}

			selectedPatches = append(selectedPatches, GitPatchPayload{
				FilePath: file.Path,
				Patch:    patch,
			})
		}
	}

	return selectedFiles, selectedPatches, nil
}

// CommitSelected godoc
// @Summary Commit only selected files and/or patches
// @Tags Git
// @Accept json
// @Produce json
// @Param request body CommitSelectedRequest true "Selected files, patches, and commit info"
// @Success 200 {object} map[string]interface{}
// @Failure 400 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/git/commit-selected [post]
func (h *GitHandler) CommitSelected(c *gin.Context) {
	var req CommitSelectedRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	repoRoot, err := h.getRepoRoot(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	scopeKey := buildGitScopeKey(req.WorkspaceSessionID, req.GroupID, repoRoot)

	author, email := h.getGitAuthor()
	if req.Author != "" {
		author = req.Author
	}
	if req.Email != "" {
		email = req.Email
	}

	filesToCommit := append([]string(nil), req.Files...)
	patchesToCommit := append([]GitPatchPayload(nil), req.Patches...)
	if len(filesToCommit) == 0 && len(patchesToCommit) == 0 {
		filesToCommit, patchesToCommit, err = h.buildSelectedCommitPayload(repoRoot, scopeKey)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
	}

	if len(filesToCommit) == 0 && len(patchesToCommit) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "no selected changes"})
		return
	}

	if len(patchesToCommit) == 0 {
		hash, err := h.commitOnlySelectedFiles(repoRoot, filesToCommit, req.Summary, req.Description, author, email, false)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		h.selectionStore.resetRepo(scopeKey)
		bs := collectBranchStatus(repoRoot)
		h.broadcastStatus(req.Path)
		h.broadcastBranchStatus(req.Path)
		h.broadcastRepoSyncNeeded(req.Path, gin.H{"history": true})
		h.broadcastRepoSyncNeededScoped(req.Path, req.WorkspaceSessionID, req.GroupID, gin.H{"draft": true})
		c.JSON(http.StatusOK, gin.H{"ok": true, "hash": hash, "branchStatus": bs})
		return
	}

	resetCmd := newGitCommand("reset", "HEAD")
	resetCmd.Dir = repoRoot
	resetCmd.Run()

	for _, file := range filesToCommit {
		addCmd := newGitCommand("add", "--", file)
		addCmd.Dir = repoRoot
		if output, err := addCmd.CombinedOutput(); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to add " + file + ": " + gitCommandError(err, output).Error()})
			return
		}
	}

	for _, patch := range patchesToCommit {
		if err := applyPatchToIndex(repoRoot, patch.Patch); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to apply patch for " + patch.FilePath + ": " + err.Error()})
			return
		}
	}

	message := req.Summary
	if req.Description != "" {
		message += "\n\n" + req.Description
	}

	commitCmd := newGitCommand("-c", "user.name="+author, "-c", "user.email="+email,
		"commit", "-m", message)
	commitCmd.Dir = repoRoot
	commitCmd.Env = append(commitCmd.Env,
		"GIT_AUTHOR_NAME="+author,
		"GIT_AUTHOR_EMAIL="+email,
		"GIT_COMMITTER_NAME="+author,
		"GIT_COMMITTER_EMAIL="+email,
	)
	commitOutput, err := commitCmd.CombinedOutput()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gitCommandError(err, commitOutput).Error()})
		return
	}

	hashCmd := newGitCommand("rev-parse", "HEAD")
	hashCmd.Dir = repoRoot
	hashOut, _ := hashCmd.Output()
	hash := strings.TrimSpace(string(hashOut))

	h.selectionStore.resetRepo(scopeKey)
	files, summary := h.collectStructuredStatusWithScope(repoRoot, scopeKey)
	commits := collectCommitLog(repoRoot, 20)
	bs := collectBranchStatus(repoRoot)
	h.broadcastStatus(req.Path)
	h.broadcastBranchStatus(req.Path)
	h.broadcastRepoSyncNeeded(req.Path, gin.H{"history": true})
	h.broadcastRepoSyncNeededScoped(req.Path, req.WorkspaceSessionID, req.GroupID, gin.H{"draft": true})

	c.JSON(http.StatusOK, gin.H{
		"ok": true, "hash": hash,
		"status": gin.H{"files": files, "summary": summary}, "commits": commits, "branchStatus": bs,
	})
}

// Amend godoc
// @Summary Amend the last commit with selected files and/or patches
// @Tags Git
// @Accept json
// @Produce json
// @Param request body CommitSelectedRequest true "Selected files, patches, and commit info"
// @Success 200 {object} map[string]interface{}
// @Failure 400 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/git/amend [post]
func (h *GitHandler) Amend(c *gin.Context) {
	var req CommitSelectedRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	repoRoot, err := h.getRepoRoot(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	scopeKey := buildGitScopeKey(req.WorkspaceSessionID, req.GroupID, repoRoot)

	author, email := h.getGitAuthor()
	if req.Author != "" {
		author = req.Author
	}
	if req.Email != "" {
		email = req.Email
	}

	filesToCommit := append([]string(nil), req.Files...)
	patchesToCommit := append([]GitPatchPayload(nil), req.Patches...)
	if len(filesToCommit) == 0 && len(patchesToCommit) == 0 {
		filesToCommit, patchesToCommit, err = h.buildSelectedCommitPayload(repoRoot, scopeKey)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
	}

	if len(filesToCommit) == 0 && len(patchesToCommit) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "no selected changes"})
		return
	}

	if len(patchesToCommit) == 0 {
		hash, err := h.commitOnlySelectedFiles(repoRoot, filesToCommit, req.Summary, req.Description, author, email, true)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		h.selectionStore.resetRepo(scopeKey)
		bs := collectBranchStatus(repoRoot)
		h.broadcastStatus(req.Path)
		h.broadcastBranchStatus(req.Path)
		h.broadcastRepoSyncNeeded(req.Path, gin.H{"history": true})
		h.broadcastRepoSyncNeededScoped(req.Path, req.WorkspaceSessionID, req.GroupID, gin.H{"draft": true})
		c.JSON(http.StatusOK, gin.H{"ok": true, "hash": hash, "branchStatus": bs})
		return
	}

	resetCmd := newGitCommand("reset", "HEAD")
	resetCmd.Dir = repoRoot
	resetCmd.Run()

	for _, file := range filesToCommit {
		addCmd := newGitCommand("add", "--", file)
		addCmd.Dir = repoRoot
		if output, err := addCmd.CombinedOutput(); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to add " + file + ": " + gitCommandError(err, output).Error()})
			return
		}
	}

	for _, patch := range patchesToCommit {
		if err := applyPatchToIndex(repoRoot, patch.Patch); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to apply patch for " + patch.FilePath + ": " + err.Error()})
			return
		}
	}

	message := req.Summary
	if req.Description != "" {
		message += "\n\n" + req.Description
	}

	commitCmd := newGitCommand("-c", "user.name="+author, "-c", "user.email="+email,
		"commit", "--amend", "-m", message)
	commitCmd.Dir = repoRoot
	commitCmd.Env = append(commitCmd.Env,
		"GIT_AUTHOR_NAME="+author,
		"GIT_AUTHOR_EMAIL="+email,
		"GIT_COMMITTER_NAME="+author,
		"GIT_COMMITTER_EMAIL="+email,
	)
	commitOutput, err := commitCmd.CombinedOutput()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gitCommandError(err, commitOutput).Error()})
		return
	}

	h.selectionStore.resetRepo(scopeKey)
	files, summary := h.collectStructuredStatusWithScope(repoRoot, scopeKey)
	commits := collectCommitLog(repoRoot, 20)
	bs := collectBranchStatus(repoRoot)
	h.broadcastStatus(req.Path)
	h.broadcastBranchStatus(req.Path)
	h.broadcastRepoSyncNeeded(req.Path, gin.H{"history": true})
	h.broadcastRepoSyncNeededScoped(req.Path, req.WorkspaceSessionID, req.GroupID, gin.H{"draft": true})

	c.JSON(http.StatusOK, gin.H{
		"ok": true, "status": gin.H{"files": files, "summary": summary}, "commits": commits, "branchStatus": bs,
	})
}

type GitCommitFilesRequest struct {
	Path   string `json:"path" binding:"required"`
	Commit string `json:"commit" binding:"required"`
}

type CommitFileInfo struct {
	Path   string `json:"path"`
	Status string `json:"status"`
}

// CommitFiles godoc
// @Summary List files changed in a specific commit
// @Tags Git
// @Accept json
// @Produce json
// @Param request body GitCommitFilesRequest true "Repository path and commit hash"
// @Success 200 {object} map[string][]CommitFileInfo
// @Failure 400 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/git/commit-files [post]
func (h *GitHandler) CommitFiles(c *gin.Context) {
	var req GitCommitFilesRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	repoRoot, err := h.getRepoRoot(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	parentCmd := newGitCommand("rev-parse", req.Commit+"^")
	parentCmd.Dir = repoRoot
	hasParent := parentCmd.Run() == nil

	var files []CommitFileInfo

	if !hasParent {
		cmd := newGitCommand("diff-tree", "--no-commit-id", "-r", "--name-status", "--root", req.Commit)
		cmd.Dir = repoRoot
		output, err := cmd.Output()
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		for _, line := range strings.Split(strings.TrimSpace(string(output)), "\n") {
			if line == "" {
				continue
			}
			parts := strings.SplitN(line, "\t", 2)
			if len(parts) < 2 {
				continue
			}
			files = append(files, CommitFileInfo{Path: parts[1], Status: parts[0]})
		}
	} else {
		cmd := newGitCommand("diff-tree", "--no-commit-id", "-r", "--name-status", req.Commit)
		cmd.Dir = repoRoot
		output, err := cmd.Output()
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		for _, line := range strings.Split(strings.TrimSpace(string(output)), "\n") {
			if line == "" {
				continue
			}
			parts := strings.SplitN(line, "\t", 2)
			if len(parts) < 2 {
				continue
			}
			files = append(files, CommitFileInfo{Path: parts[1], Status: parts[0]})
		}
	}

	sort.Slice(files, func(i, j int) bool {
		return files[i].Path < files[j].Path
	})

	c.JSON(http.StatusOK, gin.H{"files": files})
}

type GitCommitDiffRequest struct {
	Path     string `json:"path" binding:"required"`
	Commit   string `json:"commit" binding:"required"`
	FilePath string `json:"filePath" binding:"required"`
}

// CommitDiff godoc
// @Summary Get file diff for a specific commit
// @Tags Git
// @Accept json
// @Produce json
// @Param request body GitCommitDiffRequest true "Repository path, commit hash, and file path"
// @Success 200 {object} map[string]string
// @Failure 400 {object} map[string]string
// @Router /api/git/commit-diff [post]
func (h *GitHandler) CommitDiff(c *gin.Context) {
	var req GitCommitDiffRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	repoRoot, err := h.getRepoRoot(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	var oldContent, newContent string

	newCmd := newGitCommand("show", req.Commit+":"+req.FilePath)
	newCmd.Dir = repoRoot
	newOut, err := newCmd.Output()
	if err == nil {
		newContent = string(newOut)
	}

	parentCmd := newGitCommand("show", req.Commit+"^:"+req.FilePath)
	parentCmd.Dir = repoRoot
	oldOut, err := parentCmd.Output()
	if err == nil {
		oldContent = string(oldOut)
	}

	c.JSON(http.StatusOK, gin.H{
		"path": req.FilePath,
		"old":  oldContent,
		"new":  newContent,
	})
}

type RemoteInfo struct {
	Name string   `json:"name"`
	URLs []string `json:"urls"`
}

// Remotes godoc
// @Summary List remote repositories
// @Tags Git
// @Accept json
// @Produce json
// @Param request body GitPathRequest true "Repository path"
// @Success 200 {object} map[string][]RemoteInfo
// @Failure 400 {object} map[string]string
// @Router /api/git/remotes [post]
func (h *GitHandler) Remotes(c *gin.Context) {
	var req GitPathRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	repoRoot, err := h.getRepoRoot(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	result := collectRemoteInfos(repoRoot)
	c.JSON(http.StatusOK, gin.H{"remotes": result})
}

type GitTagsRequest struct {
	Path   string `json:"path" binding:"required"`
	Remote string `json:"remote"`
}

type GitTagInfo struct {
	Name   string `json:"name"`
	Commit string `json:"commit"`
	Remote bool   `json:"remote"`
}

type GitTagsSnapshot struct {
	Tags            []GitTagInfo `json:"tags"`
	TagsToPush      []string     `json:"tagsToPush"`
	TagsToPushError string       `json:"tagsToPushError,omitempty"`
}

type GitCreateTagRequest struct {
	Path   string `json:"path" binding:"required"`
	Name   string `json:"name" binding:"required"`
	Commit string `json:"commit" binding:"required"`
	Remote string `json:"remote"`
}

type GitDeleteTagRequest struct {
	Path   string `json:"path" binding:"required"`
	Name   string `json:"name" binding:"required"`
	Remote string `json:"remote"`
}

func (h *GitHandler) Tags(c *gin.Context) {
	var req GitTagsRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	repoRoot, err := h.getRepoRoot(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	remoteName := req.Remote
	if remoteName == "" {
		remoteName = "origin"
	}
	c.JSON(http.StatusOK, collectTagsSnapshot(repoRoot, remoteName))
}

func (h *GitHandler) CreateTag(c *gin.Context) {
	var req GitCreateTagRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	repoRoot, err := h.getRepoRoot(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := validateGitTagName(repoRoot, req.Name); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if strings.TrimSpace(req.Commit) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "commit is required"})
		return
	}

	cmd := newGitCommand("tag", "-a", "-m", "", req.Name, req.Commit)
	cmd.Dir = repoRoot
	output, err := cmd.CombinedOutput()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gitCommandError(err, output).Error()})
		return
	}

	remoteName := req.Remote
	if remoteName == "" {
		remoteName = "origin"
	}
	snapshot := collectTagsSnapshot(repoRoot, remoteName)
	h.broadcastRepoSyncNeeded(req.Path, gin.H{"history": true})
	c.JSON(http.StatusOK, snapshot)
}

func (h *GitHandler) DeleteTag(c *gin.Context) {
	var req GitDeleteTagRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	repoRoot, err := h.getRepoRoot(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := validateGitTagName(repoRoot, req.Name); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	remoteName := req.Remote
	if remoteName == "" {
		remoteName = "origin"
	}
	snapshot := collectTagsSnapshot(repoRoot, remoteName)
	if snapshot.TagsToPushError != "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": snapshot.TagsToPushError})
		return
	}
	canDelete := false
	for _, tag := range snapshot.Tags {
		if tag.Name == req.Name && !tag.Remote {
			canDelete = true
			break
		}
	}
	if !canDelete {
		c.JSON(http.StatusBadRequest, gin.H{"error": "cannot delete pushed tag"})
		return
	}

	cmd := newGitCommand("tag", "-d", req.Name)
	cmd.Dir = repoRoot
	output, err := cmd.CombinedOutput()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gitCommandError(err, output).Error()})
		return
	}

	nextSnapshot := collectTagsSnapshot(repoRoot, remoteName)
	h.broadcastRepoSyncNeeded(req.Path, gin.H{"history": true})
	c.JSON(http.StatusOK, nextSnapshot)
}

type GitFetchRequest struct {
	Path   string `json:"path" binding:"required"`
	Remote string `json:"remote"`
}

// Fetch godoc
// @Summary Fetch from remote
// @Tags Git
// @Accept json
// @Produce json
// @Param request body GitFetchRequest true "Repository path and optional remote name"
// @Success 200 {object} map[string]interface{}
// @Failure 400 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/git/fetch [post]
func (h *GitHandler) Fetch(c *gin.Context) {
	var req GitFetchRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	repoRoot, err := h.getRepoRoot(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	remoteName := req.Remote
	if remoteName == "" {
		remoteName = "origin"
	}

	cmd := newGitCommand("fetch", remoteName)
	cmd.Dir = repoRoot
	output, err := cmd.CombinedOutput()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gitCommandError(err, output).Error()})
		return
	}

	fetchBS := collectBranchStatus(repoRoot)
	h.broadcastBranchStatus(req.Path)
	h.broadcastRepoSyncNeeded(req.Path, gin.H{"branches": true})
	c.JSON(http.StatusOK, gin.H{"ok": true, "branchStatus": fetchBS})
}

type GitPullRequest struct {
	Path   string `json:"path" binding:"required"`
	Remote string `json:"remote"`
	Branch string `json:"branch"`
}

// Pull godoc
// @Summary Pull from remote
// @Tags Git
// @Accept json
// @Produce json
// @Param request body GitPullRequest true "Repository path, optional remote and branch"
// @Success 200 {object} map[string]interface{}
// @Failure 400 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/git/pull [post]
func (h *GitHandler) Pull(c *gin.Context) {
	var req GitPullRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	repoRoot, err := h.getRepoRoot(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	remoteName := req.Remote
	if remoteName == "" {
		remoteName = "origin"
	}

	args := []string{"pull", remoteName}
	if req.Branch != "" {
		args = append(args, req.Branch)
	}

	cmd := newGitCommand(args...)
	cmd.Dir = repoRoot
	output, err := cmd.CombinedOutput()
	if err != nil {
		errMsg := strings.TrimSpace(string(output))
		if errMsg != "" && !strings.Contains(errMsg, "Already up to date") {
			c.JSON(http.StatusInternalServerError, gin.H{"error": errMsg})
			return
		}
	}

	pullFiles := collectFileStatus(repoRoot)
	pullCommits := collectCommitLog(repoRoot, 20)
	pullConflicts := collectConflictFiles(repoRoot)
	pullBS := collectBranchStatus(repoRoot)
	h.broadcastStatus(req.Path)
	h.broadcastBranchStatus(req.Path)
	h.broadcastRepoSyncNeeded(req.Path, gin.H{"history": true, "branches": true, "conflicts": true})
	c.JSON(http.StatusOK, gin.H{
		"ok": true, "status": gin.H{"files": pullFiles},
		"commits": pullCommits, "conflicts": pullConflicts, "branchStatus": pullBS,
	})
}

type GitPushRequest struct {
	Path   string   `json:"path" binding:"required"`
	Remote string   `json:"remote"`
	Force  bool     `json:"force"`
	Tags   []string `json:"tags"`
}

// Push godoc
// @Summary Push to remote
// @Tags Git
// @Accept json
// @Produce json
// @Param request body GitPushRequest true "Repository path, optional remote and force flag"
// @Success 200 {object} map[string]interface{}
// @Failure 400 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/git/push [post]
func (h *GitHandler) Push(c *gin.Context) {
	var req GitPushRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	repoRoot, err := h.getRepoRoot(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	remoteName := req.Remote
	if remoteName == "" {
		remoteName = "origin"
	}

	branchCmd := newGitCommand("branch", "--show-current")
	branchCmd.Dir = repoRoot
	branchOutput, err := branchCmd.Output()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	currentBranch := strings.TrimSpace(string(branchOutput))
	if currentBranch == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "cannot push from detached HEAD"})
		return
	}

	upstreamBranch := ""
	upstreamCmd := newGitCommand("rev-parse", "--abbrev-ref", currentBranch+"@{upstream}")
	upstreamCmd.Dir = repoRoot
	if upstreamOutput, upstreamErr := upstreamCmd.Output(); upstreamErr == nil {
		upstreamBranch = strings.TrimSpace(string(upstreamOutput))
	}

	targetBranch := currentBranch
	if upstreamBranch != "" && strings.HasPrefix(upstreamBranch, remoteName+"/") {
		targetBranch = strings.TrimPrefix(upstreamBranch, remoteName+"/")
	}

	args := []string{"push"}
	if req.Force {
		args = append(args, "--force")
	}
	if upstreamBranch == "" {
		args = append(args, "--set-upstream")
	}
	args = append(args, remoteName, "HEAD:refs/heads/"+targetBranch)
	for _, tag := range uniqueNonEmptyStrings(req.Tags) {
		if err := validateGitTagName(repoRoot, tag); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		args = append(args, "refs/tags/"+tag+":refs/tags/"+tag)
	}

	cmd := newGitCommand(args...)
	cmd.Dir = repoRoot
	output, err := cmd.CombinedOutput()
	if err != nil {
		errMsg := strings.TrimSpace(string(output))
		if errMsg == "" {
			errMsg = err.Error()
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": errMsg})
		return
	}

	pushBS := collectBranchStatus(repoRoot)
	h.broadcastBranchStatus(req.Path)
	h.broadcastRepoSyncNeeded(req.Path, gin.H{"branches": true})
	c.JSON(http.StatusOK, gin.H{"ok": true, "branchStatus": pushBS})
}

type GitStashRequest struct {
	Path    string   `json:"path" binding:"required"`
	Message string   `json:"message"`
	Files   []string `json:"files"`
}

// Stash godoc
// @Summary Stash working tree changes
// @Tags Git
// @Accept json
// @Produce json
// @Param request body GitStashRequest true "Repository path, optional message and files"
// @Success 200 {object} map[string]interface{}
// @Failure 400 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/git/stash [post]
func (h *GitHandler) Stash(c *gin.Context) {
	var req GitStashRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	repoRoot, err := h.getRepoRoot(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	args := []string{"stash", "push", "--include-untracked"}
	if req.Message != "" {
		args = append(args, "-m", req.Message)
	}
	if len(req.Files) > 0 {
		args = append(args, "--")
		args = append(args, req.Files...)
	}

	cmd := newGitCommand(args...)
	cmd.Dir = repoRoot
	output, err := cmd.CombinedOutput()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": string(output)})
		return
	}

	stashResult := gin.H{"ok": true, "message": strings.TrimSpace(string(output))}
	stashResult["status"] = gin.H{"files": collectFileStatus(repoRoot)}
	h.broadcastStatus(req.Path)
	h.broadcastRepoSyncNeeded(req.Path, gin.H{"stashes": true, "conflicts": true})
	c.JSON(http.StatusOK, stashResult)
}

type StashEntry struct {
	Index   int    `json:"index"`
	Message string `json:"message"`
}

// StashList godoc
// @Summary List stash entries
// @Tags Git
// @Accept json
// @Produce json
// @Param request body GitPathRequest true "Repository path"
// @Success 200 {object} map[string][]StashEntry
// @Failure 400 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/git/stash-list [post]
func (h *GitHandler) StashList(c *gin.Context) {
	var req GitPathRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	repoRoot, err := h.getRepoRoot(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	cmd := newGitCommand("stash", "list")
	cmd.Dir = repoRoot
	output, err := cmd.CombinedOutput()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": string(output)})
		return
	}

	var entries []StashEntry
	lines := strings.Split(strings.TrimSpace(string(output)), "\n")
	for i, line := range lines {
		if line == "" {
			continue
		}
		entries = append(entries, StashEntry{
			Index:   i,
			Message: line,
		})
	}

	c.JSON(http.StatusOK, gin.H{"stashes": entries})
}

type GitStashIndexRequest struct {
	Path  string `json:"path" binding:"required"`
	Index int    `json:"index"`
}

// StashPop godoc
// @Summary Apply and remove a stash entry
// @Tags Git
// @Accept json
// @Produce json
// @Param request body GitStashIndexRequest true "Repository path and stash index"
// @Success 200 {object} map[string]interface{}
// @Failure 400 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/git/stash-pop [post]
func (h *GitHandler) StashPop(c *gin.Context) {
	var req GitStashIndexRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	repoRoot, err := h.getRepoRoot(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	args := []string{"stash", "pop"}
	if req.Index > 0 {
		args = append(args, fmt.Sprintf("stash@{%d}", req.Index))
	}

	cmd := newGitCommand(args...)
	cmd.Dir = repoRoot
	output, err := cmd.CombinedOutput()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": string(output)})
		return
	}

	popResult := gin.H{"ok": true}
	popResult["status"] = gin.H{"files": collectFileStatus(repoRoot)}
	h.broadcastStatus(req.Path)
	h.broadcastRepoSyncNeeded(req.Path, gin.H{"stashes": true, "conflicts": true})
	c.JSON(http.StatusOK, popResult)
}

// StashDrop godoc
// @Summary Remove a stash entry without applying
// @Tags Git
// @Accept json
// @Produce json
// @Param request body GitStashIndexRequest true "Repository path and stash index"
// @Success 200 {object} map[string]bool
// @Failure 400 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/git/stash-drop [post]
func (h *GitHandler) StashDrop(c *gin.Context) {
	var req GitStashIndexRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	repoRoot, err := h.getRepoRoot(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	args := []string{"stash", "drop"}
	if req.Index > 0 {
		args = append(args, fmt.Sprintf("stash@{%d}", req.Index))
	}

	cmd := newGitCommand(args...)
	cmd.Dir = repoRoot
	output, err := cmd.CombinedOutput()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": string(output)})
		return
	}

	h.broadcastRepoSyncNeeded(req.Path, gin.H{"stashes": true})
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// Conflicts godoc
// @Summary List conflicted files
// @Tags Git
// @Accept json
// @Produce json
// @Param request body GitPathRequest true "Repository path"
// @Success 200 {object} map[string][]string
// @Failure 400 {object} map[string]string
// @Router /api/git/conflicts [post]
func (h *GitHandler) Conflicts(c *gin.Context) {
	var req GitPathRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	repoRoot, err := h.getRepoRoot(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	conflicts := collectConflictFiles(repoRoot)
	sort.Strings(conflicts)
	c.JSON(http.StatusOK, gin.H{"conflicts": conflicts})
}

type GitResolveConflictRequest struct {
	Path     string `json:"path" binding:"required"`
	FilePath string `json:"filePath" binding:"required"`
	Content  string `json:"content" binding:"required"`
}

// ResolveConflict godoc
// @Summary Resolve a merge conflict by writing content and staging
// @Tags Git
// @Accept json
// @Produce json
// @Param request body GitResolveConflictRequest true "Repository path, file path, and resolved content"
// @Success 200 {object} map[string]bool
// @Failure 400 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/git/resolve-conflict [post]
func (h *GitHandler) ResolveConflict(c *gin.Context) {
	var req GitResolveConflictRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	repoRoot, err := h.getRepoRoot(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	absPath := filepath.Join(repoRoot, req.FilePath)
	if err := os.WriteFile(absPath, []byte(req.Content), 0644); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	addCmd := newGitCommand("add", "--", req.FilePath)
	addCmd.Dir = repoRoot
	output, err := addCmd.CombinedOutput()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gitCommandError(err, output).Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"ok": true})
}

type GitAddPatchRequest struct {
	Path     string `json:"path" binding:"required"`
	FilePath string `json:"filePath" binding:"required"`
	Patch    string `json:"patch" binding:"required"`
}

type GitPatchPayload struct {
	FilePath string `json:"filePath" binding:"required"`
	Patch    string `json:"patch" binding:"required"`
}

func applyGitPatch(repoRoot string, patch string, cached bool, reverse bool) error {
	args := []string{"apply"}
	if cached {
		args = append(args, "--cached")
	}
	if reverse {
		args = append(args, "-R")
	}
	args = append(args, "--unidiff-zero", "--whitespace=nowarn", "-")

	cmd := newGitCommand(args...)
	cmd.Dir = repoRoot
	cmd.Stdin = strings.NewReader(patch)
	output, err := cmd.CombinedOutput()
	if err != nil {
		message := strings.TrimSpace(string(output))
		if message == "" {
			message = err.Error()
		}
		return fmt.Errorf("%s", message)
	}
	return nil
}

func applyPatchToIndex(repoRoot string, patch string) error {
	return applyGitPatch(repoRoot, patch, true, false)
}

// AddPatch godoc
// @Summary Apply a patch to the staging area
// @Tags Git
// @Accept json
// @Produce json
// @Param request body GitAddPatchRequest true "Repository path, file path, and patch content"
// @Success 200 {object} map[string]bool
// @Failure 400 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/git/add-patch [post]
func (h *GitHandler) AddPatch(c *gin.Context) {
	var req GitAddPatchRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	repoRoot, err := h.getRepoRoot(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	if err := applyPatchToIndex(repoRoot, req.Patch); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	h.broadcastStatus(req.Path)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}
