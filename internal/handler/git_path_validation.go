package handler

import (
	"bytes"
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"unicode"
)

// validateRepoRelativePath accepts the path format Git's -- separator expects
// and rejects values that could make the handler read, write, or remove files
// outside the selected repository.
func validateRepoRelativePath(repoRoot, filePath string) error {
	return validateRepoRelativePathOptions(repoRoot, filePath, false)
}

// isGitMetadataPath identifies the repository control directory. API writes
// must never treat .git or anything below it as a user file, including on
// case-insensitive filesystems.
func isGitMetadataPath(filePath string) bool {
	clean := filepath.Clean(filepath.FromSlash(filePath))
	for _, component := range strings.Split(clean, string(filepath.Separator)) {
		if strings.EqualFold(component, ".git") {
			return true
		}
	}
	return false
}

// validateRepoRelativeLiteralPath is used by read-only Git commands that set
// --literal-pathspecs. It accepts Git's legal control and wildcard characters
// while retaining the repository-boundary and symlink checks.
func validateRepoRelativeLiteralPath(repoRoot, filePath string) error {
	return validateRepoRelativePathOptions(repoRoot, filePath, true)
}

func validateRepoRelativePathOptions(repoRoot, filePath string, literal bool) error {
	if strings.TrimSpace(repoRoot) == "" {
		return fmt.Errorf("repository path is required")
	}
	if filePath == "" {
		return fmt.Errorf("file path is required")
	}
	if strings.IndexByte(filePath, 0) >= 0 {
		return fmt.Errorf("file path contains NUL")
	}
	// Git treats a leading ':' as pathspec magic (for example
	// `:(top,glob)**`). These values can expand a supposedly file-scoped
	// operation to unrelated paths, so the HTTP API accepts literal paths only.
	if !literal && strings.HasPrefix(filePath, ":") {
		return fmt.Errorf("file path must be a literal repository path")
	}
	// Wildcard pathspecs (`*`, `?`, `[...]`) have expansion semantics even
	// after Git's `--` separator. API callers send concrete file names, so reject
	// those patterns instead of allowing one request to affect many files.
	if !literal && strings.ContainsAny(filePath, "*?[") {
		return fmt.Errorf("file path must not contain wildcard patterns")
	}
	for _, r := range filePath {
		if !literal && unicode.IsControl(r) {
			return fmt.Errorf("file path contains control characters")
		}
	}

	// filepath.IsAbs and VolumeName cover the native platform. The leading
	// slash/backslash checks also reject foreign absolute paths when a request
	// is sent to a different platform than the client.
	if filepath.IsAbs(filePath) || filepath.VolumeName(filePath) != "" ||
		isWindowsDrivePath(filePath) ||
		strings.HasPrefix(filePath, "/") || strings.HasPrefix(filePath, "\\") {
		return fmt.Errorf("file path must be repository-relative")
	}

	clean := filepath.Clean(filepath.FromSlash(filePath))
	if clean == "." || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return fmt.Errorf("file path escapes repository")
	}

	root, err := filepath.Abs(repoRoot)
	if err != nil {
		return fmt.Errorf("invalid repository path: %w", err)
	}
	candidate, err := filepath.Abs(filepath.Join(root, clean))
	if err != nil {
		return fmt.Errorf("invalid file path: %w", err)
	}
	rel, err := filepath.Rel(root, candidate)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return fmt.Errorf("file path escapes repository")
	}

	// A lexical check is insufficient when a repository contains a symlink.
	// Resolve the candidate (or its nearest existing parent for a new file) and
	// reject links that point outside the repository before any file I/O or Git
	// pathspec operation is performed.
	resolvedRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		resolvedRoot = root
	}
	resolvedRoot, err = filepath.Abs(resolvedRoot)
	if err != nil {
		return fmt.Errorf("invalid repository path: %w", err)
	}
	probe := candidate
	for {
		resolvedProbe, probeErr := filepath.EvalSymlinks(probe)
		if probeErr == nil {
			resolvedProbe, probeErr = filepath.Abs(resolvedProbe)
			if probeErr != nil {
				return fmt.Errorf("invalid file path: %w", probeErr)
			}
			resolvedRel, relErr := filepath.Rel(resolvedRoot, resolvedProbe)
			if relErr != nil || resolvedRel == ".." || strings.HasPrefix(resolvedRel, ".."+string(filepath.Separator)) {
				return fmt.Errorf("file path escapes repository")
			}
			break
		}
		parent := filepath.Dir(probe)
		if parent == probe {
			break
		}
		probe = parent
	}
	return nil
}

func resolveGitStashReference(repoRoot string, index int, requestedOID string) (string, string, error) {
	if err := validateGitStashIndex(index); err != nil {
		return "", "", err
	}
	entries, err := loadStashEntries(repoRoot)
	if err != nil {
		return "", "", err
	}
	requestedOID = strings.TrimSpace(requestedOID)
	if requestedOID != "" && !isGitObjectID(requestedOID) {
		return "", "", fmt.Errorf("invalid stash oid")
	}
	for _, entry := range entries {
		if requestedOID != "" {
			if strings.EqualFold(entry.OID, requestedOID) {
				return fmt.Sprintf("stash@{%d}", entry.Index), entry.OID, nil
			}
			continue
		}
		if entry.Index == index {
			return fmt.Sprintf("stash@{%d}", entry.Index), entry.OID, nil
		}
	}
	return "", "", fmt.Errorf("stash not found")
}

// isWindowsDrivePath keeps validation platform-independent. filepath.VolumeName
// is intentionally native to the host OS, so a Windows path received by a
// Linux server would otherwise be treated as an ordinary repository filename.
func isWindowsDrivePath(filePath string) bool {
	if len(filePath) < 2 || filePath[1] != ':' {
		return false
	}
	letter := filePath[0]
	return (letter >= 'a' && letter <= 'z') || (letter >= 'A' && letter <= 'Z')
}

func validateRepoRelativePaths(repoRoot string, paths []string) error {
	for _, filePath := range paths {
		if err := validateRepoRelativePath(repoRoot, filePath); err != nil {
			return err
		}
	}
	return nil
}

func validateGitPatchPayloadPaths(repoRoot string, patches []GitPatchPayload) error {
	for i, patch := range patches {
		if err := validateGitPatchPayloadPath(repoRoot, patch.FilePath, patch.Patch); err != nil {
			return fmt.Errorf("patch %d: %w", i, err)
		}
	}
	return nil
}

func validateGitPatchPayloadPath(repoRoot, filePath, patch string) error {
	if err := validateRepoRelativePath(repoRoot, filePath); err != nil {
		return err
	}

	expectedPath := normalizeRepoRelativePath(filePath)
	paths, err := collectGitPatchPaths(repoRoot, patch, false)
	if err != nil {
		// Leave malformed patches to git apply, which reports them as a server
		// error at the existing endpoint boundary. There is no path to validate
		// when Git cannot parse the patch, and git apply is atomic by default.
		return nil
	}
	reversePaths, err := collectGitPatchPaths(repoRoot, patch, true)
	if err != nil {
		return err
	}
	paths = append(paths, reversePaths...)
	actualPaths := make(map[string]struct{}, len(paths))
	for _, path := range paths {
		if err := validateRepoRelativePath(repoRoot, path); err != nil {
			return fmt.Errorf("invalid patch path %q: %w", path, err)
		}
		actualPaths[normalizeRepoRelativePath(path)] = struct{}{}
	}

	if len(actualPaths) == 1 {
		if _, ok := actualPaths[expectedPath]; ok {
			return nil
		}
	}

	pathList := make([]string, 0, len(actualPaths))
	for path := range actualPaths {
		pathList = append(pathList, path)
	}
	sort.Strings(pathList)
	if len(pathList) == 0 {
		return fmt.Errorf("patch does not contain a file change")
	}
	return fmt.Errorf("patch targets %q, expected %q", pathList, expectedPath)
}

func collectGitPatchPaths(repoRoot, patch string, reverse bool) ([]string, error) {
	args := []string{"apply", "--numstat", "-z"}
	if reverse {
		args = append(args, "-R")
	}
	args = append(args, "--unidiff-zero", "--whitespace=nowarn", "-")

	cmd := newGitCommand(args...)
	cmd.Dir = repoRoot
	cmd.Stdin = strings.NewReader(patch)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	output, err := cmd.Output()
	if err != nil {
		return nil, gitCommandError(err, stderr.Bytes())
	}

	records := bytes.Split(output, []byte{0})
	paths := make([]string, 0, len(records))
	for _, record := range records {
		if len(record) == 0 {
			continue
		}
		firstTab := bytes.IndexByte(record, '\t')
		if firstTab < 0 {
			return nil, fmt.Errorf("cannot parse patch path")
		}
		secondTabOffset := bytes.IndexByte(record[firstTab+1:], '\t')
		if secondTabOffset < 0 {
			return nil, fmt.Errorf("cannot parse patch path")
		}
		path := string(record[firstTab+1+secondTabOffset+1:])
		if path == "" {
			return nil, fmt.Errorf("patch contains an empty file path")
		}
		paths = append(paths, path)
	}
	return paths, nil
}

func normalizeRepoRelativePath(filePath string) string {
	return filepath.ToSlash(filepath.Clean(filepath.FromSlash(filePath)))
}

func validateGitStashIndex(index int) error {
	if index < 0 {
		return fmt.Errorf("stash index must be non-negative")
	}
	return nil
}

// validateGitRefArgument prevents option injection and control characters in
// user-provided refs. Callers still ask Git to verify that the ref exists or
// has a valid branch/tag format.
func validateGitRefArgument(value, label string) error {
	if strings.TrimSpace(value) == "" {
		return fmt.Errorf("%s is required", label)
	}
	if len(value) > 1024 {
		return fmt.Errorf("invalid %s", label)
	}
	for _, r := range value {
		if unicode.IsControl(r) {
			return fmt.Errorf("invalid %s", label)
		}
	}
	if strings.HasPrefix(value, "-") {
		return fmt.Errorf("invalid %s", label)
	}
	return nil
}

func validateGitRemoteArgument(value string) error {
	return validateGitRefArgument(value, "remote")
}

func resolveGitCommitRef(repoRoot, value, label string) (string, error) {
	value = strings.TrimSpace(value)
	if err := validateGitRefArgument(value, label); err != nil {
		return "", err
	}
	cmd := newGitCommand("rev-parse", "--verify", "--end-of-options", value+"^{commit}")
	cmd.Dir = repoRoot
	output, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("invalid %s", label)
	}
	return strings.TrimSpace(string(output)), nil
}

// normalizeGitBranchName validates a literal local branch and returns the
// short name used by Git's branch/checkout commands. The HTTP API historically
// accepted short names, while callers that already have a ref often send
// refs/heads/<name>; normalize both forms before constructing another ref so
// the latter does not become refs/heads/refs/heads/<name>.
func normalizeGitBranchName(repoRoot, branch string) (string, error) {
	branch = strings.TrimSpace(branch)
	branch = strings.TrimPrefix(branch, "refs/heads/")
	if err := validateGitRefArgument(branch, "branch"); err != nil {
		return "", err
	}
	// --branch expands checkout shorthands such as @{-1}. Validate the full
	// literal ref as well so callers cannot smuggle revision syntax where a
	// branch name is required.
	literalCmd := newGitCommand("check-ref-format", "refs/heads/"+branch)
	literalCmd.Dir = repoRoot
	if err := literalCmd.Run(); err != nil {
		return "", fmt.Errorf("invalid branch")
	}
	cmd := newGitCommand("check-ref-format", "--branch", branch)
	cmd.Dir = repoRoot
	if output, err := cmd.CombinedOutput(); err != nil {
		message := strings.TrimSpace(string(output))
		if message == "" {
			message = "invalid branch"
		}
		return "", fmt.Errorf("%s", message)
	}
	return branch, nil
}

func validateGitBranchName(repoRoot, branch string) error {
	_, err := normalizeGitBranchName(repoRoot, branch)
	return err
}

func validateConfiguredGitRemote(repoRoot, remote string) error {
	if err := validateGitRemoteArgument(remote); err != nil {
		return err
	}
	cmd := newGitCommand("remote")
	cmd.Dir = repoRoot
	output, err := cmd.Output()
	if err != nil {
		return fmt.Errorf("cannot list git remotes")
	}
	for _, name := range strings.Split(strings.TrimSpace(string(output)), "\n") {
		if name == remote {
			return nil
		}
	}
	return fmt.Errorf("remote not found: %s", remote)
}
