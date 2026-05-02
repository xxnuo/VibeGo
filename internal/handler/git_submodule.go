package handler

import (
	"bufio"
	"errors"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"

	"github.com/gin-gonic/gin"
)

// GitSubmoduleStatus mirrors the four-character submodule status field from
// `git status --porcelain=v2`. The fields intentionally describe the nested
// repository rather than the parent gitlink itself.
type GitSubmoduleStatus struct {
	Initialized      bool `json:"initialized"`
	CommitChanged    bool `json:"commitChanged"`
	ModifiedChanges  bool `json:"modifiedChanges"`
	UntrackedChanges bool `json:"untrackedChanges"`
	Conflict         bool `json:"conflict"`
}

// GitSubmoduleEntry is a top-level submodule recorded by the parent index.
// SHA is the currently checked out nested commit when initialized, while
// IndexSHA is the gitlink recorded by the parent commit/index.
type GitSubmoduleEntry struct {
	Path     string             `json:"path"`
	URL      string             `json:"url,omitempty"`
	SHA      string             `json:"sha,omitempty"`
	IndexSHA string             `json:"indexSHA,omitempty"`
	Describe string             `json:"describe,omitempty"`
	Status   GitSubmoduleStatus `json:"status"`
}

// GitSubmoduleDiff describes a gitlink change. A nil SHA represents an added
// or removed submodule on the corresponding side of a commit/diff.
type GitSubmoduleDiff struct {
	Path     string             `json:"path"`
	FullPath string             `json:"fullPath"`
	URL      string             `json:"url,omitempty"`
	Status   GitSubmoduleStatus `json:"status"`
	OldSHA   *string            `json:"oldSHA"`
	NewSHA   *string            `json:"newSHA"`
}

type GitSubmodulesRequest struct {
	Path string `json:"path" binding:"required"`
}

type GitSubmoduleUpdateRequest struct {
	Path              string   `json:"path" binding:"required"`
	Paths             []string `json:"paths"`
	Recursive         *bool    `json:"recursive"`
	Force             bool     `json:"force"`
	AllowFileProtocol bool     `json:"allowFileProtocol"`
}

func (h *GitHandler) RegisterSubmoduleRoutes(r *gin.RouterGroup) {
	g := r.Group("/git")
	g.POST("/submodules", h.ListGitSubmodules)
	g.POST("/submodules-update", h.UpdateGitSubmodules)
	g.POST("/submodules-reset", h.ResetGitSubmodules)
}

func runGitSubmoduleCommand(repoRoot string, allowFileProtocol bool, args ...string) ([]byte, error) {
	commandArgs := make([]string, 0, len(args)+2)
	if allowFileProtocol {
		commandArgs = append(commandArgs, "-c", "protocol.file.allow=always")
	} else {
		// Do not let repository or global configuration override the safe
		// default for implicit/readonly submodule operations.
		commandArgs = append(commandArgs, "-c", "protocol.file.allow=never")
	}
	commandArgs = append(commandArgs, args...)
	cmd := newGitCommand(commandArgs...)
	cmd.Dir = repoRoot
	return cmd.CombinedOutput()
}

func submoduleStatusCodeMap(repoRoot string) map[string]GitSubmoduleStatus {
	result := make(map[string]GitSubmoduleStatus)
	cmd := newGitCommand("status", "--porcelain=v2", "-z", "--ignore-submodules=none", "--untracked-files=all")
	cmd.Dir = repoRoot
	output, err := cmd.Output()
	if err != nil {
		return result
	}

	for _, record := range strings.Split(string(output), "\x00") {
		if record == "" {
			continue
		}
		var submoduleCode, path string
		switch {
		case strings.HasPrefix(record, "1 "):
			parts := strings.SplitN(record, " ", 9)
			if len(parts) == 9 {
				submoduleCode, path = parts[2], parts[8]
			}
		case strings.HasPrefix(record, "2 "):
			// A type-2 record has one additional score field before the path.
			parts := strings.SplitN(record, " ", 10)
			if len(parts) == 10 {
				submoduleCode, path = parts[2], parts[9]
			}
		case strings.HasPrefix(record, "u "):
			parts := strings.SplitN(record, " ", 11)
			if len(parts) == 11 {
				submoduleCode, path = parts[2], parts[10]
			}
		default:
			continue
		}
		if !strings.HasPrefix(submoduleCode, "S") || path == "" {
			continue
		}
		result[path] = GitSubmoduleStatus{
			Initialized:      submoduleCode[1] != '-',
			CommitChanged:    len(submoduleCode) > 1 && submoduleCode[1] == 'C',
			ModifiedChanges:  len(submoduleCode) > 2 && submoduleCode[2] == 'M',
			UntrackedChanges: len(submoduleCode) > 3 && submoduleCode[3] == 'U',
			Conflict:         len(submoduleCode) > 1 && submoduleCode[1] == 'U',
		}
	}
	return result
}

func submoduleStatusValue(statuses map[string]GitSubmoduleStatus, path string) *GitSubmoduleStatus {
	status, ok := statuses[path]
	if !ok {
		return nil
	}
	return &status
}

func parseSubmoduleStatusOutput(output string) []GitSubmoduleEntry {
	entries := make([]GitSubmoduleEntry, 0)
	scanner := bufio.NewScanner(strings.NewReader(output))
	for scanner.Scan() {
		// The leading status marker is significant: a clean submodule line
		// starts with a literal space.
		line := strings.TrimRight(scanner.Text(), "\r\n")
		if len(line) < 2 {
			continue
		}
		prefix := line[0]
		body := strings.TrimLeft(line[1:], " \t")
		separator := strings.IndexAny(body, " \t")
		if separator <= 0 {
			continue
		}
		sha := body[:separator]
		if len(sha) < 40 {
			continue
		}
		for _, char := range sha {
			if !((char >= '0' && char <= '9') || (char >= 'a' && char <= 'f') || (char >= 'A' && char <= 'F')) {
				sha = ""
				break
			}
		}
		if sha == "" {
			continue
		}
		pathAndDescribe := strings.TrimLeft(body[separator:], " \t")
		if pathAndDescribe == "" {
			continue
		}
		path := pathAndDescribe
		describe := ""
		// Git appends descriptions as a final ` (describe)` suffix. Looking
		// from the end keeps spaces (and parentheses) in the path intact.
		if suffixStart := strings.LastIndex(pathAndDescribe, " ("); suffixStart >= 0 && strings.HasSuffix(pathAndDescribe, ")") {
			path = pathAndDescribe[:suffixStart]
			describe = pathAndDescribe[suffixStart+2 : len(pathAndDescribe)-1]
		}
		if path == "" {
			continue
		}
		entry := GitSubmoduleEntry{
			IndexSHA: sha,
			Status: GitSubmoduleStatus{
				Initialized: prefix != '-',
			},
			Path:     path,
			Describe: describe,
		}
		if prefix == '+' {
			entry.Status.CommitChanged = true
		}
		if prefix == 'U' {
			entry.Status.Conflict = true
		}
		entries = append(entries, entry)
	}
	return entries
}

func collectGitSubmoduleEntries(repoRoot string) []GitSubmoduleEntry {
	output, err := runGitSubmoduleCommand(repoRoot, false, "submodule", "status", "--")
	if err != nil {
		var exitErr *exec.ExitError
		if !errors.As(err, &exitErr) || exitErr.ExitCode() != 128 {
			return []GitSubmoduleEntry{}
		}
		return []GitSubmoduleEntry{}
	}
	entries := parseSubmoduleStatusOutput(string(output))
	statusCodes := submoduleStatusCodeMap(repoRoot)
	for index := range entries {
		entry := &entries[index]
		if status, ok := statusCodes[entry.Path]; ok {
			entry.Status = status
		} else if entry.Status.Initialized {
			entry.Status.Initialized = submodulePathInitialized(repoRoot, entry.Path)
		}
		if entry.Status.Initialized {
			entry.SHA = strings.TrimSpace(runGitSubmoduleValue(repoRoot, entry.Path, "rev-parse", "HEAD"))
		}
		if indexSHA := gitSubmoduleIndexSHA(repoRoot, entry.Path); indexSHA != "" {
			entry.IndexSHA = indexSHA
		}
		entry.URL = gitSubmoduleURL(repoRoot, "HEAD", entry.Path)
		if entry.IndexSHA != "" && entry.SHA != "" && entry.IndexSHA != entry.SHA {
			entry.Status.CommitChanged = true
		}
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Path < entries[j].Path })
	return entries
}

func submodulePathInitialized(repoRoot, path string) bool {
	if err := validateRepoRelativePath(repoRoot, path); err != nil {
		return false
	}
	info, err := os.Stat(filepath.Join(repoRoot, filepath.FromSlash(path)))
	return err == nil && info.IsDir()
}

func runGitSubmoduleValue(repoRoot, path string, args ...string) string {
	if err := validateRepoRelativePath(repoRoot, path); err != nil {
		return ""
	}
	cmd := newGitCommand(args...)
	cmd.Dir = filepath.Join(repoRoot, filepath.FromSlash(path))
	output, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(output))
}

func gitSubmoduleURL(repoRoot, ref, path string) string {
	if err := validateRepoRelativePath(repoRoot, path); err != nil {
		return ""
	}
	if ref == "" || ref == "HEAD" {
		cmd := newGitCommand("config", "--local", "--get", "submodule."+path+".url")
		cmd.Dir = repoRoot
		if output, err := cmd.Output(); err == nil {
			return sanitizeGitRemoteURL(string(output))
		}
	}
	// Historical .gitmodules files are ordinary Git blobs. Use Git's config
	// parser so quoting and escaped values follow Git semantics.
	cmd := newGitCommand("config", "--null", "--blob", ref+":.gitmodules", "--get-regexp", `^submodule\..+\.path$`)
	cmd.Dir = repoRoot
	output, err := cmd.Output()
	if err != nil {
		return ""
	}
	for _, record := range strings.Split(string(output), "\x00") {
		if record == "" {
			continue
		}
		// `git config --null --get-regexp` separates key and value with a
		// newline and terminates each record with NUL. The key may itself
		// contain spaces when a subsection is quoted, so splitting on the
		// first space is incorrect.
		separator := strings.IndexByte(record, '\n')
		if separator < 0 {
			continue
		}
		key, value := record[:separator], record[separator+1:]
		if strings.TrimSpace(value) != path {
			continue
		}
		key = strings.TrimSuffix(key, ".path") + ".url"
		urlCmd := newGitCommand("config", "--blob", ref+":.gitmodules", "--get", key)
		urlCmd.Dir = repoRoot
		if url, urlErr := urlCmd.Output(); urlErr == nil {
			return sanitizeGitRemoteURL(string(url))
		}
	}
	return ""
}

func gitSubmoduleSHAAtRef(repoRoot, ref, path string) string {
	if err := validateRepoRelativePath(repoRoot, path); err != nil || strings.TrimSpace(ref) == "" {
		return ""
	}
	cmd := newGitCommand("ls-tree", "-z", "--full-tree", ref, "--", path)
	cmd.Dir = repoRoot
	output, err := cmd.Output()
	if err != nil {
		return ""
	}
	for _, record := range strings.Split(string(output), "\x00") {
		if record == "" {
			continue
		}
		parts := strings.SplitN(record, "\t", 2)
		if len(parts) != 2 || parts[1] != path {
			continue
		}
		fields := strings.Fields(parts[0])
		if len(fields) == 3 && fields[0] == "160000" {
			return fields[2]
		}
	}
	return ""
}

func gitSubmoduleWorkingSHA(repoRoot, path string) string {
	if !submodulePathInitialized(repoRoot, path) {
		return ""
	}
	cmd := newGitCommand("rev-parse", "HEAD")
	cmd.Dir = filepath.Join(repoRoot, filepath.FromSlash(path))
	output, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(output))
}

func gitSubmoduleIndexSHA(repoRoot, path string) string {
	if err := validateRepoRelativePath(repoRoot, path); err != nil {
		return ""
	}
	cmd := newGitCommand("ls-files", "--stage", "-z", "--", path)
	cmd.Dir = repoRoot
	output, err := cmd.Output()
	if err != nil {
		return ""
	}
	for _, record := range strings.Split(string(output), "\x00") {
		if record == "" {
			continue
		}
		parts := strings.SplitN(record, "\t", 2)
		if len(parts) != 2 || parts[1] != path {
			continue
		}
		fields := strings.Fields(parts[0])
		if len(fields) >= 2 && fields[0] == "160000" {
			return fields[1]
		}
	}
	return ""
}

func gitSubmoduleStatusForPath(repoRoot, path string) GitSubmoduleStatus {
	if status, ok := submoduleStatusCodeMap(repoRoot)[path]; ok {
		return status
	}
	status := GitSubmoduleStatus{Initialized: submodulePathInitialized(repoRoot, path)}
	status.CommitChanged = gitSubmoduleSHAAtRef(repoRoot, "HEAD", path) != gitSubmoduleWorkingSHA(repoRoot, path)
	return status
}

func buildGitSubmoduleDiff(repoRoot, path, mode string, patch []byte) *GitSubmoduleDiff {
	oldSHA := gitSubmoduleSHAAtRef(repoRoot, "HEAD", path)
	newSHA := ""
	if mode == "staged" {
		newSHA = gitSubmoduleIndexSHA(repoRoot, path)
	} else {
		newSHA = gitSubmoduleWorkingSHA(repoRoot, path)
		if newSHA == "" {
			newSHA = gitSubmoduleIndexSHA(repoRoot, path)
		}
	}
	if oldSHA == "" && newSHA == "" {
		return nil
	}
	status := gitSubmoduleStatusForPath(repoRoot, path)
	// A gitlink diff is authoritative for the pointer transition even when
	// status output is suppressed by a repository's submodule configuration.
	status.CommitChanged = oldSHA != newSHA && (oldSHA != "" || newSHA != "")
	oldValue, newValue := (*string)(nil), (*string)(nil)
	if oldSHA != "" {
		oldCopy := oldSHA
		oldValue = &oldCopy
	}
	if newSHA != "" {
		newCopy := newSHA
		newValue = &newCopy
	}
	return &GitSubmoduleDiff{
		Path: path, FullPath: filepath.Join(repoRoot, filepath.FromSlash(path)),
		URL: gitSubmoduleURL(repoRoot, "HEAD", path), Status: status,
		OldSHA: oldValue, NewSHA: newValue,
	}
}

func (h *GitHandler) ListGitSubmodules(c *gin.Context) {
	var req GitSubmodulesRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	repoRoot, err := h.getRepoRoot(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"submodules": collectGitSubmoduleEntries(repoRoot)})
}

func (h *GitHandler) UpdateGitSubmodules(c *gin.Context) {
	var req GitSubmoduleUpdateRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	h.updateGitSubmodules(c, req, false)
}

func (h *GitHandler) ResetGitSubmodules(c *gin.Context) {
	var req GitSubmoduleUpdateRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	req.Force = true
	h.updateGitSubmodules(c, req, true)
}

func (h *GitHandler) updateGitSubmodules(c *gin.Context, req GitSubmoduleUpdateRequest, reset bool) {
	repoRoot, err := h.getRepoRoot(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := validateRepoRelativePaths(repoRoot, req.Paths); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	unlockRepo := lockGitOperationRepo(repoRoot)
	defer unlockRepo()
	recursive := true
	if req.Recursive != nil {
		recursive = *req.Recursive
	}
	args := []string{"submodule", "update", "--init"}
	if recursive {
		args = append(args, "--recursive")
	}
	if reset || req.Force {
		args = append(args, "--force")
	}
	if len(req.Paths) > 0 {
		args = append(args, "--")
		args = append(args, req.Paths...)
	}
	output, cmdErr := runGitSubmoduleCommand(repoRoot, req.AllowFileProtocol, args...)
	if cmdErr != nil {
		c.JSON(http.StatusConflict, gin.H{"error": gitCommandError(cmdErr, output).Error()})
		return
	}
	entries := collectGitSubmoduleEntries(repoRoot)
	h.broadcastStatus(req.Path)
	h.broadcastRepoSyncNeeded(req.Path, gin.H{"status": true, "history": true, "conflicts": true})
	c.JSON(http.StatusOK, gin.H{"ok": true, "submodules": entries})
}
