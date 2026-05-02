package handler

import (
	"bytes"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
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

// discardGitPath restores a tracked path from HEAD, or removes an untracked
// path (including a directory collapsed by Git's default status output). The
// caller must validate filePath before invoking this helper.
func discardGitPath(repoRoot, filePath string) error {
	state, err := inspectDiscardGitPath(repoRoot, filePath, false)
	if err != nil {
		return err
	}
	if state.indexExact {
		restoreCmd := newGitCommand("checkout", "--", state.gitPath)
		restoreCmd.Dir = repoRoot
		output, restoreErr := restoreCmd.CombinedOutput()
		if restoreErr != nil {
			return gitCommandError(restoreErr, output)
		}
		return nil
	}

	// `--error-unmatch` should only return success with at least one record,
	// but keep the fallback safe if Git ever violates that assumption.
	if !state.pathExists {
		return nil
	}
	return os.RemoveAll(state.absPath)
}

type discardGitPathState struct {
	absPath    string
	gitPath    string
	pathExists bool
	indexExact bool
	descendant bool
}

// inspectDiscardGitPath performs all checks that must happen before a discard
// mutates either the index or working tree. includeHead is used by staged
// discard so a directory containing a staged deletion is rejected as well.
func inspectDiscardGitPath(repoRoot, filePath string, includeHead bool) (discardGitPathState, error) {
	if isGitMetadataPath(filePath) {
		return discardGitPathState{}, fmt.Errorf("cannot discard Git metadata: %s", filePath)
	}
	cleanPath := filepath.Clean(filepath.FromSlash(filePath))
	gitPath := filepath.ToSlash(cleanPath)
	absPath := filepath.Join(repoRoot, cleanPath)
	if err := rejectDiscardSymlinkAncestor(repoRoot, absPath); err != nil {
		return discardGitPathState{}, err
	}
	_, statErr := os.Lstat(absPath)
	pathExists := statErr == nil
	if statErr != nil && !os.IsNotExist(statErr) {
		return discardGitPathState{}, statErr
	}

	indexMatches, err := discardGitPathMatches(repoRoot, "ls-files", "--error-unmatch", "-z", "--", gitPath)
	if err != nil {
		return discardGitPathState{}, err
	}
	allMatches := indexMatches
	if includeHead {
		// An unborn repository has no HEAD object. Staged additions are still
		// discardable there, so treat the missing HEAD as an empty tree.
		headExistsCmd := newGitCommand("rev-parse", "--verify", "HEAD")
		headExistsCmd.Dir = repoRoot
		if _, headErr := headExistsCmd.Output(); headErr == nil {
			headMatches, treeErr := discardGitPathMatches(repoRoot, "ls-tree", "-r", "--name-only", "-z", "HEAD", "--", gitPath)
			if treeErr != nil {
				return discardGitPathState{}, treeErr
			}
			allMatches = append(allMatches, headMatches...)
		}
	}

	state := discardGitPathState{
		absPath:    absPath,
		gitPath:    gitPath,
		pathExists: pathExists,
	}
	for _, record := range allMatches {
		matchedPath := filepath.ToSlash(filepath.Clean(filepath.FromSlash(record)))
		if matchedPath == gitPath {
			if len(indexMatches) > 0 {
				for _, indexRecord := range indexMatches {
					if filepath.ToSlash(filepath.Clean(filepath.FromSlash(indexRecord))) == gitPath {
						state.indexExact = true
						break
					}
				}
			}
			continue
		}
		state.descendant = true
	}
	if state.descendant {
		return discardGitPathState{}, fmt.Errorf("cannot discard directory containing tracked files: %s", filePath)
	}
	return state, nil
}

func discardGitPathMatches(repoRoot string, args ...string) ([]string, error) {
	cmd := newGitCommand(args...)
	cmd.Dir = repoRoot
	output, err := cmd.Output()
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) && exitErr.ExitCode() == 1 {
			return nil, nil
		}
		return nil, gitCommandError(err, nil)
	}
	parts := bytes.Split(output, []byte{0})
	matches := make([]string, 0, len(parts))
	for _, part := range parts {
		if len(part) > 0 {
			matches = append(matches, string(part))
		}
	}
	return matches, nil
}

// discardStagedGitPath drops both the index and worktree version of a file.
// The preflight is deliberately separate so rejected directories and aliases
// cannot leave the index partially reset.
func discardStagedGitPath(repoRoot, filePath string) error {
	state, err := inspectDiscardGitPath(repoRoot, filePath, true)
	if err != nil {
		return err
	}
	resetCmd := newGitCommand("reset", "HEAD", "--", state.gitPath)
	resetCmd.Dir = repoRoot
	if output, err := resetCmd.CombinedOutput(); err != nil {
		return gitCommandError(err, output)
	}
	return discardGitPath(repoRoot, filePath)
}

// rejectDiscardSymlinkAncestor keeps the filesystem fallback tied to the
// repository-relative path Git inspected. A symlink in a parent component can
// otherwise make RemoveAll follow an alias into tracked content or .git.
func rejectDiscardSymlinkAncestor(repoRoot, absPath string) error {
	rel, err := filepath.Rel(repoRoot, absPath)
	if err != nil || filepath.IsAbs(rel) || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return fmt.Errorf("file path escapes repository")
	}
	current := repoRoot
	parts := strings.Split(rel, string(filepath.Separator))
	for i, part := range parts {
		if part == "" || part == "." {
			continue
		}
		candidate := filepath.Join(current, part)
		info, statErr := os.Lstat(candidate)
		if statErr != nil {
			if os.IsNotExist(statErr) {
				return nil
			}
			return statErr
		}
		if i < len(parts)-1 && info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("cannot discard path through symbolic link: %s", filepath.ToSlash(rel))
		}
		current = candidate
	}
	return nil
}

// rejectGitWritePath prevents conflict-resolution writes from modifying Git's
// control data or following a symlink at any path component.
func rejectGitWritePath(repoRoot, filePath string) error {
	if isGitMetadataPath(filePath) {
		return fmt.Errorf("cannot modify Git metadata path: %s", filePath)
	}
	cleanPath := filepath.Clean(filepath.FromSlash(filePath))
	absPath := filepath.Join(repoRoot, cleanPath)
	rel, err := filepath.Rel(repoRoot, absPath)
	if err != nil || filepath.IsAbs(rel) || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return fmt.Errorf("file path escapes repository")
	}
	current := repoRoot
	for _, part := range strings.Split(rel, string(filepath.Separator)) {
		if part == "" || part == "." {
			continue
		}
		candidate := filepath.Join(current, part)
		info, statErr := os.Lstat(candidate)
		if statErr != nil {
			if os.IsNotExist(statErr) {
				return nil
			}
			return statErr
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("cannot modify path through symbolic link: %s", filepath.ToSlash(rel))
		}
		current = candidate
	}
	return nil
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

func (h *GitHandler) commitOnlySelectedFiles(repoRoot string, files []string, summary, description, author, email string, amend, noVerify, signOff, allowEmpty bool) (string, error) {
	if err := validateRepoRelativePaths(repoRoot, files); err != nil {
		return "", err
	}
	snapshot, err := captureGitIndex(repoRoot)
	if err != nil {
		return "", err
	}
	restoreOnError := func(operationErr error) (string, error) {
		if restoreErr := snapshot.restore(); restoreErr != nil {
			return "", fmt.Errorf("%v; additionally failed to restore git index: %w", operationErr, restoreErr)
		}
		return "", operationErr
	}

	addArgs := append([]string{"add", "--"}, files...)
	addCmd := newGitCommand(addArgs...)
	addCmd.Dir = repoRoot
	if output, addErr := addCmd.CombinedOutput(); addErr != nil {
		return restoreOnError(gitCommandError(addErr, output))
	}

	commitArgs := []string{"-c", "user.name=" + author, "-c", "user.email=" + email, "commit", "--only"}
	if amend {
		commitArgs = append(commitArgs, "--amend")
	}
	if noVerify {
		commitArgs = append(commitArgs, "--no-verify")
	}
	if signOff {
		commitArgs = append(commitArgs, "--signoff")
	}
	if allowEmpty {
		commitArgs = append(commitArgs, "--allow-empty")
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
	if output, commitErr := commitCmd.CombinedOutput(); commitErr != nil {
		return restoreOnError(gitCommandError(commitErr, output))
	}

	hashCmd := newGitCommand("rev-parse", "HEAD")
	hashCmd.Dir = repoRoot
	output, hashErr := hashCmd.Output()
	if hashErr != nil {
		return restoreOnError(hashErr)
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
	g.POST("/reflog", h.Reflog)
	g.POST("/recent-branches", h.RecentBranches)
	g.POST("/unreachable-commits", h.UnreachableCommits)
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
	g.POST("/checkout-remote-branch", h.CheckoutRemoteBranch)
	g.POST("/switch-remote-branch", h.CheckoutRemoteBranch)
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
	// Keep the legacy conflict resolver available for clients that still send
	// the original endpoint shape.
	g.POST("/resolve-conflict", h.ResolveConflict)
	g.POST("/create-branch", h.CreateBranch)
	g.POST("/delete-branch", h.DeleteBranch)
	g.POST("/rename-branch", h.RenameBranch)
	g.POST("/delete-remote-branch", h.DeleteRemoteBranch)
	// Keep the short route as a compatibility alias for clients that expose
	// the operation simply as "prune" in their branch menu.
	g.POST("/prune-remote", h.PruneRemote)
	g.POST("/prune", h.PruneRemote)
	g.POST("/add-patch", h.AddPatch)
	g.POST("/commit-selected", h.CommitSelected)
	g.POST("/amend", h.Amend)
	g.POST("/branch-status", h.BranchStatus)
	g.POST("/smart-switch-branch", h.SmartSwitchBranch)
	h.RegisterGitOperationRoutes(r)
	h.RegisterRepositoryRoutes(r)
	h.RegisterSubmoduleRoutes(r)
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
	if err := validateGitInitCloneArgument(req.Path, "path"); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	unlockRepo := lockGitOperationRepo(gitOperationLockPathForMutation(req.Path))
	defer unlockRepo()

	cmd := newGitCommand("init", "--", req.Path)
	output, err := cmd.CombinedOutput()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gitCommandError(err, output).Error()})
		return
	}

	unlockRepo()
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
	if err := validateGitInitCloneArgument(req.URL, "url"); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := validateGitInitCloneArgument(req.Path, "path"); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	unlockRepo := lockGitOperationRepo(gitOperationLockPathForMutation(req.Path))
	defer unlockRepo()

	cmd := newGitCommand("clone", "--", req.URL, req.Path)
	cleanupAskPass := h.configureGitHubAskPass(cmd, req.URL)
	defer cleanupAskPass()
	output, err := cmd.CombinedOutput()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gitCommandError(err, output).Error()})
		return
	}
	_ = h.autoUpdateGitSubmodules(req.Path)

	unlockRepo()
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
	if err := validateRepoRelativePath(repoRoot, req.FilePath); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	previewLimit := gitDiffPreviewLimitForPath(req.FilePath)
	oldPreview, _ := readGitObjectPreviewWithLimit(repoRoot, "HEAD:"+req.FilePath, previewLimit)
	newPreview, _ := readWorkingGitPreviewWithLimit(filepath.Join(repoRoot, req.FilePath), previewLimit)
	binary := oldPreview.binary || newPreview.binary
	imagePreview := buildGitImagePreview(req.FilePath, oldPreview, newPreview)

	c.JSON(http.StatusOK, gin.H{
		"path":         req.FilePath,
		"old":          gitPreviewText(oldPreview),
		"new":          gitPreviewText(newPreview),
		"oldSize":      oldPreview.size,
		"newSize":      newPreview.size,
		"oldBinary":    oldPreview.binary,
		"newBinary":    newPreview.binary,
		"oldTruncated": oldPreview.truncated,
		"newTruncated": newPreview.truncated,
		"binary":       binary,
		"large":        oldPreview.truncated || newPreview.truncated,
		"image":        imagePreview.response(),
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
	if err := validateRepoRelativePath(repoRoot, req.FilePath); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	ref, err := resolveGitCommitRef(repoRoot, req.Ref, "ref")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	preview, err := readGitObjectPreview(repoRoot, ref+":"+req.FilePath)
	if err != nil || !preview.exists {
		c.JSON(http.StatusNotFound, gin.H{"error": "file not found"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"content":   gitPreviewText(preview),
		"size":      preview.size,
		"binary":    preview.binary,
		"truncated": preview.truncated,
	})
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
	unlockRepo := lockGitOperationRepo(repoRoot)
	defer unlockRepo()
	if err := validateRepoRelativePaths(repoRoot, req.Files); err != nil {
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

	unlockRepo()
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
	unlockRepo := lockGitOperationRepo(repoRoot)
	defer unlockRepo()
	if err := validateRepoRelativePaths(repoRoot, req.Files); err != nil {
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

	unlockRepo()
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
	unlockRepo := lockGitOperationRepo(repoRoot)
	defer unlockRepo()
	if err := validateRepoRelativePaths(repoRoot, req.Files); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	for _, p := range req.Files {
		if err := discardGitPath(repoRoot, p); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
	}

	_ = h.autoUpdateGitSubmodules(repoRoot)
	checkoutFiles := collectFileStatus(repoRoot)
	unlockRepo()
	h.broadcastStatus(req.Path)
	h.broadcastRepoSyncNeeded(req.Path, gin.H{"conflicts": true})
	c.JSON(http.StatusOK, gin.H{"ok": true, "status": gin.H{"files": checkoutFiles}})
}

type GitCommitRequest struct {
	Path       string `json:"path" binding:"required"`
	Message    string `json:"message" binding:"required"`
	Author     string `json:"author"`
	Email      string `json:"email"`
	NoVerify   bool   `json:"noVerify"`
	SignOff    bool   `json:"signOff"`
	AllowEmpty bool   `json:"allowEmpty"`
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
	unlockRepo := lockGitOperationRepo(repoRoot)
	defer unlockRepo()

	author, email := h.getGitAuthor()
	if req.Author != "" {
		author = req.Author
	}
	if req.Email != "" {
		email = req.Email
	}

	commitCmd := newGitCommand("-c", "user.name="+author, "-c", "user.email="+email,
		"commit", "-m", req.Message)
	if req.NoVerify {
		commitCmd.Args = append(commitCmd.Args, "--no-verify")
	}
	if req.SignOff {
		commitCmd.Args = append(commitCmd.Args, "--signoff")
	}
	if req.AllowEmpty {
		commitCmd.Args = append(commitCmd.Args, "--allow-empty")
	}
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

	unlockRepo()
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
	unlockRepo := lockGitOperationRepo(repoRoot)
	defer unlockRepo()

	// GitHub Desktop also supports undoing the initial commit. In that case
	// there is no parent to soft-reset to: remove the current branch ref,
	// restore files deleted in the working tree, and leave all content unstaged
	// in the now-unborn repository.
	parentsCmd := newGitCommand("rev-list", "--parents", "-n", "1", "HEAD")
	parentsCmd.Dir = repoRoot
	parentsOutput, parentsErr := parentsCmd.Output()
	if parentsErr != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "repository has no commit to undo"})
		return
	}
	parentFields := strings.Fields(string(parentsOutput))
	if len(parentFields) <= 1 {
		if err := undoInitialGitCommit(repoRoot); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": gitCommandError(err, nil).Error()})
			return
		}
	} else {
		resetCmd := newGitCommand("reset", "--soft", "HEAD~1")
		resetCmd.Dir = repoRoot
		output, err := resetCmd.CombinedOutput()
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": gitCommandError(err, output).Error()})
			return
		}
	}

	undoFiles := collectFileStatus(repoRoot)
	undoCommits := collectCommitLog(repoRoot, 20)
	unlockRepo()
	h.broadcastStatus(req.Path)
	h.broadcastBranchStatus(req.Path)
	h.broadcastRepoSyncNeeded(req.Path, gin.H{"history": true, "conflicts": true})
	c.JSON(http.StatusOK, gin.H{"ok": true, "status": gin.H{"files": undoFiles}, "commits": undoCommits})
}

// undoInitialGitCommit makes the current branch unborn while preserving the
// user's working-tree changes. Git's index cannot be reset against HEAD after
// the ref is removed, so read-tree --empty is used to explicitly unstage all
// paths.
func undoInitialGitCommit(repoRoot string) error {
	deletedCmd := newGitCommand("diff", "--name-only", "-z", "--diff-filter=D", "HEAD", "--")
	deletedCmd.Dir = repoRoot
	deletedOutput, err := deletedCmd.Output()
	if err != nil {
		return err
	}
	deletedPaths := make([]string, 0)
	for _, raw := range strings.Split(string(deletedOutput), "\x00") {
		if raw != "" {
			deletedPaths = append(deletedPaths, raw)
		}
	}
	if len(deletedPaths) > 0 {
		restoreArgs := append([]string{"restore", "--source=HEAD", "--worktree", "--"}, deletedPaths...)
		restoreCmd := newGitCommand(restoreArgs...)
		restoreCmd.Dir = repoRoot
		if output, restoreErr := restoreCmd.CombinedOutput(); restoreErr != nil {
			return gitCommandError(restoreErr, output)
		}
	}

	refCmd := newGitCommand("symbolic-ref", "--quiet", "HEAD")
	refCmd.Dir = repoRoot
	refOutput, refErr := refCmd.Output()
	if refErr != nil {
		// Detached HEAD is unusual for an initial commit, but deleting HEAD is
		// still the least surprising equivalent of the desktop operation.
		refOutput = []byte("HEAD")
	}
	ref := strings.TrimSpace(string(refOutput))
	if ref == "" {
		ref = "HEAD"
	}
	deleteRefCmd := newGitCommand("update-ref", "-d", ref)
	deleteRefCmd.Dir = repoRoot
	if output, deleteErr := deleteRefCmd.CombinedOutput(); deleteErr != nil {
		return gitCommandError(deleteErr, output)
	}
	clearIndexCmd := newGitCommand("read-tree", "--empty")
	clearIndexCmd.Dir = repoRoot
	if output, clearErr := clearIndexCmd.CombinedOutput(); clearErr != nil {
		return gitCommandError(clearErr, output)
	}
	return nil
}

type CommitSelectedRequest struct {
	Path        string            `json:"path" binding:"required"`
	Files       []string          `json:"files"`
	Patches     []GitPatchPayload `json:"patches"`
	Summary     string            `json:"summary" binding:"required"`
	Description string            `json:"description"`
	Author      string            `json:"author"`
	Email       string            `json:"email"`
	NoVerify    bool              `json:"noVerify"`
	SignOff     bool              `json:"signOff"`
	AllowEmpty  bool              `json:"allowEmpty"`
	GitScopeRequest
}

type GitDraftRequest struct {
	Path             string  `json:"path" binding:"required"`
	Summary          *string `json:"summary,omitempty"`
	Description      *string `json:"description,omitempty"`
	IsAmend          *bool   `json:"isAmend,omitempty"`
	NoVerify         *bool   `json:"noVerify,omitempty"`
	SignOff          *bool   `json:"signOff,omitempty"`
	AllowEmpty       *bool   `json:"allowEmpty,omitempty"`
	SkipCommitHooks  *bool   `json:"skipCommitHooks,omitempty"`
	SignOffCommits   *bool   `json:"signOffCommits,omitempty"`
	AllowEmptyCommit *bool   `json:"allowEmptyCommit,omitempty"`
	GitScopeRequest
}

type GitDraftResponse struct {
	Summary          string `json:"summary"`
	Description      string `json:"description"`
	IsAmend          bool   `json:"isAmend"`
	NoVerify         bool   `json:"noVerify,omitempty"`
	SignOff          bool   `json:"signOff,omitempty"`
	AllowEmpty       bool   `json:"allowEmpty,omitempty"`
	SkipCommitHooks  bool   `json:"skipCommitHooks"`
	SignOffCommits   bool   `json:"signOffCommits"`
	AllowEmptyCommit bool   `json:"allowEmptyCommit"`
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
		Summary:          draft.Summary,
		Description:      draft.Description,
		IsAmend:          draft.IsAmend,
		NoVerify:         draft.NoVerify,
		SignOff:          draft.SignOff,
		AllowEmpty:       draft.AllowEmpty,
		SkipCommitHooks:  draft.NoVerify,
		SignOffCommits:   draft.SignOff,
		AllowEmptyCommit: draft.AllowEmpty,
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
	noVerify := req.NoVerify
	if noVerify == nil {
		noVerify = req.SkipCommitHooks
	}
	signOff := req.SignOff
	if signOff == nil {
		signOff = req.SignOffCommits
	}
	allowEmpty := req.AllowEmpty
	if allowEmpty == nil {
		allowEmpty = req.AllowEmptyCommit
	}
	h.selectionStore.setDraftFields(scopeKey, req.Summary, req.Description, req.IsAmend, noVerify, signOff, allowEmpty)
	draft, _ := h.selectionStore.getDraftFields(scopeKey)
	h.broadcastRepoSyncNeededScoped(req.Path, req.WorkspaceSessionID, req.GroupID, gin.H{"draft": true})
	c.JSON(http.StatusOK, GitDraftResponse{
		Summary:          draft.Summary,
		Description:      draft.Description,
		IsAmend:          draft.IsAmend,
		NoVerify:         draft.NoVerify,
		SignOff:          draft.SignOff,
		AllowEmpty:       draft.AllowEmpty,
		SkipCommitHooks:  draft.NoVerify,
		SignOffCommits:   draft.SignOff,
		AllowEmptyCommit: draft.AllowEmpty,
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
	unlockRepo := lockGitOperationRepo(repoRoot)
	defer unlockRepo()

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

	if len(filesToCommit) == 0 && len(patchesToCommit) == 0 && !req.AllowEmpty {
		c.JSON(http.StatusBadRequest, gin.H{"error": "no selected changes"})
		return
	}
	if err := validateRepoRelativePaths(repoRoot, filesToCommit); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := validateGitPatchPayloadPaths(repoRoot, patchesToCommit); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	if len(filesToCommit) == 0 && len(patchesToCommit) == 0 {
		hash, err := commitWithSelectedPatches(repoRoot, nil, nil,
			req.Summary, req.Description, author, email, false, req.NoVerify, req.SignOff, true)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		h.selectionStore.resetAfterCommit(scopeKey)
		bs := collectBranchStatus(repoRoot)
		unlockRepo()
		h.broadcastStatus(req.Path)
		h.broadcastBranchStatus(req.Path)
		h.broadcastRepoSyncNeeded(req.Path, gin.H{"history": true})
		h.broadcastRepoSyncNeededScoped(req.Path, req.WorkspaceSessionID, req.GroupID, gin.H{"draft": true})
		c.JSON(http.StatusOK, gin.H{"ok": true, "hash": hash, "branchStatus": bs})
		return
	}

	if len(patchesToCommit) == 0 {
		hash, err := h.commitOnlySelectedFiles(repoRoot, filesToCommit, req.Summary, req.Description, author, email, false, req.NoVerify, req.SignOff, req.AllowEmpty)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		h.selectionStore.resetAfterCommit(scopeKey)
		bs := collectBranchStatus(repoRoot)
		unlockRepo()
		h.broadcastStatus(req.Path)
		h.broadcastBranchStatus(req.Path)
		h.broadcastRepoSyncNeeded(req.Path, gin.H{"history": true})
		h.broadcastRepoSyncNeededScoped(req.Path, req.WorkspaceSessionID, req.GroupID, gin.H{"draft": true})
		c.JSON(http.StatusOK, gin.H{"ok": true, "hash": hash, "branchStatus": bs})
		return
	}

	hash, err := commitWithSelectedPatches(repoRoot, filesToCommit, patchesToCommit,
		req.Summary, req.Description, author, email, false, req.NoVerify, req.SignOff, req.AllowEmpty)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	h.selectionStore.resetAfterCommit(scopeKey)
	files, summary := h.collectStructuredStatusWithScope(repoRoot, scopeKey)
	commits := collectCommitLog(repoRoot, 20)
	bs := collectBranchStatus(repoRoot)
	unlockRepo()
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
	unlockRepo := lockGitOperationRepo(repoRoot)
	defer unlockRepo()

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

	if len(filesToCommit) == 0 && len(patchesToCommit) == 0 && !req.AllowEmpty {
		c.JSON(http.StatusBadRequest, gin.H{"error": "no selected changes"})
		return
	}
	if err := validateRepoRelativePaths(repoRoot, filesToCommit); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := validateGitPatchPayloadPaths(repoRoot, patchesToCommit); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	if len(filesToCommit) == 0 && len(patchesToCommit) == 0 {
		hash, err := commitWithSelectedPatches(repoRoot, nil, nil,
			req.Summary, req.Description, author, email, true, req.NoVerify, req.SignOff, true)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		h.selectionStore.resetAfterCommit(scopeKey)
		bs := collectBranchStatus(repoRoot)
		unlockRepo()
		h.broadcastStatus(req.Path)
		h.broadcastBranchStatus(req.Path)
		h.broadcastRepoSyncNeeded(req.Path, gin.H{"history": true})
		h.broadcastRepoSyncNeededScoped(req.Path, req.WorkspaceSessionID, req.GroupID, gin.H{"draft": true})
		c.JSON(http.StatusOK, gin.H{"ok": true, "hash": hash, "branchStatus": bs})
		return
	}

	if len(patchesToCommit) == 0 {
		hash, err := h.commitOnlySelectedFiles(repoRoot, filesToCommit, req.Summary, req.Description, author, email, true, req.NoVerify, req.SignOff, req.AllowEmpty)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		h.selectionStore.resetAfterCommit(scopeKey)
		bs := collectBranchStatus(repoRoot)
		unlockRepo()
		h.broadcastStatus(req.Path)
		h.broadcastBranchStatus(req.Path)
		h.broadcastRepoSyncNeeded(req.Path, gin.H{"history": true})
		h.broadcastRepoSyncNeededScoped(req.Path, req.WorkspaceSessionID, req.GroupID, gin.H{"draft": true})
		c.JSON(http.StatusOK, gin.H{"ok": true, "hash": hash, "branchStatus": bs})
		return
	}

	hash, err := commitWithSelectedPatches(repoRoot, filesToCommit, patchesToCommit,
		req.Summary, req.Description, author, email, true, req.NoVerify, req.SignOff, req.AllowEmpty)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	h.selectionStore.resetAfterCommit(scopeKey)
	files, summary := h.collectStructuredStatusWithScope(repoRoot, scopeKey)
	commits := collectCommitLog(repoRoot, 20)
	bs := collectBranchStatus(repoRoot)
	unlockRepo()
	h.broadcastStatus(req.Path)
	h.broadcastBranchStatus(req.Path)
	h.broadcastRepoSyncNeeded(req.Path, gin.H{"history": true})
	h.broadcastRepoSyncNeededScoped(req.Path, req.WorkspaceSessionID, req.GroupID, gin.H{"draft": true})

	c.JSON(http.StatusOK, gin.H{
		"ok": true, "hash": hash, "status": gin.H{"files": files, "summary": summary}, "commits": commits, "branchStatus": bs,
	})
}

type GitCommitFilesRequest struct {
	Path       string `json:"path" binding:"required"`
	Commit     string `json:"commit" binding:"required"`
	FromCommit string `json:"fromCommit"`
}

type CommitFileInfo struct {
	Path   string `json:"path"`
	Status string `json:"status"`
}

func gitParentOrEmptyTree(repoRoot, commit string) (string, error) {
	parentCmd := newGitCommand("rev-parse", "--verify", "--end-of-options", commit+"^")
	parentCmd.Dir = repoRoot
	if output, err := parentCmd.Output(); err == nil {
		return strings.TrimSpace(string(output)), nil
	}
	emptyTreeCmd := newGitCommand("hash-object", "-t", "tree", "--stdin")
	emptyTreeCmd.Dir = repoRoot
	emptyTreeCmd.Stdin = strings.NewReader("")
	output, err := emptyTreeCmd.Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(output)), nil
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
	commit, err := resolveGitCommitRef(repoRoot, req.Commit, "commit")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	baseCommit := ""
	if strings.TrimSpace(req.FromCommit) != "" {
		fromCommit, err := resolveGitCommitRef(repoRoot, req.FromCommit, "from commit")
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		ancestorCmd := newGitCommand("merge-base", "--is-ancestor", fromCommit, commit)
		ancestorCmd.Dir = repoRoot
		if err := ancestorCmd.Run(); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "from commit must be an ancestor of commit"})
			return
		}
		baseCommit, err = gitParentOrEmptyTree(repoRoot, fromCommit)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
	}

	parentCmd := newGitCommand("rev-parse", "--verify", "--end-of-options", commit+"^")
	parentCmd.Dir = repoRoot
	hasParent := parentCmd.Run() == nil

	var files []CommitFileInfo

	if baseCommit != "" {
		cmd := newGitCommand("diff", "--name-status", "--end-of-options", baseCommit, commit, "--")
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
	} else if !hasParent {
		cmd := newGitCommand("diff-tree", "--no-commit-id", "-r", "--name-status", "--root", "--end-of-options", commit)
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
		cmd := newGitCommand("diff-tree", "--no-commit-id", "-r", "--name-status", "--end-of-options", commit)
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
	Path       string `json:"path" binding:"required"`
	Commit     string `json:"commit" binding:"required"`
	FromCommit string `json:"fromCommit"`
	FilePath   string `json:"filePath" binding:"required"`
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
	if err := validateRepoRelativePath(repoRoot, req.FilePath); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	commit, err := resolveGitCommitRef(repoRoot, req.Commit, "commit")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	oldRef := commit + "^"
	if strings.TrimSpace(req.FromCommit) != "" {
		fromCommit, err := resolveGitCommitRef(repoRoot, req.FromCommit, "from commit")
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		ancestorCmd := newGitCommand("merge-base", "--is-ancestor", fromCommit, commit)
		ancestorCmd.Dir = repoRoot
		if err := ancestorCmd.Run(); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "from commit must be an ancestor of commit"})
			return
		}
		oldRef, err = gitParentOrEmptyTree(repoRoot, fromCommit)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
	}

	previewLimit := gitDiffPreviewLimitForPath(req.FilePath)
	newPreview, _ := readGitObjectPreviewWithLimit(repoRoot, commit+":"+req.FilePath, previewLimit)
	oldPreview, _ := readGitObjectPreviewWithLimit(repoRoot, oldRef+":"+req.FilePath, previewLimit)
	binary := oldPreview.binary || newPreview.binary
	imagePreview := buildGitImagePreview(req.FilePath, oldPreview, newPreview)

	c.JSON(http.StatusOK, gin.H{
		"path":         req.FilePath,
		"old":          gitPreviewText(oldPreview),
		"new":          gitPreviewText(newPreview),
		"oldSize":      oldPreview.size,
		"newSize":      newPreview.size,
		"oldBinary":    oldPreview.binary,
		"newBinary":    newPreview.binary,
		"oldTruncated": oldPreview.truncated,
		"newTruncated": newPreview.truncated,
		"binary":       binary,
		"large":        oldPreview.truncated || newPreview.truncated,
		"image":        imagePreview.response(),
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
	if req.Remote != "" {
		if err := validateConfiguredGitRemote(repoRoot, req.Remote); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
	}
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
	unlockRepo := lockGitOperationRepo(repoRoot)
	defer unlockRepo()
	tagName := strings.TrimSpace(req.Name)
	if err := validateGitTagName(repoRoot, tagName); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	commit, err := resolveGitCommitRef(repoRoot, req.Commit, "commit")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	remoteName := req.Remote
	if req.Remote != "" {
		if err := validateConfiguredGitRemote(repoRoot, req.Remote); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
	}
	if remoteName == "" {
		remoteName = "origin"
	}

	cmd := newGitCommand("tag", "-a", "-m", "", "--", tagName, commit)
	cmd.Dir = repoRoot
	output, err := cmd.CombinedOutput()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gitCommandError(err, output).Error()})
		return
	}

	snapshot := collectTagsSnapshot(repoRoot, remoteName)
	unlockRepo()
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
	unlockRepo := lockGitOperationRepo(repoRoot)
	defer unlockRepo()
	tagName := strings.TrimSpace(req.Name)
	if err := validateGitTagName(repoRoot, tagName); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	remoteName := req.Remote
	if req.Remote != "" {
		if err := validateConfiguredGitRemote(repoRoot, req.Remote); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
	}
	if remoteName == "" {
		remoteName = "origin"
	}
	snapshot := collectTagsSnapshot(repoRoot, remoteName)
	// A repository without a configured default remote is still allowed to
	// delete local tags. Only block deletion when the requested remote exists
	// but its tag query failed, since that is the case where we cannot tell
	// whether the tag has already been pushed.
	if snapshot.TagsToPushError != "" && hasGitRemote(repoRoot, remoteName) {
		c.JSON(http.StatusBadRequest, gin.H{"error": snapshot.TagsToPushError})
		return
	}
	canDelete := false
	for _, tag := range snapshot.Tags {
		if tag.Name == tagName && !tag.Remote {
			canDelete = true
			break
		}
	}
	if !canDelete {
		c.JSON(http.StatusBadRequest, gin.H{"error": "cannot delete pushed tag"})
		return
	}

	cmd := newGitCommand("tag", "-d", "--", tagName)
	cmd.Dir = repoRoot
	output, err := cmd.CombinedOutput()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gitCommandError(err, output).Error()})
		return
	}

	nextSnapshot := collectTagsSnapshot(repoRoot, remoteName)
	unlockRepo()
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
	unlockRepo := lockGitOperationRepo(repoRoot)
	defer unlockRepo()

	remoteName := req.Remote
	if remoteName == "" {
		remoteName = "origin"
	}
	if err := validateConfiguredGitRemote(repoRoot, remoteName); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Keep the configured top-level remote usable, including local bare remotes
	// used for offline repositories. Recursive submodule fetches run with Git's
	// non-user protocol context and remain blocked from local file URLs; the
	// explicit submodule settings action is the opt-in path for those URLs.
	cmd := newGitCommand("fetch", "--prune", "--recurse-submodules=on-demand", "--", remoteName)
	cmd.Dir = repoRoot
	cleanupAskPass := h.configureGitHubAskPass(cmd, githubRemoteURL(repoRoot, remoteName))
	defer cleanupAskPass()
	output, err := cmd.CombinedOutput()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gitCommandError(err, output).Error()})
		return
	}
	_ = h.autoUpdateGitSubmodules(repoRoot)

	fetchBS := collectBranchStatus(repoRoot)
	unlockRepo()
	h.broadcastBranchStatus(req.Path)
	h.broadcastRepoSyncNeeded(req.Path, gin.H{"branches": true})
	c.JSON(http.StatusOK, gin.H{"ok": true, "branchStatus": fetchBS})
}

type GitPullRequest struct {
	Path   string `json:"path" binding:"required"`
	Remote string `json:"remote"`
	Branch string `json:"branch"`
}

// gitPullFFConfigured reports whether the user explicitly configured
// pull.ff. Desktop supplies --ff only when that setting is absent, preserving
// an existing pull.ff=false/only preference.
func gitPullFFConfigured(repoRoot string) bool {
	cmd := newGitCommand("config", "--get", "pull.ff")
	cmd.Dir = repoRoot
	output, err := cmd.Output()
	return err == nil && strings.TrimSpace(string(output)) != ""
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
	unlockRepo := lockGitOperationRepo(repoRoot)
	defer unlockRepo()

	remoteName := req.Remote
	if remoteName == "" {
		remoteName = "origin"
	}
	if err := validateConfiguredGitRemote(repoRoot, remoteName); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	branch := ""
	if req.Branch != "" {
		branch, err = normalizeGitBranchName(repoRoot, req.Branch)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
	}

	// Keep the configured top-level remote usable while Git's recursive
	// submodule context remains unable to follow local file URLs implicitly.
	args := []string{"-c", "rebase.backend=merge", "pull"}
	if !gitPullFFConfigured(repoRoot) {
		args = append(args, "--ff")
	}
	args = append(args, "--recurse-submodules", "--", remoteName)
	if branch != "" {
		args = append(args, branch)
	}

	cmd := newGitCommand(args...)
	cmd.Dir = repoRoot
	cleanupAskPass := h.configureGitHubAskPass(cmd, githubRemoteURL(repoRoot, remoteName))
	defer cleanupAskPass()
	output, err := cmd.CombinedOutput()
	if err != nil {
		errMsg := strings.TrimSpace(string(output))
		if errMsg == "" {
			errMsg = err.Error()
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": errMsg})
		return
	}
	_ = h.autoUpdateGitSubmodules(repoRoot)

	pullFiles := collectFileStatus(repoRoot)
	pullCommits := collectCommitLog(repoRoot, 20)
	pullConflicts := collectConflictFiles(repoRoot)
	pullBS := collectBranchStatus(repoRoot)
	unlockRepo()
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
	unlockRepo := lockGitOperationRepo(repoRoot)
	defer unlockRepo()

	remoteName := req.Remote
	if remoteName == "" {
		remoteName = "origin"
	}
	if err := validateConfiguredGitRemote(repoRoot, remoteName); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
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
		args = append(args, "--force-with-lease")
	}
	if upstreamBranch == "" {
		args = append(args, "--set-upstream")
	}
	args = append(args, "--", remoteName, "HEAD:refs/heads/"+targetBranch)
	for _, tag := range uniqueNonEmptyStrings(req.Tags) {
		if err := validateGitTagName(repoRoot, tag); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		args = append(args, "refs/tags/"+tag+":refs/tags/"+tag)
	}

	cmd := newGitCommand(args...)
	cmd.Dir = repoRoot
	cleanupAskPass := h.configureGitHubAskPass(cmd, githubRemoteURL(repoRoot, remoteName))
	defer cleanupAskPass()
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
	unlockRepo()
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
	unlockRepo := lockGitOperationRepo(repoRoot)
	defer unlockRepo()
	if err := validateRepoRelativePaths(repoRoot, req.Files); err != nil {
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

	files, summary := h.collectStructuredStatus(repoRoot)
	if files == nil {
		files = []StructuredFile{}
	}
	stashResult := gin.H{"ok": true, "message": strings.TrimSpace(string(output))}
	stashResult["status"] = gin.H{"files": files, "summary": summary}
	unlockRepo()
	h.broadcastStatus(req.Path)
	h.broadcastRepoSyncNeeded(req.Path, gin.H{"stashes": true, "conflicts": true})
	c.JSON(http.StatusOK, stashResult)
}

type StashEntry struct {
	Index   int    `json:"index"`
	OID     string `json:"oid"`
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

	entries, err := loadStashEntries(repoRoot)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"stashes": entries})
}

type GitStashIndexRequest struct {
	Path  string `json:"path" binding:"required"`
	Index int    `json:"index"`
	OID   string `json:"oid"`
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
	unlockRepo := lockGitOperationRepo(repoRoot)
	defer unlockRepo()
	stashRef, _, err := resolveGitStashReference(repoRoot, req.Index, req.OID)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	cmd := newGitCommand("stash", "pop", stashRef)
	cmd.Dir = repoRoot
	output, err := cmd.CombinedOutput()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": string(output)})
		return
	}

	files, summary := h.collectStructuredStatus(repoRoot)
	if files == nil {
		files = []StructuredFile{}
	}
	popResult := gin.H{"ok": true}
	popResult["status"] = gin.H{"files": files, "summary": summary}
	unlockRepo()
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
	unlockRepo := lockGitOperationRepo(repoRoot)
	defer unlockRepo()
	stashRef, _, err := resolveGitStashReference(repoRoot, req.Index, req.OID)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	cmd := newGitCommand("stash", "drop", stashRef)
	cmd.Dir = repoRoot
	output, err := cmd.CombinedOutput()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": string(output)})
		return
	}

	unlockRepo()
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
	Path     string  `json:"path" binding:"required"`
	FilePath string  `json:"filePath" binding:"required"`
	Content  *string `json:"content" binding:"required"`
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
	if req.Content == nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "content is required"})
		return
	}

	repoRoot, err := h.getRepoRoot(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	unlockRepo := lockGitOperationRepo(repoRoot)
	defer unlockRepo()
	if err := validateRepoRelativePath(repoRoot, req.FilePath); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := rejectGitWritePath(repoRoot, req.FilePath); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	absPath := filepath.Join(repoRoot, req.FilePath)
	if err := os.WriteFile(absPath, []byte(*req.Content), 0644); err != nil {
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

	unlockRepo()
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
	unlockRepo := lockGitOperationRepo(repoRoot)
	defer unlockRepo()
	if err := validateRepoRelativePath(repoRoot, req.FilePath); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := validateGitPatchPayloadPath(repoRoot, req.FilePath, req.Patch); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	if err := applyPatchToIndex(repoRoot, req.Patch); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	unlockRepo()
	h.broadcastStatus(req.Path)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}
