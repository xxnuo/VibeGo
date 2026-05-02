package handler

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// gitIndexSnapshot preserves the complete index, including entries and index
// extensions that are not represented by a textual diff. This is used by
// partial commits, which temporarily need a clean index to assemble a patch.
type gitIndexSnapshot struct {
	path    string
	content []byte
	mode    os.FileMode
	exists  bool
}

func captureGitIndex(repoRoot string) (*gitIndexSnapshot, error) {
	cmd := newGitCommand("rev-parse", "--git-path", "index")
	cmd.Dir = repoRoot
	capture, stderr, err := runGitBoundedOutput(cmd, 4*1024)
	if err != nil {
		return nil, fmt.Errorf("cannot locate git index: %w", gitCommandError(err, stderr.Bytes()))
	}

	if capture.truncated {
		return nil, fmt.Errorf("git returned an index path that is too long")
	}
	indexPath := strings.TrimSpace(string(capture.Bytes()))
	if indexPath == "" {
		return nil, fmt.Errorf("git returned an empty index path")
	}
	if !filepath.IsAbs(indexPath) {
		indexPath = filepath.Join(repoRoot, indexPath)
	}

	info, err := os.Stat(indexPath)
	if err != nil {
		if os.IsNotExist(err) {
			return &gitIndexSnapshot{path: indexPath}, nil
		}
		return nil, fmt.Errorf("cannot stat git index: %w", err)
	}
	if info.Size() > gitIndexSnapshotLimit {
		return nil, fmt.Errorf("git index exceeds %d bytes", gitIndexSnapshotLimit)
	}
	content, truncated, err := readGitFileBounded(indexPath, gitIndexSnapshotLimit)
	if err != nil {
		return nil, fmt.Errorf("cannot read git index: %w", err)
	}
	if truncated {
		return nil, fmt.Errorf("git index exceeds %d bytes", gitIndexSnapshotLimit)
	}
	return &gitIndexSnapshot{
		path:    indexPath,
		content: content,
		mode:    info.Mode().Perm(),
		exists:  true,
	}, nil
}

func (s *gitIndexSnapshot) restore() error {
	if s == nil || s.path == "" {
		return nil
	}
	if !s.exists {
		if err := os.Remove(s.path); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("cannot remove temporary git index: %w", err)
		}
		return nil
	}

	if err := os.MkdirAll(filepath.Dir(s.path), 0755); err != nil {
		return fmt.Errorf("cannot create git index directory: %w", err)
	}
	tmp, err := os.CreateTemp(filepath.Dir(s.path), ".vibego-index-*")
	if err != nil {
		return fmt.Errorf("cannot create git index backup: %w", err)
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)

	if err := tmp.Chmod(s.mode); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("cannot set git index mode: %w", err)
	}
	if _, err := tmp.Write(s.content); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("cannot write git index backup: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("cannot close git index backup: %w", err)
	}
	if err := os.Rename(tmpPath, s.path); err != nil {
		return fmt.Errorf("cannot restore git index: %w", err)
	}
	return nil
}

// restoreAndResetSelected restores the caller's original index and consumes
// the paths included in the new commit. Other staged paths are left exactly as
// they were before the partial operation.
func (s *gitIndexSnapshot) restoreAfterCommit(repoRoot, oldHead string, files []string, patches []GitPatchPayload) error {
	if err := validateRepoRelativePaths(repoRoot, files); err != nil {
		return err
	}
	if err := validateGitPatchPayloadPaths(repoRoot, patches); err != nil {
		return err
	}
	if err := s.restore(); err != nil {
		return err
	}
	// Reconciliation happens after the commit has already succeeded. If any
	// path cannot be reconciled, restore the exact pre-operation index before
	// returning so a later retry never observes a partially rebuilt index.
	rollbackOnError := func(operationErr error) error {
		if restoreErr := s.restore(); restoreErr != nil {
			return fmt.Errorf("%v; additionally failed to roll back git index: %w", operationErr, restoreErr)
		}
		return operationErr
	}

	fullPaths := uniqueNonEmptyStrings(files)
	if len(fullPaths) > 0 {
		args := []string{"reset", "HEAD", "--"}
		args = append(args, fullPaths...)
		cmd := newGitCommand(args...)
		cmd.Dir = repoRoot
		if output, err := cmd.CombinedOutput(); err != nil {
			return rollbackOnError(gitCommandError(err, output))
		}
	}

	seen := make(map[string]struct{})
	for _, patch := range patches {
		if patch.FilePath == "" {
			continue
		}
		if _, ok := seen[patch.FilePath]; ok {
			continue
		}
		seen[patch.FilePath] = struct{}{}

		if err := applyPatchToIndex(repoRoot, patch.Patch); err == nil {
			continue
		}
		if err := checkGitPatch(repoRoot, patch.Patch, true); err == nil {
			// The original index already contained the selected change.
			continue
		}
		if err := mergeCommittedPathIntoIndex(repoRoot, oldHead, patch.FilePath); err != nil {
			return rollbackOnError(err)
		}
	}
	return nil
}

func checkGitPatch(repoRoot, patch string, reverse bool) error {
	args := []string{"apply", "--check", "--cached"}
	if reverse {
		args = append(args, "-R")
	}
	args = append(args, "--unidiff-zero", "--whitespace=nowarn", "-")
	cmd := newGitCommand(args...)
	cmd.Dir = repoRoot
	cmd.Stdin = strings.NewReader(patch)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return gitCommandError(err, output)
	}
	return nil
}

func mergeCommittedPathIntoIndex(repoRoot, oldHead, filePath string) error {
	base, _, err := readGitBlob(repoRoot, oldHead+":"+filePath)
	if err != nil {
		return err
	}
	originalIndex, indexExists, err := readGitBlob(repoRoot, ":"+filePath)
	if err != nil {
		return err
	}
	newHead, headExists, err := readGitBlob(repoRoot, "HEAD:"+filePath)
	if err != nil {
		return err
	}
	if !headExists {
		cmd := newGitCommand("update-index", "--force-remove", "--", filePath)
		cmd.Dir = repoRoot
		if output, removeErr := cmd.CombinedOutput(); removeErr != nil {
			return gitCommandError(removeErr, output)
		}
		return nil
	}
	if !indexExists {
		originalIndex = base
	}

	tmpDir, err := os.MkdirTemp("", "vibego-index-merge-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmpDir)
	oursPath := filepath.Join(tmpDir, "index")
	basePath := filepath.Join(tmpDir, "base")
	theirsPath := filepath.Join(tmpDir, "head")
	for path, content := range map[string][]byte{
		oursPath:   originalIndex,
		basePath:   base,
		theirsPath: newHead,
	} {
		if err := os.WriteFile(path, content, 0600); err != nil {
			return err
		}
	}

	mergeCmd := newGitCommand("merge-file", "-p", "--theirs", oursPath, basePath, theirsPath)
	mergeCmd.Dir = repoRoot
	mergedCapture, stderr, mergeErr := runGitBoundedOutput(mergeCmd, gitConflictContentLimit)
	if mergeErr != nil {
		return fmt.Errorf("cannot preserve staged changes for %s: %w", filePath, gitCommandError(mergeErr, stderr.Bytes()))
	}
	if mergedCapture.truncated {
		return fmt.Errorf("cannot preserve staged changes for %s: merged content exceeds %d bytes", filePath, gitConflictContentLimit)
	}
	merged := append([]byte(nil), mergedCapture.Bytes()...)

	hashCmd := newGitCommand("hash-object", "-w", "--stdin")
	hashCmd.Dir = repoRoot
	hashCmd.Stdin = bytes.NewReader(merged)
	hashOutput, err := hashCmd.Output()
	if err != nil {
		return err
	}
	mode := gitIndexMode(repoRoot, filePath)
	if mode == "" {
		mode = gitTreeMode(repoRoot, "HEAD", filePath)
	}
	if mode == "" {
		mode = "100644"
	}
	updateCmd := newGitCommand("update-index", "--add", "--cacheinfo", mode, strings.TrimSpace(string(hashOutput)), filePath)
	updateCmd.Dir = repoRoot
	if output, updateErr := updateCmd.CombinedOutput(); updateErr != nil {
		return gitCommandError(updateErr, output)
	}
	return nil
}

func readGitBlob(repoRoot, spec string) ([]byte, bool, error) {
	if size, sizeErr := readGitObjectSize(repoRoot, spec); sizeErr == nil && size > gitConflictContentLimit {
		return nil, false, fmt.Errorf("git blob %s exceeds %d bytes", spec, gitConflictContentLimit)
	}

	cmd := newGitCommand("show", spec)
	cmd.Dir = repoRoot
	capture, _, err := runGitBoundedOutput(cmd, gitConflictContentLimit)
	if err != nil {
		return nil, false, nil
	}
	if capture.truncated {
		return nil, false, fmt.Errorf("git blob %s exceeds %d bytes", spec, gitConflictContentLimit)
	}
	return append([]byte(nil), capture.Bytes()...), true, nil
}

func gitIndexMode(repoRoot, filePath string) string {
	cmd := newGitCommand("ls-files", "-s", "--", filePath)
	cmd.Dir = repoRoot
	output, err := cmd.Output()
	if err != nil {
		return ""
	}
	fields := strings.Fields(string(output))
	if len(fields) < 1 {
		return ""
	}
	return fields[0]
}

func gitTreeMode(repoRoot, ref, filePath string) string {
	cmd := newGitCommand("ls-tree", ref, "--", filePath)
	cmd.Dir = repoRoot
	output, err := cmd.Output()
	if err != nil {
		return ""
	}
	fields := strings.Fields(string(output))
	if len(fields) < 1 {
		return ""
	}
	return fields[0]
}

// commitWithSelectedPatches temporarily builds a clean index so a patch-only
// commit cannot include unrelated staged files. The caller's original index is
// restored on every error path. After a successful commit, only the committed
// paths are reset to the new HEAD; unrelated staged paths remain untouched.
func commitWithSelectedPatches(repoRoot string, files []string, patches []GitPatchPayload, summary, description, author, email string, amend, noVerify, signOff, allowEmpty bool) (string, error) {
	if err := validateRepoRelativePaths(repoRoot, files); err != nil {
		return "", err
	}
	if err := validateGitPatchPayloadPaths(repoRoot, patches); err != nil {
		return "", err
	}
	snapshot, err := captureGitIndex(repoRoot)
	if err != nil {
		return "", err
	}
	oldHead := collectHeadHash(repoRoot)
	restoreOnError := func(operationErr error) (string, error) {
		if restoreErr := snapshot.restore(); restoreErr != nil {
			return "", fmt.Errorf("%v; additionally failed to restore git index: %w", operationErr, restoreErr)
		}
		return "", operationErr
	}

	if oldHead != "" {
		resetCmd := newGitCommand("reset", "HEAD")
		resetCmd.Dir = repoRoot
		if output, resetErr := resetCmd.CombinedOutput(); resetErr != nil {
			return restoreOnError(gitCommandError(resetErr, output))
		}
	}

	for _, file := range files {
		addCmd := newGitCommand("add", "--", file)
		addCmd.Dir = repoRoot
		if output, addErr := addCmd.CombinedOutput(); addErr != nil {
			return restoreOnError(fmt.Errorf("failed to add %s: %w", file, gitCommandError(addErr, output)))
		}
	}

	for _, patch := range patches {
		if patch.Patch == "" {
			return restoreOnError(fmt.Errorf("failed to apply patch for %s: empty patch", patch.FilePath))
		}
		if patchErr := applyPatchToIndex(repoRoot, patch.Patch); patchErr != nil {
			return restoreOnError(fmt.Errorf("failed to apply patch for %s: %w", patch.FilePath, patchErr))
		}
	}

	message := summary
	if description != "" {
		message += "\n\n" + description
	}
	commitArgs := []string{"-c", "user.name=" + author, "-c", "user.email=" + email, "commit"}
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
	commitArgs = append(commitArgs, "-m", message)
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
	hashOutput, hashErr := hashCmd.Output()
	if hashErr != nil {
		return restoreOnError(hashErr)
	}

	if restoreErr := snapshot.restoreAfterCommit(repoRoot, oldHead, files, patches); restoreErr != nil {
		// restoreAfterCommit restores the original bytes before reconciling the
		// committed paths, so unrelated index entries remain recoverable here.
		return "", restoreErr
	}
	return strings.TrimSpace(string(hashOutput)), nil
}
