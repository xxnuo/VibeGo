package handler

import (
	"errors"
	"fmt"
	"net/http"
	"os/exec"
	"sort"
	"strings"

	"github.com/gin-gonic/gin"
)

type BranchInfo struct {
	Name      string `json:"name"`
	IsCurrent bool   `json:"isCurrent"`
}

// Branches godoc
// @Summary List branches
// @Tags Git
// @Accept json
// @Produce json
// @Param request body GitPathRequest true "Repository path"
// @Success 200 {object} map[string]interface{}
// @Failure 400 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/git/branches [post]
func (h *GitHandler) Branches(c *gin.Context) {
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

	cmd := newGitCommand("branch", "--show-current")
	cmd.Dir = repoRoot
	out, err := cmd.Output()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	currentBranch := strings.TrimSpace(string(out))

	cmd = newGitCommand("for-each-ref", "--format=%(refname:strip=2)", "refs/heads")
	cmd.Dir = repoRoot
	out, err = cmd.Output()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	var branchList []BranchInfo
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if line == "" {
			continue
		}
		branchList = append(branchList, BranchInfo{
			Name:      line,
			IsCurrent: line == currentBranch,
		})
	}

	remoteBranches := collectRemoteBranches(repoRoot)
	recentBranchDetails, _ := h.collectGitRecentBranches(repoRoot, 5)
	recentBranches := make([]string, 0, len(recentBranchDetails))
	for _, branch := range recentBranchDetails {
		if branch.Exists {
			recentBranches = append(recentBranches, branch.Name)
		}
	}

	c.JSON(http.StatusOK, gin.H{
		"branches":       branchList,
		"remoteBranches": remoteBranches,
		"currentBranch":  currentBranch,
		"recentBranches": recentBranches,
	})
}

type SwitchBranchRequest struct {
	Path   string `json:"path" binding:"required"`
	Branch string `json:"branch" binding:"required"`
}

func currentGitStashOID(repoRoot string) (string, error) {
	cmd := newGitCommand("rev-parse", "--verify", "--quiet", "--end-of-options", "refs/stash")
	cmd.Dir = repoRoot
	output, err := cmd.CombinedOutput()
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) && exitErr.ExitCode() == 1 {
			return "", nil
		}
		return "", gitCommandError(err, output)
	}
	return strings.TrimSpace(string(output)), nil
}

func gitHeadHasCommit(repoRoot string) (bool, error) {
	cmd := newGitCommand("rev-parse", "--verify", "--quiet", "HEAD^{commit}")
	cmd.Dir = repoRoot
	output, err := cmd.CombinedOutput()
	if err == nil {
		return true, nil
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) && exitErr.ExitCode() == 1 {
		return false, nil
	}
	return false, gitCommandError(err, output)
}

func isCurrentUnbornBranch(repoRoot, branch string) (bool, error) {
	symbolicCmd := newGitCommand("symbolic-ref", "--quiet", "--short", "HEAD")
	symbolicCmd.Dir = repoRoot
	output, err := symbolicCmd.CombinedOutput()
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) && exitErr.ExitCode() == 1 {
			return false, nil
		}
		return false, gitCommandError(err, output)
	}
	if strings.TrimSpace(string(output)) != branch {
		return false, nil
	}
	hasCommit, err := gitHeadHasCommit(repoRoot)
	return !hasCommit, err
}

func createAutoStash(repoRoot, message string) (string, error) {
	statusCmd := newGitCommand("status", "--porcelain=v1", "-z", "--ignore-submodules=none")
	statusCmd.Dir = repoRoot
	statusOutput, err := statusCmd.Output()
	if err != nil {
		return "", err
	}
	if len(statusOutput) == 0 {
		return "", nil
	}
	hasHead, err := gitHeadHasCommit(repoRoot)
	if err != nil {
		return "", err
	}
	if !hasHead {
		// Git cannot create a stash before the first commit. Checkout itself
		// safely preserves non-conflicting staged and untracked files, and
		// rejects paths that the target branch would overwrite.
		return "", nil
	}

	beforeOID, err := currentGitStashOID(repoRoot)
	if err != nil {
		return "", err
	}
	stashCmd := newGitCommand("stash", "push", "--include-untracked", "-m", message)
	stashCmd.Dir = repoRoot
	output, err := stashCmd.CombinedOutput()
	if err != nil {
		return "", gitCommandError(err, output)
	}

	afterOID, err := currentGitStashOID(repoRoot)
	if err != nil {
		return "", err
	}
	if afterOID == "" || afterOID == beforeOID {
		return "", nil
	}
	return afterOID, nil
}

func restoreAutoStash(repoRoot, stashOID string) error {
	if stashOID == "" {
		return nil
	}

	// Some Git versions reject a raw stash commit OID here. The peeled commit
	// expression is stable and preserves the original index with --index.
	applyCmd := newGitCommand("stash", "apply", "--index", stashOID+"^{commit}")
	applyCmd.Dir = repoRoot
	output, err := applyCmd.CombinedOutput()
	if err != nil {
		return gitCommandError(err, output)
	}

	// stash drop only accepts reflog selectors. Resolve the captured OID back to
	// its current selector and verify it immediately before dropping so a newer
	// user stash remains untouched.
	entries, err := loadStashEntries(repoRoot)
	if err != nil {
		return err
	}
	stashRef := ""
	for _, entry := range entries {
		if strings.EqualFold(entry.OID, stashOID) {
			stashRef = fmt.Sprintf("stash@{%d}", entry.Index)
			break
		}
	}
	if stashRef == "" {
		return nil
	}
	verifyCmd := newGitCommand("rev-parse", "--verify", "--end-of-options", stashRef+"^{commit}")
	verifyCmd.Dir = repoRoot
	verifiedOID, err := verifyCmd.Output()
	if err != nil || !strings.EqualFold(strings.TrimSpace(string(verifiedOID)), stashOID) {
		return fmt.Errorf("auto-stash changed before cleanup")
	}
	dropCmd := newGitCommand("stash", "drop", "--quiet", stashRef)
	dropCmd.Dir = repoRoot
	output, err = dropCmd.CombinedOutput()
	if err != nil {
		return gitCommandError(err, output)
	}
	return nil
}

// SwitchBranch godoc
// @Summary Switch to a branch
// @Tags Git
// @Accept json
// @Produce json
// @Param request body SwitchBranchRequest true "Repository path and target branch"
// @Success 200 {object} map[string]interface{}
// @Failure 400 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/git/switch-branch [post]
func (h *GitHandler) SwitchBranch(c *gin.Context) {
	var req SwitchBranchRequest
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
	branch, err := normalizeGitBranchName(repoRoot, req.Branch)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	verifyCmd := newGitCommand("rev-parse", "--verify", "--end-of-options", "refs/heads/"+branch+"^{commit}")
	verifyCmd.Dir = repoRoot
	if err := verifyCmd.Run(); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "branch not found: " + branch})
		return
	}

	cmd := newGitCommand("checkout", branch)
	cmd.Dir = repoRoot
	output, err := cmd.CombinedOutput()
	if err != nil {
		errMsg := strings.TrimSpace(string(output))
		if strings.Contains(errMsg, "unstaged changes") || strings.Contains(errMsg, "would be overwritten") {
			c.JSON(http.StatusBadRequest, gin.H{"error": "cannot switch branch: you have unstaged changes"})
			return
		}
		if errMsg == "" {
			errMsg = err.Error()
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": errMsg})
		return
	}
	_ = h.autoUpdateGitSubmodules(repoRoot)

	unlockRepo()
	h.broadcastStatus(req.Path)
	h.broadcastBranchStatus(req.Path)
	h.broadcastRepoSyncNeeded(req.Path, gin.H{"history": true, "branches": true, "conflicts": true})
	c.JSON(http.StatusOK, gin.H{"ok": true, "branch": branch})
}

// SmartSwitchBranch godoc
// @Summary Switch branch with automatic stash/unstash of uncommitted changes
// @Tags Git
// @Accept json
// @Produce json
// @Param request body SwitchBranchRequest true "Repository path and target branch"
// @Success 200 {object} map[string]interface{}
// @Failure 400 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/git/smart-switch-branch [post]
func (h *GitHandler) SmartSwitchBranch(c *gin.Context) {
	var req SwitchBranchRequest
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
	branch, err := normalizeGitBranchName(repoRoot, req.Branch)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	verifyCmd := newGitCommand("rev-parse", "--verify", "--end-of-options", "refs/heads/"+branch+"^{commit}")
	verifyCmd.Dir = repoRoot
	if err := verifyCmd.Run(); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "branch not found: " + branch})
		return
	}

	stashOID, err := createAutoStash(repoRoot, "auto-stash: switching to "+branch)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "stash failed: " + err.Error()})
		return
	}
	stashed := stashOID != ""
	stashConflict := false
	stashError := ""

	cmd := newGitCommand("checkout", branch)
	cmd.Dir = repoRoot
	output, err := cmd.CombinedOutput()
	if err != nil {
		errMsg := strings.TrimSpace(string(output))
		if errMsg == "" {
			errMsg = err.Error()
		}
		stashConflict := false
		stashError := ""
		if restoreErr := restoreAutoStash(repoRoot, stashOID); restoreErr != nil {
			stashConflict = true
			stashError = restoreErr.Error()
			errMsg += "; failed to restore auto-stash: " + stashError
		}
		c.JSON(http.StatusInternalServerError, gin.H{
			"ok": false, "error": errMsg, "branch": branch,
			"stashed": stashed, "stashConflict": stashConflict, "stashError": stashError,
		})
		return
	}

	if restoreErr := restoreAutoStash(repoRoot, stashOID); restoreErr != nil {
		stashConflict = true
		stashError = restoreErr.Error()
	}
	_ = h.autoUpdateGitSubmodules(repoRoot)

	files, summary := h.collectStructuredStatus(repoRoot)
	if files == nil {
		files = []StructuredFile{}
	}
	bs := collectBranchStatus(repoRoot)

	unlockRepo()
	h.broadcastStatus(req.Path)
	h.broadcastBranchStatus(req.Path)
	h.broadcastRepoSyncNeeded(req.Path, gin.H{"history": true, "branches": true, "stashes": true, "conflicts": true})
	c.JSON(http.StatusOK, gin.H{
		"ok": true, "branch": branch,
		"stashed": stashed, "stashConflict": stashConflict,
		"stashError": stashError,
		"status":     gin.H{"files": files, "summary": summary}, "branchStatus": bs,
	})
}

// CheckoutRemoteBranch creates a local branch from a fetched remote-tracking
// ref when needed, or switches to the existing local branch when one already
// exists. It mirrors SmartSwitchBranch's include-untracked stash behavior so
// selecting a remote branch cannot silently lose work in the current tree.
func (h *GitHandler) CheckoutRemoteBranch(c *gin.Context) {
	var req CheckoutRemoteBranchRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	repoRoot, err := h.getRepoRoot(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	remote := strings.TrimSpace(req.Remote)
	branchInput := firstNonEmptyGitValue(req.RemoteBranch, req.Branch)
	// `remoteBranch` is a display-oriented alias and may contain the remote
	// prefix. The compact `branch` field is always relative to `remote`, so a
	// branch genuinely named `origin/feature` must not lose its first segment.
	displayBranchInput := strings.TrimSpace(req.RemoteBranch) != ""
	displayPrefixRemoved := false
	if remote == "" {
		remote = "origin"
		// A remote-prefixed display value is useful for callers that only have
		// the string emitted by /git/branches. Preserve the historical fallback
		// for callers that omit `remote`; explicit `remote` requests still keep
		// the compact `branch` field lossless.
		value := strings.TrimSpace(branchInput)
		if candidate, branch, ok := splitConfiguredRemoteBranch(repoRoot, value); ok {
			remote = candidate
			branchInput = branch
			displayPrefixRemoved = true
		}
	}
	if branchInput == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "remote branch is required"})
		return
	}
	if err := validateConfiguredGitRemote(repoRoot, remote); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if displayBranchInput && !displayPrefixRemoved {
		branchInput = stripRemoteBranchDisplayPrefix(remote, branchInput)
	}
	remoteBranch, err := normalizeGitRemoteBranchName(repoRoot, remote, branchInput)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	localInput := strings.TrimSpace(req.LocalBranch)
	if localInput == "" {
		localInput = remoteBranch
	}
	localBranch, err := normalizeGitBranchName(repoRoot, localInput)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	unlocksRepo := lockGitOperationRepo(repoRoot)
	defer unlocksRepo()
	remoteRef := "refs/remotes/" + remote + "/" + remoteBranch
	verifyRemote := newGitCommand("rev-parse", "--verify", "--end-of-options", remoteRef+"^{commit}")
	verifyRemote.Dir = repoRoot
	if err := verifyRemote.Run(); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "remote branch not found: " + remote + "/" + remoteBranch})
		return
	}

	stashOID, stashErr := createAutoStash(repoRoot, "auto-stash: switching to "+localBranch)
	if stashErr != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "stash failed: " + stashErr.Error()})
		return
	}
	stashed := stashOID != ""
	stashConflict := false
	stashRestoreError := ""
	restoreStash := func() {
		if restoreErr := restoreAutoStash(repoRoot, stashOID); restoreErr != nil {
			stashConflict = true
			stashRestoreError = restoreErr.Error()
		}
	}

	localExists := false
	if _, localErr := verifyLocalGitBranch(repoRoot, localBranch); localErr == nil {
		localExists = true
	}
	var checkoutCmd *exec.Cmd
	if localExists {
		checkoutCmd = newGitCommand("checkout", localBranch)
	} else {
		checkoutCmd = newGitCommand("checkout", "-b", localBranch, "--track", remoteRef)
	}
	checkoutCmd.Dir = repoRoot
	output, checkoutErr := checkoutCmd.CombinedOutput()
	if checkoutErr != nil {
		restoreStash()
		message := strings.TrimSpace(string(output))
		if message == "" {
			message = checkoutErr.Error()
		}
		if stashRestoreError != "" {
			message += "; failed to restore auto-stash: " + stashRestoreError
		}
		c.JSON(http.StatusInternalServerError, gin.H{
			"ok": false, "error": message, "branch": localBranch,
			"remote": remote, "remoteBranch": remoteBranch,
			"created": !localExists, "stashed": stashed,
			"stashConflict": stashConflict, "stashError": stashRestoreError,
		})
		return
	}
	restoreStash()
	_ = h.autoUpdateGitSubmodules(repoRoot)

	files, summary := h.collectStructuredStatus(repoRoot)
	if files == nil {
		files = []StructuredFile{}
	}
	bs := collectBranchStatus(repoRoot)
	branches := collectBranchesSnapshot(repoRoot)
	unlocksRepo()
	h.broadcastStatus(req.Path)
	h.broadcastBranchStatus(req.Path)
	h.broadcastRepoSyncNeeded(req.Path, gin.H{"history": true, "branches": true, "stashes": true, "conflicts": true})
	c.JSON(http.StatusOK, gin.H{
		"ok": true, "branch": localBranch,
		"remote": remote, "remoteBranch": remoteBranch,
		"created": !localExists, "stashed": stashed, "stashConflict": stashConflict,
		"stashError": stashRestoreError,
		"status":     gin.H{"files": files, "summary": summary}, "branchStatus": bs,
		"currentBranch": branches.CurrentBranch,
		"branches":      branches.Branches, "remoteBranches": branches.RemoteBranches,
	})
}

// BranchStatus godoc
// @Summary Get current branch upstream status (ahead/behind)
// @Tags Git
// @Accept json
// @Produce json
// @Param request body GitPathRequest true "Repository path"
// @Success 200 {object} BranchStatusInfo
// @Failure 400 {object} map[string]string
// @Router /api/git/branch-status [post]
func (h *GitHandler) BranchStatus(c *gin.Context) {
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

	bs := collectBranchStatus(repoRoot)
	c.JSON(http.StatusOK, bs)
}

type CreateBranchRequest struct {
	Path   string `json:"path" binding:"required"`
	Branch string `json:"branch" binding:"required"`
	From   string `json:"from"`
}

// CreateBranch godoc
// @Summary Create a new branch
// @Tags Git
// @Accept json
// @Produce json
// @Param request body CreateBranchRequest true "Repository path, branch name, and optional start point"
// @Success 200 {object} map[string]interface{}
// @Failure 400 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/git/create-branch [post]
func (h *GitHandler) CreateBranch(c *gin.Context) {
	var req CreateBranchRequest
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
	branch, err := normalizeGitBranchName(repoRoot, req.Branch)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	args := []string{"branch", "--", branch}
	if req.From != "" {
		from, err := resolveGitCommitRef(repoRoot, req.From, "start point")
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		args = append(args, from)
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

	unlockRepo()
	h.broadcastRepoSyncNeeded(req.Path, gin.H{"branches": true})
	c.JSON(http.StatusOK, gin.H{"ok": true, "branch": branch})
}

type DeleteBranchRequest struct {
	Path   string `json:"path" binding:"required"`
	Branch string `json:"branch" binding:"required"`
	Force  bool   `json:"force"`
}

type CheckoutRemoteBranchRequest struct {
	Path         string `json:"path" binding:"required"`
	Remote       string `json:"remote"`
	Branch       string `json:"branch"`
	RemoteBranch string `json:"remoteBranch"`
	LocalBranch  string `json:"localBranch"`
}

// RenameBranchRequest intentionally accepts the historical `branch` name as
// well as the more explicit `oldBranch`/`newName` aliases.  Keeping the wire
// aliases makes the endpoint usable by both the compact branch picker and
// clients that model the operation as a source/target rename.
type RenameBranchRequest struct {
	Path      string `json:"path" binding:"required"`
	Branch    string `json:"branch"`
	OldBranch string `json:"oldBranch"`
	NewBranch string `json:"newBranch"`
	NewName   string `json:"newName"`
}

type DeleteRemoteBranchRequest struct {
	Path         string `json:"path" binding:"required"`
	Remote       string `json:"remote"`
	Branch       string `json:"branch"`
	RemoteBranch string `json:"remoteBranch"`
	Ref          string `json:"ref"`
}

type PruneRemoteRequest struct {
	Path   string `json:"path" binding:"required"`
	Remote string `json:"remote"`
	DryRun bool   `json:"dryRun"`
}

// DeleteBranch godoc
// @Summary Delete a branch
// @Tags Git
// @Accept json
// @Produce json
// @Param request body DeleteBranchRequest true "Repository path and branch name"
// @Success 200 {object} map[string]bool
// @Failure 400 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/git/delete-branch [post]
func (h *GitHandler) DeleteBranch(c *gin.Context) {
	var req DeleteBranchRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	repoRoot, err := h.getRepoRoot(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	branch, err := normalizeGitBranchName(repoRoot, req.Branch)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	unlockRepo := lockGitOperationRepo(repoRoot)
	defer unlockRepo()

	currentCmd := newGitCommand("branch", "--show-current")
	currentCmd.Dir = repoRoot
	out, _ := currentCmd.Output()
	if strings.TrimSpace(string(out)) == branch {
		c.JSON(http.StatusBadRequest, gin.H{"error": "cannot delete current branch"})
		return
	}

	deleteFlag := "-d"
	if req.Force {
		deleteFlag = "-D"
	}
	cmd := newGitCommand("branch", deleteFlag, "--", branch)
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

	unlockRepo()
	h.broadcastRepoSyncNeeded(req.Path, gin.H{"branches": true})
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// RenameBranch renames a local branch without changing any remote refs. Git
// itself updates the branch's upstream configuration when possible. The
// target is checked before invoking Git so a typo cannot overwrite an
// existing branch and callers receive a client error rather than a generic
// command failure.
func (h *GitHandler) RenameBranch(c *gin.Context) {
	var req RenameBranchRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	repoRoot, err := h.getRepoRoot(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	oldInput := firstNonEmptyGitValue(req.OldBranch, req.Branch)
	newInput := firstNonEmptyGitValue(req.NewBranch, req.NewName)
	if strings.TrimSpace(oldInput) == "" || strings.TrimSpace(newInput) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "oldBranch and newBranch are required"})
		return
	}

	unlockRepo := lockGitOperationRepo(repoRoot)
	defer unlockRepo()
	oldBranch, err := normalizeGitBranchName(repoRoot, oldInput)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	newBranch, err := normalizeGitBranchName(repoRoot, newInput)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if oldBranch == newBranch {
		c.JSON(http.StatusBadRequest, gin.H{"error": "new branch name must differ from the current name"})
		return
	}
	if _, err := verifyLocalGitBranch(repoRoot, oldBranch); err != nil {
		unborn, unbornErr := isCurrentUnbornBranch(repoRoot, oldBranch)
		if unbornErr != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to inspect current branch: " + unbornErr.Error()})
			return
		}
		if !unborn {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
	}

	// Do not let `git branch -m` decide whether a target exists: on some Git
	// versions that distinction is reported as a generic exit status. A
	// case-only rename is allowed when the exact target ref is not present.
	targetCmd := newGitCommand("show-ref", "--verify", "--quiet", "refs/heads/"+newBranch)
	targetCmd.Dir = repoRoot
	if err := targetCmd.Run(); err != nil {
		var exitErr *exec.ExitError
		if !errors.As(err, &exitErr) || exitErr.ExitCode() != 1 {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to check target branch: " + err.Error()})
			return
		}
	} else {
		c.JSON(http.StatusBadRequest, gin.H{"error": "branch already exists: " + newBranch})
		return
	}

	cmd := newGitCommand("branch", "-m", "--", oldBranch, newBranch)
	cmd.Dir = repoRoot
	output, err := cmd.CombinedOutput()
	if err != nil {
		message := strings.TrimSpace(string(output))
		if message == "" {
			message = err.Error()
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": message})
		return
	}

	snapshot := collectBranchesSnapshot(repoRoot)
	status := collectBranchStatus(repoRoot)
	unlockRepo()
	h.broadcastBranchStatus(req.Path)
	h.broadcastRepoSyncNeeded(req.Path, gin.H{"branches": true})
	c.JSON(http.StatusOK, gin.H{
		"ok":             true,
		"oldBranch":      oldBranch,
		"branch":         newBranch,
		"currentBranch":  snapshot.CurrentBranch,
		"branches":       snapshot.Branches,
		"remoteBranches": snapshot.RemoteBranches,
		"branchStatus":   status,
	})
}

// normalizeGitRemoteBranchName accepts a branch name and returns the literal
// branch part used by remote operations. The caller must resolve any
// remote-prefixed display value before calling this function; a branch can
// legitimately contain the remote name as its first path segment (for
// example, origin/feature).
func normalizeGitRemoteBranchName(repoRoot, remote, branch string) (string, error) {
	branch = strings.TrimSpace(branch)
	branch = strings.TrimPrefix(branch, "refs/heads/")
	branch = strings.TrimPrefix(branch, "refs/remotes/"+remote+"/")
	if err := validateGitRefArgument(branch, "branch"); err != nil {
		return "", err
	}
	cmd := newGitCommand("check-ref-format", "refs/heads/"+branch)
	cmd.Dir = repoRoot
	if output, err := cmd.CombinedOutput(); err != nil {
		message := strings.TrimSpace(string(output))
		if message == "" {
			message = "invalid branch"
		}
		return "", errors.New(message)
	}
	return branch, nil
}

// stripRemoteBranchDisplayPrefix converts a display value such as
// origin/feature (or refs/remotes/origin/feature) to the branch part expected
// by normalizeGitRemoteBranchName. It is intentionally separate from the
// base normalizer so compact request fields remain lossless.
func stripRemoteBranchDisplayPrefix(remote, branch string) string {
	branch = strings.TrimSpace(branch)
	// Full refs carry their own unambiguous prefix. Return immediately after
	// removing it: the resulting branch may itself start with the remote name.
	if prefix := "refs/remotes/" + remote + "/"; strings.HasPrefix(branch, prefix) {
		return strings.TrimPrefix(branch, prefix)
	}
	if strings.HasPrefix(branch, "refs/heads/") {
		return strings.TrimPrefix(branch, "refs/heads/")
	}
	if prefix := remote + "/"; strings.HasPrefix(branch, prefix) {
		branch = strings.TrimPrefix(branch, prefix)
	}
	return branch
}

func splitConfiguredRemoteBranch(repoRoot, value string) (string, string, bool) {
	value = strings.TrimSpace(value)
	cmd := newGitCommand("remote")
	cmd.Dir = repoRoot
	output, err := cmd.Output()
	if err != nil {
		return "", "", false
	}
	remotes := strings.Split(strings.TrimSpace(string(output)), "\n")
	sort.Slice(remotes, func(i, j int) bool { return len(remotes[i]) > len(remotes[j]) })
	for _, remote := range remotes {
		remote = strings.TrimSpace(remote)
		prefix := remote + "/"
		if remote != "" && strings.HasPrefix(value, prefix) && len(value) > len(prefix) {
			return remote, strings.TrimPrefix(value, prefix), true
		}
	}
	return "", "", false
}

func deleteRemoteBranchInputs(repoRoot string, req DeleteRemoteBranchRequest) (string, string, error) {
	remote := strings.TrimSpace(req.Remote)
	branch := firstNonEmptyGitValue(req.RemoteBranch, req.Ref, req.Branch)
	// `remoteBranch` and `ref` are display-oriented fields and may carry the
	// remote prefix. The compact `branch` field remains origin-relative unless
	// the caller explicitly supplies a remote.
	displayBranchInput := strings.TrimSpace(req.RemoteBranch) != "" || strings.TrimSpace(req.Ref) != ""
	displayPrefixRemoved := false
	if remote == "" && displayBranchInput {
		value := strings.TrimSpace(branch)
		if candidate, remoteBranch, ok := splitConfiguredRemoteBranch(repoRoot, value); ok {
			remote, branch = candidate, remoteBranch
			displayPrefixRemoved = true
		}
	}
	if remote == "" {
		remote = "origin"
	}
	if branch == "" {
		return "", "", errors.New("branch is required")
	}
	if displayBranchInput && !displayPrefixRemoved {
		branch = stripRemoteBranchDisplayPrefix(remote, branch)
	}
	return remote, branch, nil
}

// DeleteRemoteBranch deletes exactly one branch ref on a configured remote.
// A successful deletion also removes the local remote-tracking ref so branch
// snapshots do not keep showing a stale entry when the server does not update
// it as part of the push protocol.
func (h *GitHandler) DeleteRemoteBranch(c *gin.Context) {
	var req DeleteRemoteBranchRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	repoRoot, err := h.getRepoRoot(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	remote, branchInput, err := deleteRemoteBranchInputs(repoRoot, req)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := validateConfiguredGitRemote(repoRoot, remote); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	branch, err := normalizeGitRemoteBranchName(repoRoot, remote, branchInput)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	unlockRepo := lockGitOperationRepo(repoRoot)
	defer unlockRepo()
	// Qualify the destination ref so an identically named tag cannot make the
	// deletion ambiguous (or become the accidental target on a tag-only remote).
	cmd := newGitCommand("push", "--delete", remote, "refs/heads/"+branch)
	cmd.Dir = repoRoot
	cleanupAskPass := h.configureGitHubAskPass(cmd, githubRemoteURL(repoRoot, remote))
	defer cleanupAskPass()
	output, err := cmd.CombinedOutput()
	if err != nil {
		message := strings.TrimSpace(string(output))
		if message == "" {
			message = err.Error()
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": message})
		return
	}

	// Git normally removes this ref itself. The explicit cleanup is idempotent
	// and also covers remotes whose push implementation leaves it behind.
	trackingRef := "refs/remotes/" + remote + "/" + branch
	cleanupCmd := newGitCommand("update-ref", "-d", "--", trackingRef)
	cleanupCmd.Dir = repoRoot
	_, _ = cleanupCmd.CombinedOutput()
	snapshot := collectBranchesSnapshot(repoRoot)
	status := collectBranchStatus(repoRoot)
	unlockRepo()
	h.broadcastBranchStatus(req.Path)
	h.broadcastRepoSyncNeeded(req.Path, gin.H{"branches": true})
	c.JSON(http.StatusOK, gin.H{
		"ok":             true,
		"remote":         remote,
		"branch":         branch,
		"currentBranch":  snapshot.CurrentBranch,
		"branches":       snapshot.Branches,
		"remoteBranches": snapshot.RemoteBranches,
		"branchStatus":   status,
	})
}

func remoteBranchSet(branches []string, remote string) map[string]struct{} {
	prefix := remote + "/"
	set := make(map[string]struct{})
	for _, branch := range branches {
		if strings.HasPrefix(branch, prefix) {
			set[branch] = struct{}{}
		}
	}
	return set
}

func parseDryRunPrunedBranches(output string) []string {
	const marker = "* [would prune] "
	removed := make([]string, 0)
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, marker) {
			continue
		}
		branch := strings.TrimSpace(strings.TrimPrefix(line, marker))
		if branch != "" {
			removed = append(removed, branch)
		}
	}
	sort.Strings(removed)
	return removed
}

// PruneRemote removes stale refs/remotes/<remote> entries using Git's remote
// prune operation. The response reports the exact entries removed, rather
// than relying on Git's human-readable output (which varies by version).
func (h *GitHandler) PruneRemote(c *gin.Context) {
	var req PruneRemoteRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	repoRoot, err := h.getRepoRoot(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	remote := strings.TrimSpace(req.Remote)
	if remote == "" {
		remote = "origin"
	}
	if err := validateConfiguredGitRemote(repoRoot, remote); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	unlockRepo := lockGitOperationRepo(repoRoot)
	defer unlockRepo()
	before := collectRemoteBranches(repoRoot)
	args := []string{"remote", "prune"}
	if req.DryRun {
		args = append(args, "--dry-run")
	}
	args = append(args, remote)
	cmd := newGitCommand(args...)
	cmd.Dir = repoRoot
	cleanupAskPass := h.configureGitHubAskPass(cmd, githubRemoteURL(repoRoot, remote))
	defer cleanupAskPass()
	output, err := cmd.CombinedOutput()
	if err != nil {
		message := strings.TrimSpace(string(output))
		if message == "" {
			message = err.Error()
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": message})
		return
	}
	removed := parseDryRunPrunedBranches(string(output))
	if !req.DryRun {
		after := collectRemoteBranches(repoRoot)
		beforeSet := remoteBranchSet(before, remote)
		afterSet := remoteBranchSet(after, remote)
		removed = removed[:0]
		for branch := range beforeSet {
			if _, ok := afterSet[branch]; !ok {
				removed = append(removed, branch)
			}
		}
		sort.Strings(removed)
	}
	snapshot := collectBranchesSnapshot(repoRoot)
	unlockRepo()
	h.broadcastRepoSyncNeeded(req.Path, gin.H{"branches": true})
	c.JSON(http.StatusOK, gin.H{
		"ok":             true,
		"remote":         remote,
		"dryRun":         req.DryRun,
		"removed":        removed,
		"currentBranch":  snapshot.CurrentBranch,
		"branches":       snapshot.Branches,
		"remoteBranches": snapshot.RemoteBranches,
	})
}
