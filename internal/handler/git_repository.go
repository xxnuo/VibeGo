package handler

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"unicode"

	"github.com/gin-gonic/gin"
)

const maxGitIgnoreBytes = 1024 * 1024

// GitRepositoryConfig is the effective and repository-local Git identity.
// Global values are included so the UI can make the same local/global choice
// as GitHub Desktop without exposing arbitrary config keys.
type GitRepositoryConfig struct {
	LocalUserName   string `json:"localUserName"`
	LocalUserEmail  string `json:"localUserEmail"`
	GlobalUserName  string `json:"globalUserName"`
	GlobalUserEmail string `json:"globalUserEmail"`
	EffectiveName   string `json:"effectiveName"`
	EffectiveEmail  string `json:"effectiveEmail"`
}

type GitRepositoryRemote struct {
	Name     string   `json:"name"`
	FetchURL string   `json:"fetchUrl"`
	PushURLs []string `json:"pushUrls"`
}

type GitLFSStatus struct {
	Installed    bool     `json:"installed"`
	Version      string   `json:"version,omitempty"`
	Initialized  bool     `json:"initialized"`
	TrackedFiles []string `json:"trackedFiles"`
	Error        string   `json:"error,omitempty"`
}

type GitRepositorySettings struct {
	Config    GitRepositoryConfig   `json:"config"`
	Remotes   []GitRepositoryRemote `json:"remotes"`
	GitIgnore string                `json:"gitignore"`
	LFS       GitLFSStatus          `json:"lfs"`
}

type GitRepositoryPathRequest struct {
	Path string `json:"path" binding:"required"`
}

type GitConfigUpdateRequest struct {
	Path  string `json:"path" binding:"required"`
	Scope string `json:"scope"`
	Name  string `json:"name"`
	Email string `json:"email"`
}

type GitRemoteUpdateRequest struct {
	Path       string `json:"path" binding:"required"`
	Name       string `json:"name"`
	URL        string `json:"url"`
	PushURL    string `json:"pushUrl"`
	pushURLSet bool
}

// UnmarshalJSON keeps PushURL backwards-compatible as a string while still
// distinguishing an omitted field from an explicitly empty value. The latter
// is used by repository settings to clear a previously configured push URL.
func (r *GitRemoteUpdateRequest) UnmarshalJSON(data []byte) error {
	type requestWire struct {
		Path    string           `json:"path"`
		Name    string           `json:"name"`
		URL     string           `json:"url"`
		PushURL *json.RawMessage `json:"pushUrl"`
	}
	var wire requestWire
	if err := json.Unmarshal(data, &wire); err != nil {
		return err
	}
	r.Path = wire.Path
	r.Name = wire.Name
	r.URL = wire.URL
	r.PushURL = ""
	r.pushURLSet = wire.PushURL != nil
	if wire.PushURL != nil && string(*wire.PushURL) != "null" {
		if err := json.Unmarshal(*wire.PushURL, &r.PushURL); err != nil {
			return err
		}
	}
	return nil
}

type GitRemoteDeleteRequest struct {
	Path string `json:"path" binding:"required"`
	Name string `json:"name" binding:"required"`
}

type GitIgnoreUpdateRequest struct {
	Path    string `json:"path" binding:"required"`
	Content string `json:"content"`
}

type GitLFSRequest struct {
	Path   string `json:"path" binding:"required"`
	Action string `json:"action"`
}

type GitWorktreeEntry struct {
	Path     string `json:"path"`
	Head     string `json:"head"`
	Branch   string `json:"branch,omitempty"`
	Detached bool   `json:"detached"`
	Locked   bool   `json:"locked"`
	Prunable bool   `json:"prunable"`
	Main     bool   `json:"main"`
}

type GitWorktreeListResponse struct {
	Worktrees []GitWorktreeEntry `json:"worktrees"`
}

type GitWorktreeAddRequest struct {
	Path         string `json:"path" binding:"required"`
	WorktreePath string `json:"worktreePath" binding:"required"`
	Branch       string `json:"branch"`
	Commit       string `json:"commit"`
	CreateBranch bool   `json:"createBranch"`
}

type GitWorktreeRemoveRequest struct {
	Path         string `json:"path" binding:"required"`
	WorktreePath string `json:"worktreePath" binding:"required"`
	Force        bool   `json:"force"`
}

type GitWorktreeMoveRequest struct {
	Path    string `json:"path" binding:"required"`
	OldPath string `json:"oldPath" binding:"required"`
	NewPath string `json:"newPath" binding:"required"`
}

func (h *GitHandler) RegisterRepositoryRoutes(r *gin.RouterGroup) {
	g := r.Group("/git")
	g.POST("/repository-settings", h.RepositorySettings)
	g.POST("/config", h.UpdateGitConfig)
	g.POST("/remote-set", h.SetGitRemote)
	g.POST("/remote-add", h.AddGitRemote)
	g.POST("/remote-delete", h.DeleteGitRemote)
	g.POST("/gitignore", h.UpdateGitIgnore)
	g.POST("/lfs", h.GitLFS)
	g.POST("/worktrees", h.ListGitWorktrees)
	g.POST("/worktree-add", h.AddGitWorktree)
	g.POST("/worktree-remove", h.RemoveGitWorktree)
	g.POST("/worktree-move", h.MoveGitWorktree)
}

func runGitOutput(repoRoot string, args ...string) ([]byte, error) {
	cmd := newGitCommand(args...)
	cmd.Dir = repoRoot
	return cmd.Output()
}

func runGitCombined(repoRoot string, args ...string) ([]byte, error) {
	cmd := newGitCommand(args...)
	cmd.Dir = repoRoot
	return cmd.CombinedOutput()
}

func gitConfigValue(repoRoot, scope, key string) (string, error) {
	args := []string{"config"}
	switch scope {
	case "local":
		args = append(args, "--local")
	case "global":
		args = append(args, "--global")
	case "effective":
	default:
		return "", fmt.Errorf("invalid git config scope")
	}
	args = append(args, "--get", key)
	out, err := runGitOutput(repoRoot, args...)
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) && exitErr.ExitCode() == 1 {
			return "", nil
		}
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

func collectGitRepositoryConfig(repoRoot string) (GitRepositoryConfig, error) {
	localName, err := gitConfigValue(repoRoot, "local", "user.name")
	if err != nil {
		return GitRepositoryConfig{}, err
	}
	localEmail, err := gitConfigValue(repoRoot, "local", "user.email")
	if err != nil {
		return GitRepositoryConfig{}, err
	}
	globalName, err := gitConfigValue(repoRoot, "global", "user.name")
	if err != nil {
		return GitRepositoryConfig{}, err
	}
	globalEmail, err := gitConfigValue(repoRoot, "global", "user.email")
	if err != nil {
		return GitRepositoryConfig{}, err
	}
	effectiveName, err := gitConfigValue(repoRoot, "effective", "user.name")
	if err != nil {
		return GitRepositoryConfig{}, err
	}
	effectiveEmail, err := gitConfigValue(repoRoot, "effective", "user.email")
	if err != nil {
		return GitRepositoryConfig{}, err
	}
	return GitRepositoryConfig{
		LocalUserName: localName, LocalUserEmail: localEmail,
		GlobalUserName: globalName, GlobalUserEmail: globalEmail,
		EffectiveName: effectiveName, EffectiveEmail: effectiveEmail,
	}, nil
}

func collectGitRepositoryRemotes(repoRoot string) ([]GitRepositoryRemote, error) {
	out, err := runGitOutput(repoRoot, "config", "--get-regexp", `^remote\..+\.(url|pushurl)$`)
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) && exitErr.ExitCode() == 1 {
			return []GitRepositoryRemote{}, nil
		}
		return nil, err
	}
	byName := make(map[string]*GitRepositoryRemote)
	order := make([]string, 0)
	scanner := bufio.NewScanner(strings.NewReader(string(out)))
	for scanner.Scan() {
		parts := strings.SplitN(scanner.Text(), " ", 2)
		if len(parts) != 2 {
			continue
		}
		key := parts[0]
		if !strings.HasPrefix(key, "remote.") {
			continue
		}
		remainder := strings.TrimPrefix(key, "remote.")
		idx := strings.LastIndex(remainder, ".")
		if idx <= 0 {
			continue
		}
		name, field := remainder[:idx], remainder[idx+1:]
		if err := validateGitRemoteArgument(name); err != nil {
			continue
		}
		remote, ok := byName[name]
		if !ok {
			remote = &GitRepositoryRemote{Name: name, PushURLs: []string{}}
			byName[name] = remote
			order = append(order, name)
		}
		switch field {
		case "url":
			if remote.FetchURL == "" {
				remote.FetchURL = sanitizeGitRemoteURL(parts[1])
			}
		case "pushurl":
			remote.PushURLs = append(remote.PushURLs, sanitizeGitRemoteURL(parts[1]))
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	remotes := make([]GitRepositoryRemote, 0, len(order))
	for _, name := range order {
		remotes = append(remotes, *byName[name])
	}
	return remotes, nil
}

func readGitIgnore(repoRoot string) (string, error) {
	path := filepath.Join(repoRoot, ".gitignore")
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return "", fmt.Errorf(".gitignore is not a regular file")
	}
	if info.Size() > maxGitIgnoreBytes {
		return "", fmt.Errorf(".gitignore is too large")
	}
	content, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return string(content), nil
}

func collectGitLFSStatus(repoRoot string) GitLFSStatus {
	status := GitLFSStatus{TrackedFiles: []string{}}
	out, err := runGitCombined(repoRoot, "lfs", "version")
	if err != nil {
		status.Error = strings.TrimSpace(string(out))
		return status
	}
	status.Installed = true
	status.Version = strings.TrimSpace(string(out))
	if configured, configErr := gitConfigValue(repoRoot, "local", "filter.lfs.clean"); configErr == nil {
		status.Initialized = configured != ""
	}
	if out, err := runGitOutput(repoRoot, "lfs", "ls-files", "-n"); err == nil {
		for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
			if line = strings.TrimSpace(line); line != "" {
				status.TrackedFiles = append(status.TrackedFiles, line)
			}
		}
	}
	return status
}

func parseGitWorktreePorcelain(output string) []GitWorktreeEntry {
	blocks := strings.Split(strings.TrimRight(output, "\x00\n"), "\x00\x00")
	result := make([]GitWorktreeEntry, 0, len(blocks))
	for index, block := range blocks {
		if strings.TrimSpace(block) == "" {
			continue
		}
		entry := GitWorktreeEntry{Main: index == 0}
		for _, line := range strings.Split(block, "\x00") {
			switch {
			case strings.HasPrefix(line, "worktree "):
				entry.Path = strings.TrimPrefix(line, "worktree ")
			case strings.HasPrefix(line, "HEAD "):
				entry.Head = strings.TrimPrefix(line, "HEAD ")
			case strings.HasPrefix(line, "branch "):
				entry.Branch = strings.TrimPrefix(line, "branch refs/heads/")
			case line == "detached":
				entry.Detached = true
			case strings.HasPrefix(line, "locked"):
				entry.Locked = true
			case strings.HasPrefix(line, "prunable"):
				entry.Prunable = true
			}
		}
		if entry.Path != "" {
			result = append(result, entry)
		}
	}
	return result
}

func (h *GitHandler) repositorySettingsSnapshot(repoRoot string) (GitRepositorySettings, error) {
	config, err := collectGitRepositoryConfig(repoRoot)
	if err != nil {
		return GitRepositorySettings{}, err
	}
	remotes, err := collectGitRepositoryRemotes(repoRoot)
	if err != nil {
		return GitRepositorySettings{}, err
	}
	ignore, err := readGitIgnore(repoRoot)
	if err != nil {
		return GitRepositorySettings{}, err
	}
	return GitRepositorySettings{Config: config, Remotes: remotes, GitIgnore: ignore, LFS: collectGitLFSStatus(repoRoot)}, nil
}

func (h *GitHandler) RepositorySettings(c *gin.Context) {
	var req GitRepositoryPathRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	repoRoot, err := h.getRepoRoot(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	settings, err := h.repositorySettingsSnapshot(repoRoot)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, settings)
}

func validateGitIdentity(name, email string) error {
	if len(name) > 512 || len(email) > 1024 || strings.IndexByte(name, 0) >= 0 || strings.IndexByte(email, 0) >= 0 {
		return fmt.Errorf("git identity is too long or contains NUL")
	}
	for _, value := range []string{name, email} {
		for _, r := range value {
			if unicode.IsControl(r) {
				return fmt.Errorf("git identity contains control characters")
			}
		}
	}
	if email != "" && (!strings.Contains(email, "@") || strings.ContainsAny(email, "\r\n")) {
		return fmt.Errorf("invalid git email")
	}
	return nil
}

func (h *GitHandler) UpdateGitConfig(c *gin.Context) {
	var req GitConfigUpdateRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	repoRoot, err := h.getRepoRoot(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	scope := strings.ToLower(strings.TrimSpace(req.Scope))
	if scope == "" {
		scope = "local"
	}
	if scope != "local" && scope != "global" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "scope must be local or global"})
		return
	}
	if err := validateGitIdentity(req.Name, req.Email); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	unlock := lockGitOperationRepo(repoRoot)
	defer unlock()
	for key, value := range map[string]string{"user.name": req.Name, "user.email": req.Email} {
		args := []string{"config", "--" + scope}
		if value == "" {
			args = append(args, "--unset", key)
		} else {
			args = append(args, key, value)
		}
		out, cmdErr := runGitCombined(repoRoot, args...)
		if cmdErr != nil {
			var exitErr *exec.ExitError
			if value == "" && errors.As(cmdErr, &exitErr) && exitErr.ExitCode() == 5 {
				continue
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": gitCommandError(cmdErr, out).Error()})
			return
		}
	}
	settings, err := h.repositorySettingsSnapshot(repoRoot)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, settings)
}

func validateRemoteURL(value string) error {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 4096 || strings.IndexByte(value, 0) >= 0 || strings.HasPrefix(value, "-") {
		return fmt.Errorf("invalid remote URL")
	}
	for _, r := range value {
		if unicode.IsControl(r) {
			return fmt.Errorf("remote URL contains control characters")
		}
	}
	return nil
}

func (h *GitHandler) SetGitRemote(c *gin.Context) {
	var req GitRemoteUpdateRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	repoRoot, err := h.getRepoRoot(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := validateGitRemoteArgument(req.Name); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := validateRemoteURL(req.URL); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	args := []string{"remote", "set-url", req.Name, strings.TrimSpace(req.URL)}
	pushURL := ""
	if req.pushURLSet {
		pushURL = strings.TrimSpace(req.PushURL)
		if pushURL != "" {
			if err := validateRemoteURL(pushURL); err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
				return
			}
		}
	}
	unlock := lockGitOperationRepo(repoRoot)
	defer unlock()
	out, cmdErr := runGitCombined(repoRoot, args...)
	if cmdErr != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gitCommandError(cmdErr, out).Error()})
		return
	}
	if req.pushURLSet {
		if pushURL == "" {
			key := "remote." + req.Name + ".pushurl"
			out, cmdErr = runGitCombined(repoRoot, "config", "--local", "--unset-all", key)
			if cmdErr != nil {
				var exitErr *exec.ExitError
				if !errors.As(cmdErr, &exitErr) || exitErr.ExitCode() != 5 {
					c.JSON(http.StatusInternalServerError, gin.H{"error": gitCommandError(cmdErr, out).Error()})
					return
				}
			}
		} else {
			out, cmdErr = runGitCombined(repoRoot, "remote", "set-url", "--push", req.Name, pushURL)
			if cmdErr != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": gitCommandError(cmdErr, out).Error()})
				return
			}
		}
	}
	remotes, err := collectGitRepositoryRemotes(repoRoot)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"remotes": remotes})
}

func (h *GitHandler) AddGitRemote(c *gin.Context) {
	var req GitRemoteUpdateRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	repoRoot, err := h.getRepoRoot(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := validateGitRemoteArgument(req.Name); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := validateRemoteURL(req.URL); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	unlock := lockGitOperationRepo(repoRoot)
	defer unlock()
	out, cmdErr := runGitCombined(repoRoot, "remote", "add", req.Name, strings.TrimSpace(req.URL))
	if cmdErr != nil {
		c.JSON(http.StatusConflict, gin.H{"error": gitCommandError(cmdErr, out).Error()})
		return
	}
	remotes, err := collectGitRepositoryRemotes(repoRoot)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"remotes": remotes})
}

func (h *GitHandler) DeleteGitRemote(c *gin.Context) {
	var req GitRemoteDeleteRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	repoRoot, err := h.getRepoRoot(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := validateConfiguredGitRemote(repoRoot, req.Name); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	unlock := lockGitOperationRepo(repoRoot)
	defer unlock()
	out, cmdErr := runGitCombined(repoRoot, "remote", "remove", req.Name)
	if cmdErr != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gitCommandError(cmdErr, out).Error()})
		return
	}
	remotes, err := collectGitRepositoryRemotes(repoRoot)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"remotes": remotes})
}

func (h *GitHandler) UpdateGitIgnore(c *gin.Context) {
	var req GitIgnoreUpdateRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if len(req.Content) > maxGitIgnoreBytes || strings.IndexByte(req.Content, 0) >= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid .gitignore content"})
		return
	}
	repoRoot, err := h.getRepoRoot(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	path := filepath.Join(repoRoot, ".gitignore")
	if info, statErr := os.Lstat(path); statErr == nil && info.Mode()&os.ModeSymlink != 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": ".gitignore must not be a symlink"})
		return
	}
	unlock := lockGitOperationRepo(repoRoot)
	defer unlock()
	if strings.TrimSpace(req.Content) == "" {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
	} else if err := os.WriteFile(path, []byte(req.Content), 0644); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	content, err := readGitIgnore(repoRoot)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"gitignore": content})
}

func (h *GitHandler) GitLFS(c *gin.Context) {
	var req GitLFSRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	repoRoot, err := h.getRepoRoot(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if strings.EqualFold(strings.TrimSpace(req.Action), "init") {
		unlock := lockGitOperationRepo(repoRoot)
		defer unlock()
		out, cmdErr := runGitCombined(repoRoot, "lfs", "install", "--local")
		if cmdErr != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": gitCommandError(cmdErr, out).Error()})
			return
		}
	}
	c.JSON(http.StatusOK, collectGitLFSStatus(repoRoot))
}

func (h *GitHandler) ListGitWorktrees(c *gin.Context) {
	var req GitRepositoryPathRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	repoRoot, err := h.getRepoRoot(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	out, err := runGitOutput(repoRoot, "worktree", "list", "--porcelain", "-z")
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, GitWorktreeListResponse{Worktrees: parseGitWorktreePorcelain(string(out))})
}

func validateWorktreePath(path string) error {
	if strings.TrimSpace(path) == "" || strings.IndexByte(path, 0) >= 0 || filepath.IsAbs(path) == false {
		return fmt.Errorf("worktree path must be an absolute path")
	}
	for _, r := range path {
		if unicode.IsControl(r) {
			return fmt.Errorf("worktree path contains control characters")
		}
	}
	return nil
}

func (h *GitHandler) AddGitWorktree(c *gin.Context) {
	var req GitWorktreeAddRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	repoRoot, err := h.getRepoRoot(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := validateWorktreePath(req.WorktreePath); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	args := []string{"worktree", "add"}
	if req.CreateBranch {
		branch, branchErr := normalizeGitBranchName(repoRoot, req.Branch)
		if branchErr != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": branchErr.Error()})
			return
		}
		args = append(args, "-b", branch)
	} else if req.Branch != "" {
		if _, refErr := resolveGitCommitRef(repoRoot, req.Branch, "branch"); refErr != nil {
			// A local branch may not resolve through the commit resolver while it
			// is unborn. Let Git produce the detailed error in that case.
			if branchErr := validateGitBranchName(repoRoot, req.Branch); branchErr != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": refErr.Error()})
				return
			}
		}
	}
	args = append(args, req.WorktreePath)
	if req.Commit != "" {
		ref, refErr := resolveGitCommitRef(repoRoot, req.Commit, "commit")
		if refErr != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": refErr.Error()})
			return
		}
		args = append(args, ref)
	} else if req.Branch != "" && !req.CreateBranch {
		args = append(args, req.Branch)
	}
	unlock := lockGitOperationRepo(repoRoot)
	defer unlock()
	out, cmdErr := runGitCombined(repoRoot, args...)
	if cmdErr != nil {
		c.JSON(http.StatusConflict, gin.H{"error": gitCommandError(cmdErr, out).Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *GitHandler) RemoveGitWorktree(c *gin.Context) {
	var req GitWorktreeRemoveRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	repoRoot, err := h.getRepoRoot(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := validateWorktreePath(req.WorktreePath); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if filepath.Clean(req.WorktreePath) == filepath.Clean(repoRoot) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "cannot remove the main worktree"})
		return
	}
	args := []string{"worktree", "remove"}
	if req.Force {
		args = append(args, "--force")
	}
	args = append(args, req.WorktreePath)
	unlock := lockGitOperationRepo(repoRoot)
	defer unlock()
	out, cmdErr := runGitCombined(repoRoot, args...)
	if cmdErr != nil {
		c.JSON(http.StatusConflict, gin.H{"error": gitCommandError(cmdErr, out).Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *GitHandler) MoveGitWorktree(c *gin.Context) {
	var req GitWorktreeMoveRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	repoRoot, err := h.getRepoRoot(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := validateWorktreePath(req.OldPath); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := validateWorktreePath(req.NewPath); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	unlock := lockGitOperationRepo(repoRoot)
	defer unlock()
	out, cmdErr := runGitCombined(repoRoot, "worktree", "move", req.OldPath, req.NewPath)
	if cmdErr != nil {
		c.JSON(http.StatusConflict, gin.H{"error": gitCommandError(cmdErr, out).Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}
