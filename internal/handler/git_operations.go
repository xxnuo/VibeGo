package handler

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"unicode"

	"github.com/gin-gonic/gin"
)

const (
	maxGitOperationRefs            = 256
	maxGitInteractiveCommits       = 4096
	gitOperationOwnershipStateFile = "vibego-operation-ownership.json"
	gitInteractiveRewriteStateFile = "vibego-interactive-rewrite.json"
)

// gitOperationRepoLocks serializes stateful Git writes across all GitHandler
// instances in this process. A repository can be addressed by several paths
// (for example, a symlink and its physical path), so keys are canonicalized
// before looking up the mutex.
var gitOperationRepoLocks sync.Map // map[string]*sync.Mutex

const gitOperationRepoUnlockContextKey = "vibego.git-operation-repo-unlock"

func canonicalGitOperationRepoRoot(repoRoot string) string {
	abs, err := filepath.Abs(repoRoot)
	if err != nil {
		abs = repoRoot
	}
	abs = filepath.Clean(abs)
	if resolved, ok := resolveGitOperationLockPath(abs); ok {
		abs = resolved
	}
	return abs
}

func resolveGitOperationLockPath(abs string) (string, bool) {
	current := abs
	missing := make([]string, 0, 2)
	for {
		if resolved, err := filepath.EvalSymlinks(current); err == nil {
			if resolvedAbs, absErr := filepath.Abs(resolved); absErr == nil {
				resolved = resolvedAbs
			}
			for i := len(missing) - 1; i >= 0; i-- {
				resolved = filepath.Join(resolved, missing[i])
			}
			return filepath.Clean(resolved), true
		}

		parent := filepath.Dir(current)
		if parent == current {
			return "", false
		}
		missing = append(missing, filepath.Base(current))
		current = parent
	}
}

// gitOperationLockPathForMutation reuses an enclosing repository key when the
// target already lives in a worktree. For a new standalone target, the target
// path itself remains the lock key so concurrent init/clone requests serialize.
func gitOperationLockPathForMutation(path string) string {
	probe := path
	for {
		info, err := os.Stat(probe)
		if err == nil {
			if !info.IsDir() {
				probe = filepath.Dir(probe)
			}
			break
		}
		parent := filepath.Dir(probe)
		if parent == probe {
			return path
		}
		probe = parent
	}

	cmd := newGitCommand("rev-parse", "--show-toplevel")
	cmd.Dir = probe
	if output, err := cmd.Output(); err == nil {
		if repoRoot := strings.TrimSpace(string(output)); repoRoot != "" {
			return repoRoot
		}
	}
	return path
}

// lockGitOperationRepo returns an idempotent unlock function. The idempotence
// is useful for handlers that release the lock before broadcasting a response
// and also defer cleanup on every early-return validation path.
func lockGitOperationRepo(repoRoot string) func() {
	key := canonicalGitOperationRepoRoot(repoRoot)
	entry, _ := gitOperationRepoLocks.LoadOrStore(key, &sync.Mutex{})
	mu := entry.(*sync.Mutex)
	mu.Lock()
	var once sync.Once
	return func() {
		once.Do(mu.Unlock)
	}
}

func acquireGitOperationRepoLock(c *gin.Context, repoRoot string) {
	if c == nil {
		return
	}
	c.Set(gitOperationRepoUnlockContextKey, lockGitOperationRepo(repoRoot))
}

func releaseGitOperationRepoLock(c *gin.Context) {
	if c == nil {
		return
	}
	value, exists := c.Get(gitOperationRepoUnlockContextKey)
	if !exists {
		return
	}
	c.Set(gitOperationRepoUnlockContextKey, nil)
	if unlock, ok := value.(func()); ok && unlock != nil {
		unlock()
	}
}

type GitOperationProgress struct {
	Position             int     `json:"position"`
	Total                int     `json:"total"`
	Value                float64 `json:"value"`
	CurrentCommit        string  `json:"currentCommit,omitempty"`
	CurrentCommitSummary string  `json:"currentCommitSummary,omitempty"`
}

type GitOperationResponse struct {
	OK            bool                  `json:"ok"`
	Operation     string                `json:"operation"`
	State         string                `json:"state"`
	Status        GitWSStatusPayload    `json:"status"`
	Conflicts     []string              `json:"conflicts"`
	Progress      *GitOperationProgress `json:"progress,omitempty"`
	HeadHash      string                `json:"headHash,omitempty"`
	HeadRef       string                `json:"headRef,omitempty"`
	OriginalHead  string                `json:"originalHead,omitempty"`
	BaseRef       string                `json:"baseRef,omitempty"`
	TargetRef     string                `json:"targetRef,omitempty"`
	CurrentCommit string                `json:"currentCommit,omitempty"`
	Output        string                `json:"output,omitempty"`
	Error         string                `json:"error,omitempty"`
}

type GitMergeRequest struct {
	Path         string   `json:"path" binding:"required"`
	Ref          string   `json:"ref"`
	Branch       string   `json:"branch"`
	SourceBranch string   `json:"sourceBranch"`
	Action       string   `json:"action"`
	NoFF         bool     `json:"noFF"`
	NoFFSnake    bool     `json:"no_ff"`
	NoVerify     bool     `json:"noVerify"`
	Files        []string `json:"files"`
}

type GitRebaseRequest struct {
	Path         string   `json:"path" binding:"required"`
	Upstream     string   `json:"upstream"`
	Base         string   `json:"base"`
	BaseBranch   string   `json:"baseBranch"`
	TargetBranch string   `json:"targetBranch"`
	Target       string   `json:"target"`
	Action       string   `json:"action"`
	NoVerify     bool     `json:"noVerify"`
	Files        []string `json:"files"`
}

type GitCherryPickRequest struct {
	Path     string   `json:"path" binding:"required"`
	Commit   string   `json:"commit"`
	SHA      string   `json:"sha"`
	Commits  []string `json:"commits"`
	Action   string   `json:"action"`
	Mainline int      `json:"mainline"`
	Files    []string `json:"files"`
}

type GitRevertRequest struct {
	Path     string   `json:"path" binding:"required"`
	Commit   string   `json:"commit"`
	SHA      string   `json:"sha"`
	Action   string   `json:"action"`
	Mainline int      `json:"mainline"`
	Files    []string `json:"files"`
}

type GitResetToCommitRequest struct {
	Path   string `json:"path" binding:"required"`
	Ref    string `json:"ref"`
	Commit string `json:"commit"`
	SHA    string `json:"sha"`
	Mode   string `json:"mode"`
}

// GitSquashRequest describes a history rewrite around squashOnto. Refs may
// be abbreviated or symbolic; the handler resolves and validates them before
// constructing the interactive-rebase todo list.
type GitSquashRequest struct {
	Path                  string   `json:"path" binding:"required"`
	ToSquash              []string `json:"toSquash"`
	SquashOnto            string   `json:"squashOnto"`
	LastRetainedCommitRef string   `json:"lastRetainedCommitRef"`
	Message               string   `json:"message"`
	CommitMessage         string   `json:"commitMessage"`
}

// GitReorderRequest describes moving selected commits before beforeCommit. An
// empty beforeCommit moves them to the end of the rewritten range.
type GitReorderRequest struct {
	Path                  string   `json:"path" binding:"required"`
	ToMove                []string `json:"toMove"`
	BeforeCommit          string   `json:"beforeCommit"`
	LastRetainedCommitRef string   `json:"lastRetainedCommitRef"`
}

type gitOperationDiskState struct {
	Operation     string
	State         string
	HeadRef       string
	OriginalHead  string
	BaseRef       string
	TargetRef     string
	CurrentCommit string
	Progress      *GitOperationProgress
}

type gitOperationOwnershipState struct {
	Operation    string   `json:"operation"`
	Mainline     int      `json:"mainline"`
	OriginalHead string   `json:"originalHead"`
	Commits      []string `json:"commits"`
}

// gitInteractiveRewriteState keeps options which Git does not persist across
// a paused interactive rebase. In particular, the commit message supplied for
// a squash must still be available when the user resolves a conflict and
// invokes `git rebase --continue`.
type gitInteractiveRewriteState struct {
	Operation string `json:"operation"`
	Message   string `json:"message"`
}

type gitOperationValidationError struct {
	err error
}

func (e *gitOperationValidationError) Error() string {
	return e.err.Error()
}

func (e *gitOperationValidationError) Unwrap() error {
	return e.err
}

// RegisterGitOperationRoutes registers the advanced local Git workflow routes.
// The argument must be the API base group, matching GitHandler.Register.
func (h *GitHandler) RegisterGitOperationRoutes(r *gin.RouterGroup) {
	g := r.Group("/git")
	g.POST("/operation-status", h.OperationStatus)
	g.POST("/merge", h.Merge)
	g.POST("/rebase", h.Rebase)
	g.POST("/cherry-pick", h.CherryPick)
	g.POST("/revert", h.Revert)
	g.POST("/reset-to-commit", h.ResetToCommit)
	g.POST("/squash", h.Squash)
	g.POST("/reorder", h.Reorder)
}

func (h *GitHandler) OperationStatus(c *gin.Context) {
	var req GitPathRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		writeGitOperationRequestError(c, "none", err)
		return
	}

	repoRoot, err := h.getRepoRoot(req.Path)
	if err != nil {
		writeGitOperationRequestError(c, "none", err)
		return
	}
	acquireGitOperationRepoLock(c, repoRoot)
	defer releaseGitOperationRepoLock(c)

	response := h.collectGitOperationResponse(repoRoot, "", "", true, "", "")
	releaseGitOperationRepoLock(c)
	c.JSON(http.StatusOK, response)
}

func (h *GitHandler) Merge(c *gin.Context) {
	var req GitMergeRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		writeGitOperationRequestError(c, "merge", err)
		return
	}

	repoRoot, err := h.getRepoRoot(req.Path)
	if err != nil {
		writeGitOperationRequestError(c, "merge", err)
		return
	}
	acquireGitOperationRepoLock(c, repoRoot)
	defer releaseGitOperationRepoLock(c)

	action := normalizedGitOperationAction(req.Action)
	var args []string
	switch action {
	case "start":
		if err := ensureGitOperationCanStart(repoRoot); err != nil {
			writeGitOperationRequestError(c, "merge", err)
			return
		}
		refInput := firstNonEmptyGitValue(req.Ref, req.Branch, req.SourceBranch)
		ref, err := verifyGitCommitRef(repoRoot, refInput)
		if err != nil {
			writeGitOperationRequestError(c, "merge", err)
			return
		}
		args = []string{"merge", "--no-edit"}
		if req.NoFF || req.NoFFSnake {
			args = append(args, "--no-ff")
		}
		if req.NoVerify {
			args = append(args, "--no-verify")
		}
		args = append(args, "--end-of-options", ref)
	case "continue":
		if err := requireGitOperation(repoRoot, "merge"); err != nil {
			writeGitOperationRequestError(c, "merge", err)
			return
		}
		if err := ensureGitOperationCanContinue(repoRoot, "merge", req.Files); err != nil {
			h.writeGitOperationStageError(c, req.Path, repoRoot, "merge", err)
			return
		}
		if err := stageGitOperationFiles(repoRoot, req.Files); err != nil {
			h.writeGitOperationStageError(c, req.Path, repoRoot, "merge", err)
			return
		}
		args = []string{"merge", "--continue"}
	case "abort":
		if err := requireGitOperation(repoRoot, "merge"); err != nil {
			writeGitOperationRequestError(c, "merge", err)
			return
		}
		args = []string{"merge", "--abort"}
	default:
		writeGitOperationRequestError(c, "merge", fmt.Errorf("invalid merge action: %s", action))
		return
	}

	output, commandErr := runGitOperationCommand(repoRoot, true, args...)
	successState := "completed"
	if action == "abort" {
		successState = "aborted"
	}
	h.writeGitOperationResult(c, req.Path, repoRoot, "merge", successState, output, args, commandErr)
}

func (h *GitHandler) Rebase(c *gin.Context) {
	var req GitRebaseRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		writeGitOperationRequestError(c, "rebase", err)
		return
	}

	repoRoot, err := h.getRepoRoot(req.Path)
	if err != nil {
		writeGitOperationRequestError(c, "rebase", err)
		return
	}
	acquireGitOperationRepoLock(c, repoRoot)
	defer releaseGitOperationRepoLock(c)

	action := normalizedGitOperationAction(req.Action)
	args := []string{"-c", "rebase.backend=merge", "rebase"}
	continueEditor := ""
	continueMessage := ""
	switch action {
	case "start":
		if err := ensureGitOperationCanStart(repoRoot); err != nil {
			writeGitOperationRequestError(c, "rebase", err)
			return
		}
		upstreamInput := firstNonEmptyGitValue(req.Upstream, req.Base, req.BaseBranch)
		upstream, err := verifyGitCommitRef(repoRoot, upstreamInput)
		if err != nil {
			writeGitOperationRequestError(c, "rebase", err)
			return
		}
		if req.NoVerify {
			args = append(args, "--no-verify")
		}
		args = append(args, "--end-of-options", upstream)
		targetInput := firstNonEmptyGitValue(req.TargetBranch, req.Target)
		if targetInput != "" {
			target, err := verifyLocalGitBranch(repoRoot, targetInput)
			if err != nil {
				writeGitOperationRequestError(c, "rebase", err)
				return
			}
			args = append(args, target)
		}
		// A prior interrupted squash must not leak its message into an
		// unrelated rebase. A new ordinary rebase also establishes a clean
		// starting point for the sidecar used by squash.
		if err := clearGitInteractiveRewriteState(repoRoot); err != nil {
			writeGitOperationRequestError(c, "rebase", err)
			return
		}
	case "continue":
		if err := requireGitOperation(repoRoot, "rebase"); err != nil {
			writeGitOperationRequestError(c, "rebase", err)
			return
		}
		rewriteState, stateErr := readGitInteractiveRewriteState(repoRoot)
		if stateErr != nil {
			writeGitOperationRequestError(c, "rebase", stateErr)
			return
		}
		if rewriteState != nil && rewriteState.Operation == "squash" {
			continueEditor, continueMessage, stateErr = createGitSquashContinueEditor(
				"vibego-git-squash-continue", rewriteState.Message, repoRoot,
			)
			if stateErr != nil {
				writeGitOperationRequestError(c, "rebase", stateErr)
				return
			}
			defer func() {
				_ = os.Remove(continueEditor)
				_ = os.Remove(continueMessage)
			}()
		}
		if err := ensureGitOperationCanContinue(repoRoot, "rebase", req.Files); err != nil {
			h.writeGitOperationStageError(c, req.Path, repoRoot, "rebase", err)
			return
		}
		if err := stageGitOperationFiles(repoRoot, req.Files); err != nil {
			h.writeGitOperationStageError(c, req.Path, repoRoot, "rebase", err)
			return
		}
		args = append(args, "--continue")
	case "abort":
		if err := requireGitOperation(repoRoot, "rebase"); err != nil {
			writeGitOperationRequestError(c, "rebase", err)
			return
		}
		args = append(args, "--abort")
	case "skip":
		if err := requireGitOperation(repoRoot, "rebase"); err != nil {
			writeGitOperationRequestError(c, "rebase", err)
			return
		}
		args = append(args, "--skip")
	default:
		writeGitOperationRequestError(c, "rebase", fmt.Errorf("invalid rebase action: %s", action))
		return
	}

	var output []byte
	var commandErr error
	if continueEditor != "" {
		output, commandErr = runGitOperationCommandWithEditor(repoRoot, true, continueEditor, args...)
	} else {
		output, commandErr = runGitOperationCommand(repoRoot, true, args...)
	}
	if action == "continue" || action == "abort" || action == "skip" {
		if err := finalizeGitInteractiveRewriteState(repoRoot, commandErr); err != nil {
			commandErr = errors.Join(commandErr, err)
		}
	}
	successState := mapGitOperationSuccessState(action)
	h.writeGitOperationResult(c, req.Path, repoRoot, "rebase", successState, output, args, commandErr)
}

func (h *GitHandler) CherryPick(c *gin.Context) {
	var req GitCherryPickRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		writeGitOperationRequestError(c, "cherry-pick", err)
		return
	}

	repoRoot, err := h.getRepoRoot(req.Path)
	if err != nil {
		writeGitOperationRequestError(c, "cherry-pick", err)
		return
	}
	acquireGitOperationRepoLock(c, repoRoot)
	defer releaseGitOperationRepoLock(c)

	action := normalizedGitOperationAction(req.Action)
	var args []string
	switch action {
	case "start":
		if err := ensureGitOperationCanStart(repoRoot); err != nil {
			writeGitOperationRequestError(c, "cherry-pick", err)
			return
		}
		if err := clearGitOperationOwnershipState(repoRoot); err != nil {
			writeGitOperationRequestError(c, "cherry-pick", err)
			return
		}
		refs := append([]string(nil), req.Commits...)
		commitInput := firstNonEmptyGitValue(req.Commit, req.SHA)
		if commitInput != "" {
			refs = append(refs, commitInput)
		}
		commits, err := verifyGitCommitRefs(repoRoot, refs)
		if err != nil {
			writeGitOperationRequestError(c, "cherry-pick", err)
			return
		}
		if req.Mainline < 0 || req.Mainline > 16 {
			writeGitOperationRequestError(c, "cherry-pick", errors.New("mainline parent must be between 1 and 16"))
			return
		}
		if err := ensureGitCherryPickCommitsNotAncestors(repoRoot, commits); err != nil {
			writeGitOperationRequestError(c, "cherry-pick", err)
			return
		}
		// A patch can be equivalent to changes already present on a divergent
		// branch. Drop that redundant commit instead of creating an empty one or
		// pausing the operation for a manual skip.
		args = []string{"cherry-pick", "--empty=drop"}
		if req.Mainline > 0 {
			args = append(args, "-m", strconv.Itoa(req.Mainline))
		}
		args = append(args, "--end-of-options")
		args = append(args, commits...)
		if err := prepareGitOperationOwnershipState(repoRoot, "cherry-pick", commits, req.Mainline); err != nil {
			writeGitOperationRequestError(c, "cherry-pick", err)
			return
		}
	case "continue":
		if err := requireGitOperation(repoRoot, "cherry-pick"); err != nil {
			writeGitOperationRequestError(c, "cherry-pick", err)
			return
		}
		if err := ensureGitOperationCanContinue(repoRoot, "cherry-pick", req.Files); err != nil {
			h.writeGitOperationStageError(c, req.Path, repoRoot, "cherry-pick", err)
			return
		}
		if err := stageGitOperationFiles(repoRoot, req.Files); err != nil {
			h.writeGitOperationStageError(c, req.Path, repoRoot, "cherry-pick", err)
			return
		}
		args = []string{"cherry-pick", "--continue"}
	case "abort":
		if err := requireGitOperation(repoRoot, "cherry-pick"); err != nil {
			writeGitOperationRequestError(c, "cherry-pick", err)
			return
		}
		args = []string{"cherry-pick", "--abort"}
	case "skip":
		if err := requireGitOperation(repoRoot, "cherry-pick"); err != nil {
			writeGitOperationRequestError(c, "cherry-pick", err)
			return
		}
		args = []string{"cherry-pick", "--skip"}
	default:
		writeGitOperationRequestError(c, "cherry-pick", fmt.Errorf("invalid cherry-pick action: %s", action))
		return
	}

	output, commandErr := runGitOperationCommand(repoRoot, true, args...)
	output, commandErr = finalizeGitOperationOwnershipState(repoRoot, "cherry-pick", output, commandErr)
	h.writeGitOperationResult(c, req.Path, repoRoot, "cherry-pick", mapGitOperationSuccessState(action), output, args, commandErr)
}

func (h *GitHandler) Revert(c *gin.Context) {
	var req GitRevertRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		writeGitOperationRequestError(c, "revert", err)
		return
	}

	repoRoot, err := h.getRepoRoot(req.Path)
	if err != nil {
		writeGitOperationRequestError(c, "revert", err)
		return
	}
	acquireGitOperationRepoLock(c, repoRoot)
	defer releaseGitOperationRepoLock(c)

	action := normalizedGitOperationAction(req.Action)
	var args []string
	switch action {
	case "start":
		if err := ensureGitOperationCanStart(repoRoot); err != nil {
			writeGitOperationRequestError(c, "revert", err)
			return
		}
		if err := clearGitOperationOwnershipState(repoRoot); err != nil {
			writeGitOperationRequestError(c, "revert", err)
			return
		}
		commitInput := firstNonEmptyGitValue(req.Commit, req.SHA)
		commit, err := verifyGitCommitRef(repoRoot, commitInput)
		if err != nil {
			writeGitOperationRequestError(c, "revert", err)
			return
		}
		if req.Mainline < 0 || req.Mainline > 16 {
			writeGitOperationRequestError(c, "revert", errors.New("mainline parent must be between 1 and 16"))
			return
		}
		mainline := req.Mainline
		if mainline == 0 && gitCommitParentCount(repoRoot, commit) > 1 {
			mainline = 1
		}
		args = []string{"revert", "--no-edit"}
		if mainline > 0 {
			args = append(args, "-m", strconv.Itoa(mainline))
		}
		args = append(args, "--end-of-options", commit)
		if err := prepareGitOperationOwnershipState(repoRoot, "revert", []string{commit}, mainline); err != nil {
			writeGitOperationRequestError(c, "revert", err)
			return
		}
	case "continue":
		if err := requireGitOperation(repoRoot, "revert"); err != nil {
			writeGitOperationRequestError(c, "revert", err)
			return
		}
		if err := ensureGitOperationCanContinue(repoRoot, "revert", req.Files); err != nil {
			h.writeGitOperationStageError(c, req.Path, repoRoot, "revert", err)
			return
		}
		if err := stageGitOperationFiles(repoRoot, req.Files); err != nil {
			h.writeGitOperationStageError(c, req.Path, repoRoot, "revert", err)
			return
		}
		args = []string{"revert", "--continue"}
	case "abort":
		if err := requireGitOperation(repoRoot, "revert"); err != nil {
			writeGitOperationRequestError(c, "revert", err)
			return
		}
		args = []string{"revert", "--abort"}
	case "skip":
		if err := requireGitOperation(repoRoot, "revert"); err != nil {
			writeGitOperationRequestError(c, "revert", err)
			return
		}
		args = []string{"revert", "--skip"}
	default:
		writeGitOperationRequestError(c, "revert", fmt.Errorf("invalid revert action: %s", action))
		return
	}

	output, commandErr := runGitOperationCommand(repoRoot, true, args...)
	output, commandErr = finalizeGitOperationOwnershipState(repoRoot, "revert", output, commandErr)
	h.writeGitOperationResult(c, req.Path, repoRoot, "revert", mapGitOperationSuccessState(action), output, args, commandErr)
}

func (h *GitHandler) ResetToCommit(c *gin.Context) {
	var req GitResetToCommitRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		writeGitOperationRequestError(c, "reset", err)
		return
	}

	repoRoot, err := h.getRepoRoot(req.Path)
	if err != nil {
		writeGitOperationRequestError(c, "reset", err)
		return
	}
	acquireGitOperationRepoLock(c, repoRoot)
	defer releaseGitOperationRepoLock(c)
	// Reset deliberately operates on the index, so pre-existing staged changes
	// are valid input for its soft/mixed/hard semantics.
	if err := ensureGitOperationCanStartWithPolicy(repoRoot, false); err != nil {
		writeGitOperationRequestError(c, "reset", err)
		return
	}

	ref := firstNonEmptyGitValue(req.Ref, req.Commit, req.SHA)
	commit, err := verifyGitCommitRef(repoRoot, ref)
	if err != nil {
		writeGitOperationRequestError(c, "reset", err)
		return
	}

	mode := strings.ToLower(strings.TrimSpace(req.Mode))
	if mode == "" {
		mode = "mixed"
	}
	modeArg := "--" + mode
	if mode != "soft" && mode != "mixed" && mode != "hard" {
		writeGitOperationRequestError(c, "reset", fmt.Errorf("invalid reset mode: %s", mode))
		return
	}

	args := []string{"reset", modeArg, "--end-of-options", commit, "--"}
	output, commandErr := runGitOperationCommand(repoRoot, false, args...)
	h.writeGitOperationResult(c, req.Path, repoRoot, "reset", "completed", output, args, commandErr)
}

// Squash starts an interactive rebase with a generated todo list. The
// selected commits are replayed in their existing chronological order at the
// squash target and folded into one commit. Continue/abort are intentionally
// handled by the existing /git/rebase endpoint because Git records this as an
// ordinary interactive rebase while it is paused for conflicts.
func (h *GitHandler) Squash(c *gin.Context) {
	var req GitSquashRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		writeGitOperationRequestError(c, "squash", err)
		return
	}

	repoRoot, err := h.getRepoRoot(req.Path)
	if err != nil {
		writeGitOperationRequestError(c, "squash", err)
		return
	}
	acquireGitOperationRepoLock(c, repoRoot)
	defer releaseGitOperationRepoLock(c)

	if err := ensureGitOperationCanStart(repoRoot); err != nil {
		writeGitOperationRequestError(c, "squash", err)
		return
	}

	ontoRef := strings.TrimSpace(req.SquashOnto)
	if ontoRef == "" {
		writeGitOperationRequestError(c, "squash", errors.New("squashOnto commit is required"))
		return
	}
	if len(req.ToSquash) == 0 {
		writeGitOperationRequestError(c, "squash", errors.New("at least one toSquash commit is required"))
		return
	}

	lastRetainedCommitRef := strings.TrimSpace(req.LastRetainedCommitRef)
	if lastRetainedCommitRef == "" {
		refs := append([]string(nil), req.ToSquash...)
		refs = append(refs, ontoRef)
		lastRetainedCommitRef, err = deriveInteractiveHistoryBase(repoRoot, refs, "squash")
		if err != nil {
			writeGitOperationRequestError(c, "squash", err)
			return
		}
	}

	commits, commitIndex, err := collectGitInteractiveCommits(repoRoot, lastRetainedCommitRef)
	if err != nil {
		writeGitOperationRequestError(c, "squash", err)
		return
	}

	squashOnto, err := verifyGitCommitRef(repoRoot, ontoRef)
	if err != nil {
		writeGitOperationRequestError(c, "squash", err)
		return
	}
	if _, ok := commitIndex[squashOnto]; !ok {
		writeGitOperationRequestError(c, "squash", errors.New("squashOnto commit is outside the retained history range"))
		return
	}

	toSquash, err := resolveInteractiveCommitRefs(repoRoot, req.ToSquash, commitIndex, "toSquash")
	if err != nil {
		writeGitOperationRequestError(c, "squash", err)
		return
	}
	for _, sha := range toSquash {
		if sha == squashOnto {
			writeGitOperationRequestError(c, "squash", errors.New("the commits to squash cannot contain squashOnto"))
			return
		}
	}

	message := req.Message
	if strings.TrimSpace(message) == "" {
		message = req.CommitMessage
	}
	if err := validateGitInteractiveMessage(message); err != nil {
		writeGitOperationRequestError(c, "squash", err)
		return
	}
	todo, err := buildGitSquashTodo(commits, toSquash, squashOnto)
	if err != nil {
		writeGitOperationRequestError(c, "squash", err)
		return
	}

	if err := writeGitInteractiveRewriteState(repoRoot, "squash", message); err != nil {
		writeGitOperationRequestError(c, "squash", err)
		return
	}
	output, commandErr := runGitInteractiveHistoryRewrite(repoRoot, "squash", lastRetainedCommitRef, todo, message)
	if err := finalizeGitInteractiveRewriteState(repoRoot, commandErr); err != nil {
		commandErr = errors.Join(commandErr, err)
	}
	h.writeGitOperationResult(c, req.Path, repoRoot, "squash", "completed", output, nil, commandErr)
}

// Reorder starts an interactive rebase with a generated todo list. Selected
// commits retain their relative order and are inserted immediately before
// beforeCommit; an empty beforeCommit moves them to the end of the range.
func (h *GitHandler) Reorder(c *gin.Context) {
	var req GitReorderRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		writeGitOperationRequestError(c, "reorder", err)
		return
	}

	repoRoot, err := h.getRepoRoot(req.Path)
	if err != nil {
		writeGitOperationRequestError(c, "reorder", err)
		return
	}
	acquireGitOperationRepoLock(c, repoRoot)
	defer releaseGitOperationRepoLock(c)

	if err := ensureGitOperationCanStart(repoRoot); err != nil {
		writeGitOperationRequestError(c, "reorder", err)
		return
	}

	if len(req.ToMove) == 0 {
		writeGitOperationRequestError(c, "reorder", errors.New("at least one toMove commit is required"))
		return
	}
	lastRetainedCommitRef := strings.TrimSpace(req.LastRetainedCommitRef)
	if lastRetainedCommitRef == "" {
		refs := append([]string(nil), req.ToMove...)
		if strings.TrimSpace(req.BeforeCommit) != "" {
			refs = append(refs, req.BeforeCommit)
		}
		lastRetainedCommitRef, err = deriveInteractiveHistoryBase(repoRoot, refs, "reorder")
		if err != nil {
			writeGitOperationRequestError(c, "reorder", err)
			return
		}
	}

	commits, commitIndex, err := collectGitInteractiveCommits(repoRoot, lastRetainedCommitRef)
	if err != nil {
		writeGitOperationRequestError(c, "reorder", err)
		return
	}
	toMove, err := resolveInteractiveCommitRefs(repoRoot, req.ToMove, commitIndex, "toMove")
	if err != nil {
		writeGitOperationRequestError(c, "reorder", err)
		return
	}

	beforeCommit := ""
	if strings.TrimSpace(req.BeforeCommit) != "" {
		beforeCommit, err = verifyGitCommitRef(repoRoot, req.BeforeCommit)
		if err != nil {
			writeGitOperationRequestError(c, "reorder", err)
			return
		}
		if _, ok := commitIndex[beforeCommit]; !ok {
			writeGitOperationRequestError(c, "reorder", errors.New("beforeCommit is outside the retained history range"))
			return
		}
	}
	for _, sha := range toMove {
		if sha == beforeCommit {
			writeGitOperationRequestError(c, "reorder", errors.New("toMove commits cannot contain beforeCommit"))
			return
		}
	}

	todo, err := buildGitReorderTodo(commits, toMove, beforeCommit)
	if err != nil {
		writeGitOperationRequestError(c, "reorder", err)
		return
	}
	output, commandErr := runGitInteractiveHistoryRewrite(repoRoot, "reorder", lastRetainedCommitRef, todo, "")
	h.writeGitOperationResult(c, req.Path, repoRoot, "reorder", "completed", output, nil, commandErr)
}

func (h *GitHandler) writeGitOperationResult(c *gin.Context, path, repoRoot, operation, successState string, output []byte, _ []string, commandErr error) {
	outputText := truncateGitOperationOutput(strings.TrimSpace(string(output)))
	errorText := ""
	if commandErr != nil {
		errorText = outputText
		if errorText == "" {
			errorText = commandErr.Error()
		}
	}

	state := successState
	ok := commandErr == nil
	if ok && gitOperationWasAlreadyUpToDate(outputText) {
		state = "already_up_to_date"
	}
	response := h.collectGitOperationResponse(repoRoot, operation, state, ok, outputText, errorText)
	if commandErr != nil {
		diskState := collectGitOperationDiskState(repoRoot)
		if len(response.Conflicts) > 0 {
			response.State = "conflicts"
		} else if diskState.Operation != "none" {
			response.State = "in_progress"
		} else {
			response.State = "failed"
		}
	}

	// The Git state snapshot above must be consistent with the command and any
	// ownership sidecar cleanup. Release the repository lock before broadcasting
	// or serializing the response because those paths can re-enter Git status
	// collection and may notify other handlers.
	releaseGitOperationRepoLock(c)
	h.broadcastGitOperation(path, response)
	c.JSON(http.StatusOK, response)
}

func (h *GitHandler) writeGitOperationStageError(c *gin.Context, path, repoRoot, operation string, err error) {
	var validationErr *gitOperationValidationError
	if errors.As(err, &validationErr) {
		response := h.collectGitOperationResponse(repoRoot, operation, "", false, "", validationErr.Error())
		releaseGitOperationRepoLock(c)
		c.JSON(http.StatusBadRequest, response)
		return
	}
	h.writeGitOperationResult(c, path, repoRoot, operation, "continued", nil, nil, err)
}

func (h *GitHandler) collectGitOperationResponse(repoRoot, operation, state string, ok bool, output, errorText string) GitOperationResponse {
	diskState := collectGitOperationDiskState(repoRoot)
	conflicts := collectConflictFiles(repoRoot)
	if conflicts == nil {
		conflicts = []string{}
	}
	files, summary := h.collectStructuredStatus(repoRoot)
	if files == nil {
		files = []StructuredFile{}
	}

	if diskState.Operation != "none" {
		operation = diskState.Operation
	}
	if operation == "" {
		operation = "none"
	}
	if state == "" {
		state = diskState.State
	}
	if state == "" {
		state = "idle"
	}
	if len(conflicts) > 0 && diskState.Operation != "none" {
		state = "conflicts"
	}

	return GitOperationResponse{
		OK:            ok,
		Operation:     operation,
		State:         state,
		Status:        GitWSStatusPayload{Files: files, Summary: summary},
		Conflicts:     conflicts,
		Progress:      diskState.Progress,
		HeadHash:      collectHeadHash(repoRoot),
		HeadRef:       diskState.HeadRef,
		OriginalHead:  diskState.OriginalHead,
		BaseRef:       diskState.BaseRef,
		TargetRef:     diskState.TargetRef,
		CurrentCommit: diskState.CurrentCommit,
		Output:        output,
		Error:         errorText,
	}
}

func (h *GitHandler) broadcastGitOperation(path string, response GitOperationResponse) {
	h.broadcastStatus(path)
	h.broadcastBranchStatus(path)
	h.broadcastRepoSyncNeeded(path, gin.H{
		"history":   true,
		"branches":  true,
		"conflicts": true,
	})
	if h != nil && h.wsHandler != nil {
		h.wsHandler.Broadcast(path, GitWSEvent{Type: "operation_done", Data: response})
	}
}

func writeGitOperationRequestError(c *gin.Context, operation string, err error) {
	if operation == "" {
		operation = "none"
	}
	c.JSON(http.StatusBadRequest, GitOperationResponse{
		OK:        false,
		Operation: operation,
		State:     "invalid",
		Status:    GitWSStatusPayload{Files: []StructuredFile{}},
		Conflicts: []string{},
		Error:     err.Error(),
	})
}

func normalizedGitOperationAction(action string) string {
	action = strings.ToLower(strings.TrimSpace(action))
	if action == "" {
		return "start"
	}
	return action
}

func firstNonEmptyGitValue(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func mapGitOperationSuccessState(action string) string {
	switch action {
	case "abort":
		return "aborted"
	case "skip":
		return "skipped"
	default:
		return "completed"
	}
}

func runGitOperationCommand(repoRoot string, noEditor bool, args ...string) ([]byte, error) {
	return runGitOperationCommandWithEditor(repoRoot, noEditor, "", args...)
}

func runGitOperationCommandWithEditor(repoRoot string, noEditor bool, editor string, args ...string) ([]byte, error) {
	cmd := newGitCommand(args...)
	cmd.Dir = repoRoot
	if noEditor {
		cmd.Env = mergeEnv(cmd.Env, []string{"GIT_EDITOR=:", "GIT_SEQUENCE_EDITOR=:"})
	}
	if editor != "" {
		cmd.Env = mergeEnv(cmd.Env, []string{"GIT_EDITOR=" + quoteGitEditorExecutable(editor)})
	}
	return cmd.CombinedOutput()
}

// deriveInteractiveHistoryBase narrows an omitted lastRetainedCommitRef to
// the smallest first-parent range containing the requested commits. GitHub
// Desktop computes this boundary from the visible history list. The API can be
// called without that list, so derive the same boundary server-side rather
// than silently replaying the entire branch (and encountering an unrelated
// old merge commit).
func deriveInteractiveHistoryBase(repoRoot string, refs []string, operation string) (string, error) {
	if len(refs) == 0 {
		return "", fmt.Errorf("cannot derive %s history boundary without commits", operation)
	}

	resolved := make([]string, 0, len(refs))
	for _, ref := range refs {
		commit, err := verifyGitCommitRef(repoRoot, ref)
		if err != nil {
			return "", err
		}
		resolved = append(resolved, commit)
	}

	cmd := newGitCommand("rev-list", "--first-parent", "--parents", "HEAD", "--")
	cmd.Dir = repoRoot
	output, err := cmd.Output()
	if err != nil {
		return "", gitCommandError(err, output)
	}

	type firstParentEntry struct {
		sha         string
		parent      string
		parentCount int
	}
	entries := make([]firstParentEntry, 0)
	index := make(map[string]int)
	for _, line := range strings.Split(strings.TrimSpace(string(output)), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		if !isGitObjectID(fields[0]) {
			return "", errors.New("git returned an invalid commit while deriving interactive history boundary")
		}
		for _, parent := range fields[1:] {
			if !isGitObjectID(parent) {
				return "", errors.New("git returned an invalid parent while deriving interactive history boundary")
			}
		}
		if _, exists := index[fields[0]]; exists {
			return "", errors.New("git returned duplicate commits while deriving interactive history boundary")
		}
		index[fields[0]] = len(entries)
		entry := firstParentEntry{sha: fields[0], parentCount: len(fields) - 1}
		if len(fields) > 1 {
			entry.parent = fields[1]
		}
		entries = append(entries, entry)
	}
	if len(entries) == 0 {
		return "", errors.New("cannot derive interactive history boundary without a committed HEAD")
	}

	oldest := -1
	for i, commit := range resolved {
		position, ok := index[commit]
		if !ok {
			return "", fmt.Errorf(
				"%s commit %q is not on HEAD first-parent history; provide lastRetainedCommitRef explicitly",
				operation, refs[i],
			)
		}
		if entries[position].parentCount > 1 {
			return "", errors.New("interactive squash/reorder does not support merge commits")
		}
		if position > oldest {
			oldest = position
		}
	}
	if oldest < 0 {
		return "", errors.New("cannot derive interactive history boundary")
	}
	if oldest == len(entries)-1 {
		// The oldest requested commit is the root of the current branch, so Git's
		// --root form is the only valid spelling of the boundary.
		return "", nil
	}
	if entries[oldest].parent == "" {
		return "", errors.New("cannot derive parent of the oldest interactive commit")
	}
	return entries[oldest].parent, nil
}

// collectGitInteractiveCommits returns the linear commits that Git would
// replay for an interactive rebase. Merge commits are rejected deliberately:
// replaying them without --rebase-merges silently changes topology, which is
// unsafe for a history editor that only exposes a flat commit list.
func collectGitInteractiveCommits(repoRoot, lastRetainedCommitRef string) ([]string, map[string]int, error) {
	base := strings.TrimSpace(lastRetainedCommitRef)
	if base != "" {
		resolved, err := verifyGitCommitRef(repoRoot, base)
		if err != nil {
			return nil, nil, err
		}
		base = resolved
		ancestorCmd := newGitCommand("merge-base", "--is-ancestor", base, "HEAD")
		ancestorCmd.Dir = repoRoot
		if output, err := ancestorCmd.CombinedOutput(); err != nil {
			if message := strings.TrimSpace(string(output)); message != "" {
				return nil, nil, fmt.Errorf("last retained commit must be an ancestor of HEAD: %s", message)
			}
			return nil, nil, errors.New("last retained commit must be an ancestor of HEAD")
		}
	}

	revision := "HEAD"
	if base != "" {
		revision = base + "..HEAD"
	}
	cmd := newGitCommand("rev-list", "--reverse", "--topo-order", "--parents", revision, "--")
	cmd.Dir = repoRoot
	output, err := cmd.CombinedOutput()
	if err != nil {
		return nil, nil, gitCommandError(err, output)
	}

	commits := make([]string, 0)
	index := make(map[string]int)
	for _, line := range strings.Split(strings.TrimSpace(string(output)), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		if !isGitObjectID(fields[0]) {
			return nil, nil, errors.New("git returned an invalid commit while preparing interactive rebase")
		}
		if len(fields) > 2 {
			return nil, nil, errors.New("interactive squash/reorder does not support merge commits")
		}
		if _, exists := index[fields[0]]; exists {
			return nil, nil, errors.New("git returned duplicate commits while preparing interactive rebase")
		}
		if len(commits) >= maxGitInteractiveCommits {
			return nil, nil, fmt.Errorf("interactive history range is too large: maximum is %d commits", maxGitInteractiveCommits)
		}
		index[fields[0]] = len(commits)
		commits = append(commits, fields[0])
	}
	if len(commits) == 0 {
		return nil, nil, errors.New("interactive history range contains no commits")
	}
	return commits, index, nil
}

func resolveInteractiveCommitRefs(repoRoot string, refs []string, rangeIndex map[string]int, field string) ([]string, error) {
	if len(refs) == 0 {
		return nil, fmt.Errorf("at least one %s commit is required", field)
	}
	if len(refs) > maxGitOperationRefs {
		return nil, fmt.Errorf("too many %s commits: maximum is %d", field, maxGitOperationRefs)
	}
	resolved := make([]string, 0, len(refs))
	seen := make(map[string]struct{}, len(refs))
	for _, ref := range refs {
		commit, err := verifyGitCommitRef(repoRoot, ref)
		if err != nil {
			return nil, err
		}
		if _, ok := rangeIndex[commit]; !ok {
			return nil, fmt.Errorf("%s commit is outside the retained history range: %s", field, ref)
		}
		if _, duplicate := seen[commit]; duplicate {
			return nil, fmt.Errorf("%s contains duplicate commit: %s", field, ref)
		}
		seen[commit] = struct{}{}
		resolved = append(resolved, commit)
	}
	return resolved, nil
}

func validateGitInteractiveMessage(message string) error {
	if len(message) > 1024*1024 {
		return errors.New("commit message is too large")
	}
	if strings.IndexByte(message, 0) >= 0 {
		return errors.New("commit message contains NUL")
	}
	return nil
}

// buildGitSquashTodo mirrors Desktop's history semantics: commits selected
// before the target are held until the target is reached, then the target and
// all selected commits are emitted as one pick/squash group. Unselected
// commits after the target are replayed after that group.
func buildGitSquashTodo(commits, toSquash []string, squashOnto string) ([]string, error) {
	if len(toSquash) == 0 {
		return nil, errors.New("at least one toSquash commit is required")
	}
	selected := make(map[string]struct{}, len(toSquash))
	for _, sha := range toSquash {
		if sha == squashOnto {
			return nil, errors.New("the commits to squash cannot contain squashOnto")
		}
		selected[sha] = struct{}{}
	}

	lines := make([]string, 0, len(commits))
	before := make([]string, 0, len(toSquash))
	afterSelected := make([]string, 0, len(toSquash))
	afterNormal := make([]string, 0, len(commits))
	foundTarget := false
	foundSelected := 0
	for _, sha := range commits {
		if _, ok := selected[sha]; ok {
			foundSelected++
			if foundTarget {
				afterSelected = append(afterSelected, sha)
			} else {
				before = append(before, sha)
			}
			continue
		}
		if sha == squashOnto {
			foundTarget = true
			group := append(append([]string(nil), before...), sha)
			for i, groupSHA := range group {
				action := "squash"
				if i == 0 {
					action = "pick"
				}
				lines = append(lines, action+" "+groupSHA)
			}
			continue
		}
		if foundTarget {
			afterNormal = append(afterNormal, sha)
		} else {
			lines = append(lines, "pick "+sha)
		}
	}
	if !foundTarget {
		return nil, errors.New("squashOnto commit is not in the retained history range")
	}
	if foundSelected != len(toSquash) {
		return nil, errors.New("one or more toSquash commits are not in the retained history range")
	}
	for _, sha := range afterSelected {
		lines = append(lines, "squash "+sha)
	}
	for _, sha := range afterNormal {
		lines = append(lines, "pick "+sha)
	}
	return lines, nil
}

func buildGitReorderTodo(commits, toMove []string, beforeCommit string) ([]string, error) {
	if len(toMove) == 0 {
		return nil, errors.New("at least one toMove commit is required")
	}
	moving := make(map[string]struct{}, len(toMove))
	for _, sha := range toMove {
		if _, duplicate := moving[sha]; duplicate {
			return nil, errors.New("toMove contains duplicate commit")
		}
		moving[sha] = struct{}{}
	}
	commitSet := make(map[string]struct{}, len(commits))
	for _, sha := range commits {
		commitSet[sha] = struct{}{}
	}
	for sha := range moving {
		if _, ok := commitSet[sha]; !ok {
			return nil, errors.New("toMove commit is outside the retained history range")
		}
	}
	if beforeCommit != "" {
		if _, ok := commitSet[beforeCommit]; !ok {
			return nil, errors.New("beforeCommit is not in the retained history range")
		}
		if _, ok := moving[beforeCommit]; ok {
			return nil, errors.New("toMove commits cannot contain beforeCommit")
		}
	}
	lines := make([]string, 0, len(commits))
	inserted := false
	for _, sha := range commits {
		if _, ok := moving[sha]; ok {
			continue
		}
		if beforeCommit != "" && sha == beforeCommit {
			for _, candidate := range commits {
				if _, ok := moving[candidate]; ok {
					lines = append(lines, "pick "+candidate)
				}
			}
			inserted = true
		}
		lines = append(lines, "pick "+sha)
	}
	if beforeCommit != "" && !inserted {
		return nil, errors.New("beforeCommit is not in the retained history range")
	}
	if beforeCommit == "" {
		for _, sha := range commits {
			if _, ok := moving[sha]; ok {
				lines = append(lines, "pick "+sha)
			}
		}
	}
	if len(lines) != len(commits) {
		return nil, errors.New("reorder todo list does not contain the complete retained history")
	}
	return lines, nil
}

func shellQuoteGitEditorPath(path string) string {
	return "'" + strings.ReplaceAll(path, "'", "'\"'\"'") + "'"
}

func quoteGitEditorExecutable(path string) string {
	if runtime.GOOS == "windows" {
		return `"` + strings.ReplaceAll(path, `"`, `\"`) + `"`
	}
	return shellQuoteGitEditorPath(path)
}

func createGitEditorScript(prefix, sourcePath string) (string, error) {
	suffix := ".sh"
	// The source is an absolute path created by os.CreateTemp, so it cannot be
	// interpreted as an option. Omitting GNU-only `--` keeps the editor usable
	// with BSD `cp` on macOS as well.
	content := "#!/bin/sh\nset -eu\ncp " + shellQuoteGitEditorPath(sourcePath) + " \"$1\"\n"
	if runtime.GOOS == "windows" {
		suffix = ".cmd"
		content = "@echo off\r\ncopy /Y \"" + strings.ReplaceAll(sourcePath, "\"", "\"\"") + "\" \"%~1\" >NUL\r\n"
	}
	file, err := os.CreateTemp("", prefix+"-*"+suffix)
	if err != nil {
		return "", fmt.Errorf("cannot create Git editor script: %w", err)
	}
	path := file.Name()
	mode := os.FileMode(0700)
	if runtime.GOOS == "windows" {
		mode = 0600
	}
	if err := file.Chmod(mode); err != nil {
		_ = file.Close()
		_ = os.Remove(path)
		return "", fmt.Errorf("cannot set Git editor script mode: %w", err)
	}
	if _, err := file.WriteString(content); err != nil {
		_ = file.Close()
		_ = os.Remove(path)
		return "", fmt.Errorf("cannot write Git editor script: %w", err)
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(path)
		return "", fmt.Errorf("cannot close Git editor script: %w", err)
	}
	return path, nil
}

func gitInteractiveRewriteStatePath(repoRoot string) string {
	gitDir := absoluteGitDir(repoRoot)
	if gitDir == "" {
		return ""
	}
	return filepath.Join(gitDir, gitInteractiveRewriteStateFile)
}

func clearGitInteractiveRewriteState(repoRoot string) error {
	path := gitInteractiveRewriteStatePath(repoRoot)
	if path == "" {
		return nil
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("cannot clear interactive rewrite state: %w", err)
	}
	return nil
}

func writeGitInteractiveRewriteState(repoRoot, operation, message string) error {
	if operation != "squash" {
		return errors.New("invalid interactive rewrite operation")
	}
	if err := validateGitInteractiveMessage(message); err != nil {
		return err
	}
	if strings.TrimSpace(message) == "" {
		return clearGitInteractiveRewriteState(repoRoot)
	}
	if err := clearGitInteractiveRewriteState(repoRoot); err != nil {
		return err
	}
	gitDir := absoluteGitDir(repoRoot)
	if gitDir == "" {
		return errors.New("cannot locate git metadata while recording interactive rewrite state")
	}
	payload, err := json.Marshal(gitInteractiveRewriteState{Operation: operation, Message: message})
	if err != nil {
		return fmt.Errorf("cannot encode interactive rewrite state: %w", err)
	}
	payload = append(payload, '\n')
	tmp, err := os.CreateTemp(gitDir, ".vibego-interactive-rewrite-*")
	if err != nil {
		return fmt.Errorf("cannot create interactive rewrite state: %w", err)
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if err := tmp.Chmod(0600); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("cannot set interactive rewrite state mode: %w", err)
	}
	if _, err := tmp.Write(payload); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("cannot write interactive rewrite state: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("cannot close interactive rewrite state: %w", err)
	}
	if err := os.Rename(tmpPath, gitInteractiveRewriteStatePath(repoRoot)); err != nil {
		return fmt.Errorf("cannot install interactive rewrite state: %w", err)
	}
	return nil
}

func readGitInteractiveRewriteState(repoRoot string) (*gitInteractiveRewriteState, error) {
	path := gitInteractiveRewriteStatePath(repoRoot)
	if path == "" {
		return nil, nil
	}
	content, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("cannot read interactive rewrite state: %w", err)
	}
	var state gitInteractiveRewriteState
	if err := json.Unmarshal(content, &state); err != nil {
		return nil, fmt.Errorf("cannot parse interactive rewrite state: %w", err)
	}
	if state.Operation != "squash" {
		return nil, errors.New("invalid interactive rewrite state operation")
	}
	if err := validateGitInteractiveMessage(state.Message); err != nil {
		return nil, fmt.Errorf("invalid interactive rewrite state message: %w", err)
	}
	return &state, nil
}

func finalizeGitInteractiveRewriteState(repoRoot string, commandErr error) error {
	if commandErr != nil && collectGitOperationDiskState(repoRoot).Operation == "rebase" {
		return nil
	}
	return clearGitInteractiveRewriteState(repoRoot)
}

func createGitSquashContinueEditor(prefix, message, repoRoot string) (string, string, error) {
	messageFile, err := os.CreateTemp("", prefix+"-message-*")
	if err != nil {
		return "", "", fmt.Errorf("cannot create squash commit message: %w", err)
	}
	messagePath := messageFile.Name()
	if err := messageFile.Chmod(0600); err != nil {
		_ = messageFile.Close()
		_ = os.Remove(messagePath)
		return "", "", fmt.Errorf("cannot set squash commit message mode: %w", err)
	}
	if _, err := messageFile.WriteString(message); err != nil {
		_ = messageFile.Close()
		_ = os.Remove(messagePath)
		return "", "", fmt.Errorf("cannot write squash commit message: %w", err)
	}
	if err := messageFile.Close(); err != nil {
		_ = os.Remove(messagePath)
		return "", "", fmt.Errorf("cannot close squash commit message: %w", err)
	}
	editor, err := createGitSquashEditorScript(prefix, messagePath, repoRoot)
	if err != nil {
		_ = os.Remove(messagePath)
		return "", "", err
	}
	return editor, messagePath, nil
}

func createGitSquashEditorScript(prefix, sourcePath, repoRoot string) (string, error) {
	gitDir := absoluteGitDir(repoRoot)
	if gitDir == "" {
		return "", errors.New("cannot locate git metadata while creating squash editor")
	}
	donePath := filepath.Join(gitDir, "rebase-merge", "done")
	suffix := ".sh"
	content := "#!/bin/sh\nset -eu\n" +
		"if [ -f " + shellQuoteGitEditorPath(donePath) + " ] && " +
		"tail -n 1 " + shellQuoteGitEditorPath(donePath) + " | grep -q '^squash '; then\n" +
		"  cp " + shellQuoteGitEditorPath(sourcePath) + " \"$1\"\n" +
		"fi\n"
	if runtime.GOOS == "windows" {
		suffix = ".cmd"
		quotedDone := strings.ReplaceAll(donePath, "\"", "\"\"")
		quotedSource := strings.ReplaceAll(sourcePath, "\"", "\"\"")
		content = "@echo off\r\nsetlocal EnableDelayedExpansion\r\nset \"last=\"\r\n" +
			"for /F \"usebackq delims=\" %%L in (\"" + quotedDone + "\") do set \"last=%%L\"\r\n" +
			"if /I \"!last:~0,7!\"==\"squash \" copy /Y \"" + quotedSource + "\" \"%~1\" >NUL\r\n"
	}
	file, err := os.CreateTemp("", prefix+"-*"+suffix)
	if err != nil {
		return "", fmt.Errorf("cannot create Git editor script: %w", err)
	}
	path := file.Name()
	mode := os.FileMode(0700)
	if runtime.GOOS == "windows" {
		mode = 0600
	}
	if err := file.Chmod(mode); err != nil {
		_ = file.Close()
		_ = os.Remove(path)
		return "", fmt.Errorf("cannot set Git editor script mode: %w", err)
	}
	if _, err := file.WriteString(content); err != nil {
		_ = file.Close()
		_ = os.Remove(path)
		return "", fmt.Errorf("cannot write Git editor script: %w", err)
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(path)
		return "", fmt.Errorf("cannot close Git editor script: %w", err)
	}
	return path, nil
}

func runGitInteractiveHistoryRewrite(repoRoot, operation, lastRetainedCommitRef string, todo []string, message string) ([]byte, error) {
	if len(todo) == 0 {
		return nil, errors.New("interactive rebase todo is empty")
	}
	todoFile, err := os.CreateTemp("", "vibego-git-"+operation+"-todo-*")
	if err != nil {
		return nil, fmt.Errorf("cannot create interactive rebase todo: %w", err)
	}
	todoPath := todoFile.Name()
	defer func() { _ = os.Remove(todoPath) }()
	if err := todoFile.Chmod(0600); err != nil {
		_ = todoFile.Close()
		return nil, fmt.Errorf("cannot set interactive rebase todo mode: %w", err)
	}
	content := strings.Join(todo, "\n") + "\n"
	if _, err := todoFile.WriteString(content); err != nil {
		_ = todoFile.Close()
		return nil, fmt.Errorf("cannot write interactive rebase todo: %w", err)
	}
	if err := todoFile.Close(); err != nil {
		return nil, fmt.Errorf("cannot close interactive rebase todo: %w", err)
	}

	sequenceEditor, err := createGitEditorScript("vibego-git-sequence", todoPath)
	if err != nil {
		return nil, err
	}
	defer func() { _ = os.Remove(sequenceEditor) }()

	messageEditor := ""
	if strings.TrimSpace(message) != "" {
		messageFile, createErr := os.CreateTemp("", "vibego-git-message-*")
		if createErr != nil {
			return nil, fmt.Errorf("cannot create commit message: %w", createErr)
		}
		messagePath := messageFile.Name()
		defer func() { _ = os.Remove(messagePath) }()
		if chmodErr := messageFile.Chmod(0600); chmodErr != nil {
			_ = messageFile.Close()
			return nil, fmt.Errorf("cannot set commit message mode: %w", chmodErr)
		}
		if _, writeErr := messageFile.WriteString(message); writeErr != nil {
			_ = messageFile.Close()
			return nil, fmt.Errorf("cannot write commit message: %w", writeErr)
		}
		if closeErr := messageFile.Close(); closeErr != nil {
			return nil, fmt.Errorf("cannot close commit message: %w", closeErr)
		}
		messageEditor, err = createGitEditorScript("vibego-git-message", messagePath)
		if err != nil {
			return nil, err
		}
		defer func() { _ = os.Remove(messageEditor) }()
	}

	base := strings.TrimSpace(lastRetainedCommitRef)
	args := []string{"-c", "rebase.backend=merge", "rebase", "-i"}
	if base == "" {
		args = append(args, "--root")
	} else {
		base, err = verifyGitCommitRef(repoRoot, base)
		if err != nil {
			return nil, err
		}
		args = append(args, base)
	}
	cmd := newGitCommand(args...)
	cmd.Dir = repoRoot
	env := []string{"GIT_SEQUENCE_EDITOR=" + quoteGitEditorExecutable(sequenceEditor), "GIT_EDITOR=:"}
	if messageEditor != "" {
		env[1] = "GIT_EDITOR=" + quoteGitEditorExecutable(messageEditor)
	}
	cmd.Env = mergeEnv(cmd.Env, env)
	output, commandErr := cmd.CombinedOutput()
	return output, commandErr
}

// prepareGitOperationOwnershipState records options that Git does not retain
// for a single paused cherry-pick/revert (notably --mainline). The sidecar is
// kept inside .git and is written before invoking Git, so a conflict can be
// validated without guessing which parent supplied the patch.
func prepareGitOperationOwnershipState(repoRoot, operation string, commits []string, mainline int) error {
	if operation != "cherry-pick" && operation != "revert" {
		return nil
	}
	if mainline < 0 || mainline > 16 {
		return errors.New("mainline parent must be between 1 and 16")
	}
	if err := clearGitOperationOwnershipState(repoRoot); err != nil {
		return err
	}
	if mainline == 0 {
		return nil
	}
	if len(commits) == 0 {
		return errors.New("cannot record operation without a commit")
	}
	for _, commit := range commits {
		if !isGitObjectID(commit) {
			return errors.New("cannot record operation with an invalid commit")
		}
	}

	gitDir := absoluteGitDir(repoRoot)
	if gitDir == "" {
		return errors.New("cannot locate git metadata while starting operation")
	}
	originalHead, err := verifyGitCommitRef(repoRoot, "HEAD")
	if err != nil {
		return fmt.Errorf("cannot determine HEAD while starting operation: %w", err)
	}
	payload := gitOperationOwnershipState{
		Operation:    operation,
		Mainline:     mainline,
		OriginalHead: originalHead,
		Commits:      append([]string(nil), commits...),
	}
	content, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("cannot encode operation ownership state: %w", err)
	}
	content = append(content, '\n')
	tmp, err := os.CreateTemp(gitDir, ".vibego-operation-ownership-*")
	if err != nil {
		return fmt.Errorf("cannot create operation ownership state: %w", err)
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if err := tmp.Chmod(0600); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("cannot set operation ownership state mode: %w", err)
	}
	if _, err := tmp.Write(content); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("cannot write operation ownership state: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("cannot close operation ownership state: %w", err)
	}
	statePath := filepath.Join(gitDir, gitOperationOwnershipStateFile)
	if err := os.Rename(tmpPath, statePath); err != nil {
		return fmt.Errorf("cannot install operation ownership state: %w", err)
	}
	return nil
}

func finalizeGitOperationOwnershipState(repoRoot, operation string, output []byte, commandErr error) ([]byte, error) {
	state := collectGitOperationDiskState(repoRoot)
	if state.Operation != operation {
		// Once an operation completes, aborts, or fails before entering its
		// paused state, no parent-selection hint should survive for a later one.
		if err := clearGitOperationOwnershipState(repoRoot); err != nil {
			commandErr = errors.Join(commandErr, err)
		}
	}
	return output, commandErr
}

func gitOperationOwnershipStatePath(repoRoot string) string {
	gitDir := absoluteGitDir(repoRoot)
	if gitDir == "" {
		return ""
	}
	return filepath.Join(gitDir, gitOperationOwnershipStateFile)
}

func clearGitOperationOwnershipState(repoRoot string) error {
	path := gitOperationOwnershipStatePath(repoRoot)
	if path == "" {
		return nil
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("cannot clear operation ownership state: %w", err)
	}
	return nil
}

func readGitOperationOwnershipState(repoRoot string) (*gitOperationOwnershipState, error) {
	path := gitOperationOwnershipStatePath(repoRoot)
	if path == "" {
		return nil, nil
	}
	content, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("cannot read operation ownership state: %w", err)
	}
	var state gitOperationOwnershipState
	if err := json.Unmarshal(content, &state); err != nil {
		return nil, fmt.Errorf("cannot parse operation ownership state: %w", err)
	}
	if state.Operation != "cherry-pick" && state.Operation != "revert" {
		return nil, errors.New("invalid operation ownership state operation")
	}
	if state.Mainline < 1 || state.Mainline > 16 {
		return nil, errors.New("invalid operation ownership state mainline")
	}
	if !isGitObjectID(state.OriginalHead) {
		return nil, errors.New("operation ownership state has an invalid original HEAD")
	}
	if len(state.Commits) == 0 {
		return nil, errors.New("operation ownership state has no commits")
	}
	for _, commit := range state.Commits {
		if !isGitObjectID(commit) {
			return nil, errors.New("operation ownership state has an invalid commit")
		}
	}
	return &state, nil
}

func operationOwnershipContainsCommit(state *gitOperationOwnershipState, commit string) bool {
	if state == nil {
		return false
	}
	for _, candidate := range state.Commits {
		if candidate == commit {
			return true
		}
	}
	return false
}

// ensureGitOperationCanContinue prevents files staged by the caller while an
// operation is paused from being folded into the operation's next commit.
// Git's continue commands consume the complete index, so checking only the
// paths supplied in the request is insufficient: a caller can have staged an
// unrelated path between the conflict and the continue request.
func ensureGitOperationCanContinue(repoRoot, operation string, files []string) error {
	if len(files) > maxGitOperationRefs {
		return &gitOperationValidationError{err: fmt.Errorf("too many files: maximum is %d", maxGitOperationRefs)}
	}

	// Validate every request path before inspecting or changing the index. The
	// staging helper performs the same validation, but doing it here guarantees
	// that this guard remains side-effect free on every rejection path.
	for _, file := range files {
		if _, err := validateGitOperationPath(repoRoot, file); err != nil {
			return &gitOperationValidationError{err: err}
		}
	}

	owned, err := collectGitOperationOwnedPaths(repoRoot, operation)
	if err != nil {
		return &gitOperationValidationError{err: err}
	}
	for _, conflict := range collectConflictFiles(repoRoot) {
		owned[conflict] = struct{}{}
	}

	for _, file := range files {
		path, pathErr := validateGitOperationPath(repoRoot, file)
		if pathErr != nil {
			// The same validation was already performed above. Keep this branch
			// defensive in case validation rules change independently.
			return &gitOperationValidationError{err: pathErr}
		}
		if _, ok := owned[path]; !ok {
			return &gitOperationValidationError{err: fmt.Errorf(
				"%s operation cannot continue with unrelated path %q",
				operation, path,
			)}
		}
	}

	staged, err := collectGitStagedPaths(repoRoot)
	if err != nil {
		return &gitOperationValidationError{err: fmt.Errorf(
			"cannot inspect staged paths before continuing %s operation: %w",
			operation, err,
		)}
	}
	for _, path := range staged {
		if _, ok := owned[path]; ok {
			continue
		}
		return &gitOperationValidationError{err: fmt.Errorf(
			"%s operation has unrelated staged path %q; unstage it before continuing",
			operation, path,
		)}
	}
	return nil
}

// collectGitOperationOwnedPaths returns paths that Git may legitimately have
// placed in the index for the current operation. For merge, only paths changed
// on the incoming side since the merge base are owned; paths changed solely by
// the current branch remain caller-owned. Conflict paths are added separately
// because their final resolution can differ from either side.
func collectGitOperationOwnedPaths(repoRoot, operation string) (map[string]struct{}, error) {
	owned := make(map[string]struct{})
	gitDir := absoluteGitDir(repoRoot)
	if gitDir == "" {
		return nil, errors.New("cannot locate git metadata while continuing operation")
	}

	addPaths := func(paths map[string]struct{}) {
		for path := range paths {
			owned[path] = struct{}{}
		}
	}

	switch operation {
	case "merge":
		mergeHeads := readGitStateFile(filepath.Join(gitDir, "MERGE_HEAD"))
		lines := strings.Split(mergeHeads, "\n")
		foundHead := false
		currentHead, headErr := verifyGitCommitRef(repoRoot, "HEAD")
		if headErr != nil {
			return nil, fmt.Errorf("cannot determine current HEAD for merge operation: %w", headErr)
		}
		for _, line := range lines {
			incomingHead := strings.TrimSpace(line)
			if incomingHead == "" {
				continue
			}
			foundHead = true
			if !isGitObjectID(incomingHead) {
				return nil, errors.New("cannot determine merge paths from invalid MERGE_HEAD")
			}
			base, err := gitMergeBase(repoRoot, currentHead, incomingHead)
			if err != nil {
				return nil, fmt.Errorf("cannot determine merge base for merge operation: %w", err)
			}
			paths, err := collectGitNameOnlyPaths(repoRoot,
				"diff-tree", "--no-commit-id", "-r", "--name-only", "--no-renames", "-z",
				"--end-of-options", base, incomingHead, "--",
			)
			if err != nil {
				return nil, fmt.Errorf("cannot determine paths affected by merge operation: %w", err)
			}
			addPaths(paths)
		}
		if !foundHead {
			return nil, errors.New("cannot determine paths affected by merge operation")
		}

	case "rebase", "cherry-pick", "revert":
		state := collectGitOperationDiskState(repoRoot)
		commit := state.CurrentCommit
		if operation == "rebase" && !isGitObjectID(commit) {
			// Depending on the rebase backend and Git version, REBASE_HEAD can
			// be absent while the paused commit is recorded in stopped-sha.
			for _, dirName := range []string{"rebase-merge", "rebase-apply"} {
				candidate := readGitStateFile(filepath.Join(gitDir, dirName, "stopped-sha"))
				if isGitObjectID(candidate) {
					commit = candidate
					break
				}
			}
		}
		if !isGitObjectID(commit) {
			return nil, fmt.Errorf("cannot determine paths affected by %s operation", operation)
		}
		if operation == "rebase" {
			parents, parentErr := gitCommitParents(repoRoot, commit)
			if parentErr != nil {
				return nil, fmt.Errorf("cannot determine parents for rebase operation: %w", parentErr)
			}
			if len(parents) > 1 {
				return nil, fmt.Errorf(
					"cannot determine mainline parent for rebase merge commit %s",
					commit,
				)
			}
		}
		mainline := 0
		if operation == "cherry-pick" || operation == "revert" {
			var err error
			mainline, err = gitOperationMainline(repoRoot, operation, commit)
			if err != nil {
				return nil, err
			}
		}
		paths, err := collectGitCommitChangedPaths(repoRoot, commit, mainline)
		if err != nil {
			return nil, fmt.Errorf("cannot determine paths affected by %s operation: %w", operation, err)
		}
		addPaths(paths)

	default:
		return nil, fmt.Errorf("unsupported Git operation: %s", operation)
	}
	return owned, nil
}

// gitMergeBase returns the common ancestor used to determine which paths came
// from an incoming merge head. Comparing the incoming head directly to HEAD
// would also include paths introduced only by the current branch after the
// fork, incorrectly treating caller-staged changes to those paths as part of
// the merge operation.
func gitMergeBase(repoRoot, currentHead, incomingHead string) (string, error) {
	if !isGitObjectID(currentHead) || !isGitObjectID(incomingHead) {
		return "", errors.New("invalid merge head")
	}
	cmd := newGitCommand("merge-base", "--end-of-options", currentHead, incomingHead)
	cmd.Dir = repoRoot
	output, err := cmd.Output()
	if err != nil {
		return "", gitCommandError(err, output)
	}
	base := strings.TrimSpace(string(output))
	if !isGitObjectID(base) {
		return "", errors.New("invalid merge base")
	}
	return base, nil
}

func collectGitStagedPaths(repoRoot string) ([]string, error) {
	return collectGitNameOnlyPathList(repoRoot,
		"diff", "--cached", "--name-only", "--no-renames", "-z", "--",
	)
}

func collectGitNameOnlyPaths(repoRoot string, args ...string) (map[string]struct{}, error) {
	paths, err := collectGitNameOnlyPathList(repoRoot, args...)
	if err != nil {
		return nil, err
	}
	result := make(map[string]struct{}, len(paths))
	for _, path := range paths {
		result[path] = struct{}{}
	}
	return result, nil
}

func collectGitNameOnlyPathList(repoRoot string, args ...string) ([]string, error) {
	cmd := newGitCommand(args...)
	cmd.Dir = repoRoot
	output, err := cmd.CombinedOutput()
	if err != nil {
		return nil, gitCommandError(err, output)
	}
	parts := strings.Split(string(output), "\x00")
	paths := make([]string, 0, len(parts))
	for _, path := range parts {
		if path != "" {
			paths = append(paths, path)
		}
	}
	return paths, nil
}

func stageGitOperationFiles(repoRoot string, files []string) error {
	if len(files) == 0 {
		return nil
	}
	if len(files) > maxGitOperationRefs {
		return &gitOperationValidationError{err: fmt.Errorf("too many files: maximum is %d", maxGitOperationRefs)}
	}
	// Pathspec magic (for example `:(top,glob)**`) would otherwise turn a
	// single requested path into a repository-wide add. Keep Git's pathspec
	// parser in literal mode even though the input is validated below.
	args := []string{"--literal-pathspecs", "add", "--"}
	for _, file := range files {
		path, err := validateGitOperationPath(repoRoot, file)
		if err != nil {
			return &gitOperationValidationError{err: err}
		}
		args = append(args, path)
	}
	cmd := newGitCommand(args...)
	cmd.Dir = repoRoot
	output, err := cmd.CombinedOutput()
	if err != nil {
		return gitCommandError(err, output)
	}
	return nil
}

func validateGitOperationPath(repoRoot, file string) (string, error) {
	file = strings.TrimSpace(file)
	if err := validateRepoRelativePath(repoRoot, file); err != nil {
		return "", err
	}
	if strings.HasPrefix(file, ":") {
		return "", errors.New("file path cannot start with ':'")
	}
	clean := filepath.Clean(filepath.FromSlash(file))
	// `git add <directory>` recursively stages every path below it. The
	// operation API is file-scoped, so reject an existing directory while still
	// allowing a missing path (Git uses that form to stage a deletion).
	absolutePath := filepath.Join(repoRoot, clean)
	if info, err := os.Stat(absolutePath); err == nil {
		if info.IsDir() {
			return "", errors.New("file path must name a file, not a directory")
		}
	} else if !os.IsNotExist(err) {
		return "", fmt.Errorf("cannot inspect file path: %w", err)
	}
	return filepath.ToSlash(clean), nil
}

func ensureGitOperationCanStart(repoRoot string) error {
	return ensureGitOperationCanStartWithPolicy(repoRoot, true)
}

func ensureGitOperationCanStartWithPolicy(repoRoot string, rejectStaged bool) error {
	state := collectGitOperationDiskState(repoRoot)
	if state.Operation != "none" {
		return fmt.Errorf("%s operation is already in progress", state.Operation)
	}
	if len(collectConflictFiles(repoRoot)) > 0 {
		return errors.New("repository has unresolved conflicts")
	}
	if rejectStaged && hasGitStagedChanges(repoRoot) {
		return errors.New("repository has staged changes; commit or unstage them before starting an operation")
	}
	return nil
}

// hasGitStagedChanges reports whether the index differs from HEAD. Advanced
// history operations use Git's index to assemble their own commits, so an
// existing staged change must be handled by the caller before they start.
func hasGitStagedChanges(repoRoot string) bool {
	cmd := newGitCommand("diff", "--cached", "--name-only", "-z", "--")
	cmd.Dir = repoRoot
	output, err := cmd.Output()
	if err != nil {
		// A non-zero diff command (for example an unmerged index) is not a clean
		// index. Conflicts are reported separately by ensureGitOperationCanStart.
		return true
	}
	return len(output) > 0
}

func requireGitOperation(repoRoot, expected string) error {
	state := collectGitOperationDiskState(repoRoot)
	if state.Operation == expected {
		return nil
	}
	if state.Operation == "none" {
		return fmt.Errorf("no %s operation is in progress", expected)
	}
	return fmt.Errorf("cannot continue %s while %s is in progress", expected, state.Operation)
}

func verifyGitCommitRefs(repoRoot string, refs []string) ([]string, error) {
	if len(refs) == 0 {
		return nil, errors.New("at least one commit is required")
	}
	if len(refs) > maxGitOperationRefs {
		return nil, fmt.Errorf("too many commits: maximum is %d", maxGitOperationRefs)
	}
	commits := make([]string, 0, len(refs))
	for _, ref := range refs {
		commit, err := verifyGitCommitRef(repoRoot, ref)
		if err != nil {
			return nil, err
		}
		commits = append(commits, commit)
	}
	return commits, nil
}

func ensureGitCherryPickCommitsNotAncestors(repoRoot string, commits []string) error {
	hasHead, err := gitHeadHasCommit(repoRoot)
	if err != nil {
		return fmt.Errorf("cannot inspect HEAD before cherry-pick: %w", err)
	}
	if !hasHead {
		return nil
	}

	for _, commit := range commits {
		cmd := newGitCommand("merge-base", "--is-ancestor", commit, "HEAD")
		cmd.Dir = repoRoot
		output, commandErr := cmd.CombinedOutput()
		if commandErr == nil {
			return fmt.Errorf("commit is already an ancestor of HEAD: %s", commit)
		}

		var exitErr *exec.ExitError
		if errors.As(commandErr, &exitErr) && exitErr.ExitCode() == 1 {
			continue
		}
		return fmt.Errorf("cannot inspect cherry-pick commit ancestry: %w", gitCommandError(commandErr, output))
	}
	return nil
}

func verifyGitCommitRef(repoRoot, ref string) (string, error) {
	ref = strings.TrimSpace(ref)
	if err := validateGitOperationRef(ref); err != nil {
		return "", err
	}

	peelSuffix := "^{commit}"
	// Desktop represents the retained boundary as `commit^`. A terminal caret
	// is already a complete parent selector; appending the usual peel suffix
	// would change the revision expression rather than merely assert its type.
	if strings.HasSuffix(ref, "^") {
		peelSuffix = ""
	}
	cmd := newGitCommand("rev-parse", "--verify", "--quiet", "--end-of-options", ref+peelSuffix)
	cmd.Dir = repoRoot
	output, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("commit not found: %s", ref)
	}
	commit := strings.TrimSpace(string(output))
	if !isGitObjectID(commit) {
		return "", fmt.Errorf("invalid commit resolved from ref: %s", ref)
	}
	return commit, nil
}

func verifyLocalGitBranch(repoRoot, branch string) (string, error) {
	var err error
	branch, err = normalizeGitBranchName(repoRoot, branch)
	if err != nil {
		return "", err
	}

	fullRef := "refs/heads/" + branch
	if _, err := verifyGitCommitRef(repoRoot, fullRef); err != nil {
		return "", fmt.Errorf("local branch not found: %s", branch)
	}
	return branch, nil
}

func validateGitOperationRef(ref string) error {
	if ref == "" {
		return errors.New("git reference is required")
	}
	if len(ref) > 1024 {
		return errors.New("git reference is too long")
	}
	if strings.HasPrefix(ref, "-") {
		return errors.New("git reference cannot start with '-'")
	}
	for _, r := range ref {
		if r == '\x00' || r == '\x7f' || unicode.IsControl(r) {
			return errors.New("git reference contains control characters")
		}
	}
	return nil
}

func isGitObjectID(value string) bool {
	if len(value) != 40 && len(value) != 64 {
		return false
	}
	for _, r := range value {
		if !(r >= '0' && r <= '9') && !(r >= 'a' && r <= 'f') && !(r >= 'A' && r <= 'F') {
			return false
		}
	}
	return true
}

func gitCommitParents(repoRoot, commit string) ([]string, error) {
	cmd := newGitCommand("rev-list", "--parents", "-n", "1", "--end-of-options", commit)
	cmd.Dir = repoRoot
	output, err := cmd.Output()
	if err != nil {
		return nil, gitCommandError(err, output)
	}
	fields := strings.Fields(string(output))
	if len(fields) == 0 || !isGitObjectID(fields[0]) {
		return nil, errors.New("invalid commit while reading parents")
	}
	parents := make([]string, 0, len(fields)-1)
	for _, parent := range fields[1:] {
		if !isGitObjectID(parent) {
			return nil, errors.New("invalid parent while reading commit")
		}
		parents = append(parents, parent)
	}
	return parents, nil
}

func gitCommitParentCount(repoRoot, commit string) int {
	parents, err := gitCommitParents(repoRoot, commit)
	if err != nil {
		return 0
	}
	return len(parents)
}

func collectGitCommitChangedPaths(repoRoot, commit string, mainline int) (map[string]struct{}, error) {
	parents, err := gitCommitParents(repoRoot, commit)
	if err != nil {
		return nil, err
	}
	args := []string{"diff-tree", "--no-commit-id", "-r", "--name-only", "--no-renames", "-z"}
	if len(parents) == 0 {
		args = append(args, "--root", "--end-of-options", commit, "--")
		return collectGitNameOnlyPaths(repoRoot, args...)
	}
	if mainline == 0 {
		mainline = 1
	}
	if mainline < 1 || mainline > len(parents) {
		return nil, fmt.Errorf("mainline parent %d is unavailable for commit with %d parents", mainline, len(parents))
	}
	args = append(args, "--end-of-options", parents[mainline-1], commit, "--")
	return collectGitNameOnlyPaths(repoRoot, args...)
}

func gitOperationMainline(repoRoot, operation, commit string) (int, error) {
	parents, err := gitCommitParents(repoRoot, commit)
	if err != nil {
		return 0, fmt.Errorf("cannot determine parents for %s operation: %w", operation, err)
	}
	if len(parents) <= 1 {
		return 0, nil
	}

	state, err := readGitOperationOwnershipState(repoRoot)
	if err != nil {
		return 0, err
	}
	if state != nil && state.Operation == operation && operationOwnershipContainsCommit(state, commit) {
		gitDir := absoluteGitDir(repoRoot)
		operationHead := readGitStateFile(filepath.Join(gitDir, "sequencer", "head"))
		if !isGitObjectID(operationHead) {
			operationHead, err = verifyGitCommitRef(repoRoot, "HEAD")
			if err != nil {
				return 0, fmt.Errorf("cannot determine operation HEAD: %w", err)
			}
		}
		if state.OriginalHead == operationHead {
			if state.Mainline > len(parents) {
				return 0, fmt.Errorf("mainline parent %d is unavailable for commit with %d parents", state.Mainline, len(parents))
			}
			return state.Mainline, nil
		}
	}

	gitDir := absoluteGitDir(repoRoot)
	if mainline, found, err := readGitSequencerMainline(filepath.Join(gitDir, "sequencer", "opts")); err != nil {
		return 0, err
	} else if found {
		if mainline > len(parents) {
			return 0, fmt.Errorf("mainline parent %d is unavailable for commit with %d parents", mainline, len(parents))
		}
		return mainline, nil
	}
	return 0, fmt.Errorf(
		"cannot determine mainline parent for %s merge commit %s; restart it through the VibeGo API",
		operation, commit,
	)
}

func readGitSequencerMainline(path string) (int, bool, error) {
	content, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, false, nil
		}
		return 0, false, fmt.Errorf("cannot read sequencer options: %w", err)
	}
	for _, line := range strings.Split(string(content), "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "mainline") {
			continue
		}
		parts := strings.SplitN(line, "=", 2)
		if len(parts) != 2 || strings.TrimSpace(parts[0]) != "mainline" {
			return 0, false, errors.New("invalid sequencer mainline option")
		}
		mainline, err := strconv.Atoi(strings.TrimSpace(parts[1]))
		if err != nil || mainline < 1 || mainline > 16 {
			return 0, false, errors.New("invalid sequencer mainline option")
		}
		return mainline, true, nil
	}
	return 0, false, nil
}

func collectGitOperationDiskState(repoRoot string) gitOperationDiskState {
	state := gitOperationDiskState{
		Operation: "none",
		State:     "idle",
		HeadRef:   gitSymbolicHead(repoRoot),
	}
	gitDir := absoluteGitDir(repoRoot)
	if gitDir == "" {
		return state
	}

	rebaseDir := ""
	for _, name := range []string{"rebase-merge", "rebase-apply"} {
		candidate := filepath.Join(gitDir, name)
		if gitPathExists(candidate) {
			rebaseDir = candidate
			break
		}
	}
	// Git uses the same rebase-apply directory for `git am`. The applying
	// marker identifies that mail-application state; it is not a rebase and
	// must not be exposed as one or be accepted by the rebase continue/abort
	// endpoints. Rebase's apply backend creates a rebasing marker instead.
	if rebaseDir != "" &&
		gitPathExists(filepath.Join(rebaseDir, "applying")) &&
		!gitPathExists(filepath.Join(rebaseDir, "rebasing")) {
		rebaseDir = ""
	}
	if gitPathExists(filepath.Join(gitDir, "REBASE_HEAD")) || rebaseDir != "" {
		state.Operation = "rebase"
		state.State = "in_progress"
		state.CurrentCommit = readGitStateFile(filepath.Join(gitDir, "REBASE_HEAD"))
		if rebaseDir != "" {
			state.OriginalHead = readGitStateFile(filepath.Join(rebaseDir, "orig-head"))
			state.BaseRef = readGitStateFile(filepath.Join(rebaseDir, "onto"))
			state.TargetRef = strings.TrimPrefix(readGitStateFile(filepath.Join(rebaseDir, "head-name")), "refs/heads/")
			state.Progress = collectRebaseProgress(repoRoot, rebaseDir, state.CurrentCommit)
		}
		if len(collectConflictFiles(repoRoot)) > 0 {
			state.State = "conflicts"
		}
		return state
	}

	if gitPathExists(filepath.Join(gitDir, "CHERRY_PICK_HEAD")) {
		state.Operation = "cherry-pick"
		state.State = "in_progress"
		state.CurrentCommit = readGitStateFile(filepath.Join(gitDir, "CHERRY_PICK_HEAD"))
		state.OriginalHead = readGitStateFile(filepath.Join(gitDir, "sequencer", "head"))
		state.Progress = collectSequencerProgress(repoRoot, gitDir, state.CurrentCommit)
		if len(collectConflictFiles(repoRoot)) > 0 {
			state.State = "conflicts"
		}
		return state
	}

	if gitPathExists(filepath.Join(gitDir, "REVERT_HEAD")) {
		state.Operation = "revert"
		state.State = "in_progress"
		state.CurrentCommit = readGitStateFile(filepath.Join(gitDir, "REVERT_HEAD"))
		state.OriginalHead = readGitStateFile(filepath.Join(gitDir, "sequencer", "head"))
		state.Progress = collectSequencerProgress(repoRoot, gitDir, state.CurrentCommit)
		if len(collectConflictFiles(repoRoot)) > 0 {
			state.State = "conflicts"
		}
		return state
	}

	if gitPathExists(filepath.Join(gitDir, "MERGE_HEAD")) {
		state.Operation = "merge"
		state.State = "in_progress"
		state.CurrentCommit = firstGitStateLine(filepath.Join(gitDir, "MERGE_HEAD"))
		state.OriginalHead = readGitStateFile(filepath.Join(gitDir, "ORIG_HEAD"))
		state.Progress = operationProgress(repoRoot, 1, 1, state.CurrentCommit)
		if len(collectConflictFiles(repoRoot)) > 0 {
			state.State = "conflicts"
		}
	}

	return state
}

func absoluteGitDir(repoRoot string) string {
	cmd := newGitCommand("rev-parse", "--absolute-git-dir")
	cmd.Dir = repoRoot
	output, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(output))
}

func gitSymbolicHead(repoRoot string) string {
	cmd := newGitCommand("symbolic-ref", "--quiet", "--short", "HEAD")
	cmd.Dir = repoRoot
	output, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(output))
}

func gitPathExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func readGitStateFile(path string) string {
	content, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(content))
}

func firstGitStateLine(path string) string {
	value := readGitStateFile(path)
	if index := strings.IndexByte(value, '\n'); index >= 0 {
		return strings.TrimSpace(value[:index])
	}
	return value
}

func collectRebaseProgress(repoRoot, rebaseDir, currentCommit string) *GitOperationProgress {
	position := readPositiveGitStateInt(filepath.Join(rebaseDir, "msgnum"))
	total := readPositiveGitStateInt(filepath.Join(rebaseDir, "end"))
	if position == 0 {
		position = readPositiveGitStateInt(filepath.Join(rebaseDir, "next"))
	}
	if total == 0 {
		total = readPositiveGitStateInt(filepath.Join(rebaseDir, "last"))
	}
	return operationProgress(repoRoot, position, total, currentCommit)
}

func collectSequencerProgress(repoRoot, gitDir, currentCommit string) *GitOperationProgress {
	done := countGitSequencerCommands(filepath.Join(gitDir, "sequencer", "done"))
	remaining := countGitSequencerCommands(filepath.Join(gitDir, "sequencer", "todo"))
	total := done + remaining
	position := done
	if total == 0 {
		position = 1
		total = 1
	} else if position == 0 && currentCommit != "" {
		position = 1
	}
	return operationProgress(repoRoot, position, total, currentCommit)
}

func countGitSequencerCommands(path string) int {
	content := readGitStateFile(path)
	count := 0
	for _, line := range strings.Split(content, "\n") {
		line = strings.TrimSpace(line)
		if line != "" && !strings.HasPrefix(line, "#") {
			count++
		}
	}
	return count
}

func readPositiveGitStateInt(path string) int {
	value, err := strconv.Atoi(readGitStateFile(path))
	if err != nil || value < 1 {
		return 0
	}
	return value
}

func operationProgress(repoRoot string, position, total int, currentCommit string) *GitOperationProgress {
	if total < 1 {
		return nil
	}
	if position < 1 {
		position = 1
	}
	if position > total {
		position = total
	}
	return &GitOperationProgress{
		Position:             position,
		Total:                total,
		Value:                float64(position) / float64(total),
		CurrentCommit:        currentCommit,
		CurrentCommitSummary: gitCommitSummary(repoRoot, currentCommit),
	}
}

func gitCommitSummary(repoRoot, commit string) string {
	if !isGitObjectID(commit) {
		return ""
	}
	cmd := newGitCommand("show", "-s", "--format=%s", "--end-of-options", commit)
	cmd.Dir = repoRoot
	output, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(output))
}

func gitOperationWasAlreadyUpToDate(output string) bool {
	lower := strings.ToLower(output)
	return strings.Contains(lower, "already up to date") ||
		(strings.Contains(lower, "current branch") && strings.Contains(lower, "is up to date"))
}

func truncateGitOperationOutput(output string) string {
	const limit = 64 * 1024
	if len(output) <= limit {
		return output
	}
	return output[:limit] + "\n... output truncated"
}
