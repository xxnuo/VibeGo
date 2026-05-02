package handler

import (
	"bytes"
	"crypto/sha256"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"

	"github.com/gin-gonic/gin"
)

type StructuredFile struct {
	Path           string              `json:"path"`
	Name           string              `json:"name"`
	IndexStatus    string              `json:"indexStatus"`
	WorktreeStatus string              `json:"worktreeStatus"`
	ChangeType     string              `json:"changeType"`
	IncludedState  string              `json:"includedState"`
	Conflicted     bool                `json:"conflicted"`
	Submodule      *GitSubmoduleStatus `json:"submodule,omitempty"`
}

type StatusSummary struct {
	Changed    int `json:"changed"`
	Staged     int `json:"staged"`
	Unstaged   int `json:"unstaged"`
	Included   int `json:"included"`
	Conflicted int `json:"conflicted"`
}

func porcelainStatusToName(code byte) string {
	switch code {
	case 'M':
		return "modified"
	case 'A':
		return "added"
	case 'D':
		return "deleted"
	case 'R':
		return "renamed"
	case 'C':
		return "copied"
	case '?':
		return "untracked"
	case 'U':
		return "unmerged"
	case '.', ' ':
		return "clean"
	default:
		return "unknown"
	}
}

func normalizeSelectionState(state fileSelectionState, diff *InteractiveDiff) fileSelectionState {
	if diff == nil {
		return fileSelectionState{IncludedState: "all"}
	}

	selectableLineIDs := make([]string, 0)
	selectableLineSet := make(map[string]struct{})
	for _, hunk := range diff.Hunks {
		for _, line := range hunk.Lines {
			if !line.Selectable {
				continue
			}
			selectableLineIDs = append(selectableLineIDs, line.ID)
			selectableLineSet[line.ID] = struct{}{}
		}
	}

	switch state.IncludedState {
	case "none":
		return fileSelectionState{PatchHash: diff.PatchHash, IncludedState: "none"}
	case "partial":
		if state.PatchHash != diff.PatchHash {
			return fileSelectionState{PatchHash: diff.PatchHash, IncludedState: "all"}
		}

		selectedLineIDs := make([]string, 0, len(state.SelectedLineIDs))
		seen := make(map[string]struct{})
		for _, lineID := range state.SelectedLineIDs {
			if _, ok := selectableLineSet[lineID]; !ok {
				continue
			}
			if _, ok := seen[lineID]; ok {
				continue
			}
			seen[lineID] = struct{}{}
			selectedLineIDs = append(selectedLineIDs, lineID)
		}

		if len(selectedLineIDs) == 0 {
			return fileSelectionState{PatchHash: diff.PatchHash, IncludedState: "none"}
		}

		if len(selectedLineIDs) == len(selectableLineIDs) {
			return fileSelectionState{PatchHash: diff.PatchHash, IncludedState: "all"}
		}

		return fileSelectionState{
			PatchHash:       diff.PatchHash,
			IncludedState:   "partial",
			SelectedLineIDs: selectedLineIDs,
		}
	default:
		return fileSelectionState{PatchHash: diff.PatchHash, IncludedState: "all"}
	}
}

func persistSelectionState(store *gitSelectionStore, repoRoot, filePath string, state fileSelectionState) {
	if store == nil || repoRoot == "" || filePath == "" {
		return
	}

	if state.IncludedState == "" || state.IncludedState == "all" {
		store.delete(repoRoot, filePath)
		return
	}

	store.set(repoRoot, filePath, state)
}

func resolveSelectionState(store *gitSelectionStore, repoRoot, filePath string, diff *InteractiveDiff) fileSelectionState {
	if store == nil {
		return normalizeSelectionState(fileSelectionState{IncludedState: "all"}, diff)
	}

	state, ok := store.get(repoRoot, filePath)
	if !ok {
		state = fileSelectionState{IncludedState: "all"}
	}

	resolved := normalizeSelectionState(state, diff)
	persistSelectionState(store, repoRoot, filePath, resolved)
	return resolved
}

func getSelectedLineIDsForState(state fileSelectionState, diff *InteractiveDiff) []string {
	if diff == nil {
		return nil
	}

	if state.IncludedState == "none" {
		return []string{}
	}

	selectableLineIDs := make([]string, 0)
	for _, hunk := range diff.Hunks {
		for _, line := range hunk.Lines {
			if line.Selectable {
				selectableLineIDs = append(selectableLineIDs, line.ID)
			}
		}
	}

	if state.IncludedState == "all" {
		return selectableLineIDs
	}

	return append([]string(nil), state.SelectedLineIDs...)
}

func applySelectionStateToDiff(diff *InteractiveDiff, state fileSelectionState) {
	if diff == nil {
		return
	}

	selectedLineSet := make(map[string]struct{})
	for _, lineID := range getSelectedLineIDsForState(state, diff) {
		selectedLineSet[lineID] = struct{}{}
	}

	for hunkIndex := range diff.Hunks {
		for lineIndex := range diff.Hunks[hunkIndex].Lines {
			line := &diff.Hunks[hunkIndex].Lines[lineIndex]
			if !line.Selectable {
				line.Selected = false
				continue
			}
			_, line.Selected = selectedLineSet[line.ID]
		}
	}

	diff.IncludedState = state.IncludedState
}

func (h *GitHandler) collectStructuredStatus(repoRoot string) ([]StructuredFile, StatusSummary) {
	return h.collectStructuredStatusWithScope(repoRoot, repoRoot)
}

func (h *GitHandler) collectStructuredStatusWithScope(repoRoot string, scopeKey string) ([]StructuredFile, StatusSummary) {
	cmd := newGitCommand("status", "--porcelain=v1", "-z", "--ignore-submodules=none")
	cmd.Dir = repoRoot
	output, err := cmd.Output()
	if err != nil {
		return []StructuredFile{}, StatusSummary{}
	}

	var files []StructuredFile
	summary := StatusSummary{}
	submoduleStatuses := submoduleStatusCodeMap(repoRoot)
	seen := map[string]bool{}
	validPaths := map[string]struct{}{}
	entries := strings.Split(string(output), "\x00")

	for i := 0; i < len(entries); i++ {
		line := entries[i]
		if line == "" || len(line) < 3 {
			continue
		}
		x := line[0]
		y := line[1]
		if x == '!' && y == '!' {
			continue
		}
		path := line[3:]
		if (x == 'R' || x == 'C') && i+1 < len(entries) {
			path = entries[i+1]
			i++
		}
		if path == "" || seen[path] {
			continue
		}
		seen[path] = true
		validPaths[path] = struct{}{}

		name := path
		if idx := strings.LastIndex(path, "/"); idx >= 0 {
			name = path[idx+1:]
		}

		indexStatus := porcelainStatusToName(x)
		worktreeStatus := porcelainStatusToName(y)

		if x == '?' && y == '?' {
			indexStatus = "untracked"
			worktreeStatus = "untracked"
		}

		changeType := "modified"
		if x == '?' || y == '?' {
			changeType = "untracked"
		} else if x == 'A' || y == 'A' {
			changeType = "added"
		} else if x == 'D' || y == 'D' {
			changeType = "deleted"
		} else if x == 'R' || y == 'R' {
			changeType = "renamed"
		} else if x == 'C' || y == 'C' {
			changeType = "copied"
		} else if x == 'U' || y == 'U' {
			changeType = "unmerged"
		}

		conflicted := x == 'U' || y == 'U' || (x == 'A' && y == 'A') || (x == 'D' && y == 'D')

		includedState := "all"
		if h != nil && h.selectionStore != nil {
			if selectionState, ok := h.selectionStore.get(scopeKey, path); ok {
				if selectionState.IncludedState == "partial" {
					diff, diffErr := getGitDiff(repoRoot, path, "working")
					if diffErr != nil {
						h.selectionStore.delete(scopeKey, path)
					} else {
						includedState = resolveSelectionState(h.selectionStore, scopeKey, path, diff).IncludedState
					}
				} else if selectionState.IncludedState == "none" {
					includedState = "none"
				}
			}
		}

		files = append(files, StructuredFile{
			Path:           path,
			Name:           name,
			IndexStatus:    indexStatus,
			WorktreeStatus: worktreeStatus,
			ChangeType:     changeType,
			IncludedState:  includedState,
			Conflicted:     conflicted,
			Submodule:      submoduleStatusValue(submoduleStatuses, path),
		})

		summary.Changed++
		if indexStatus != "clean" && indexStatus != "untracked" {
			summary.Staged++
		}
		if worktreeStatus != "clean" {
			summary.Unstaged++
		}
		if conflicted {
			summary.Conflicted++
		}
		if includedState != "none" {
			summary.Included++
		}
	}

	if h != nil && h.selectionStore != nil {
		h.selectionStore.pruneRepo(scopeKey, validPaths)
	}

	sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })
	return files, summary
}

type DiffLine struct {
	ID         string `json:"id"`
	Kind       string `json:"kind"`
	Content    string `json:"content"`
	OldLine    int    `json:"oldLine"`
	NewLine    int    `json:"newLine"`
	Selectable bool   `json:"selectable"`
	Selected   bool   `json:"selected"`
}

type DiffHunk struct {
	ID       string     `json:"id"`
	Header   string     `json:"header"`
	OldStart int        `json:"oldStart"`
	OldLines int        `json:"oldLines"`
	NewStart int        `json:"newStart"`
	NewLines int        `json:"newLines"`
	Lines    []DiffLine `json:"lines"`
	Patch    string     `json:"patch"`
}

type DiffStats struct {
	Added   int `json:"added"`
	Deleted int `json:"deleted"`
	Hunks   int `json:"hunks"`
	Lines   int `json:"lines"`
}

type DiffCapability struct {
	LineSelectable bool `json:"lineSelectable"`
}

type InteractiveDiff struct {
	Path           string            `json:"path"`
	Mode           string            `json:"mode"`
	Kind           string            `json:"kind,omitempty"`
	Patch          string            `json:"patch"`
	PatchHash      string            `json:"patchHash"`
	PatchSize      int64             `json:"patchSize"`
	PatchTruncated bool              `json:"patchTruncated"`
	Hunks          []DiffHunk        `json:"hunks"`
	Stats          DiffStats         `json:"stats"`
	Capability     DiffCapability    `json:"capability"`
	Old            string            `json:"old"`
	New            string            `json:"new"`
	OldSize        int64             `json:"oldSize"`
	NewSize        int64             `json:"newSize"`
	OldBinary      bool              `json:"oldBinary"`
	NewBinary      bool              `json:"newBinary"`
	OldTruncated   bool              `json:"oldTruncated"`
	NewTruncated   bool              `json:"newTruncated"`
	Binary         bool              `json:"binary"`
	Large          bool              `json:"large"`
	IncludedState  string            `json:"includedState"`
	Submodule      *GitSubmoduleDiff `json:"submodule,omitempty"`
	Image          *GitImageDiff     `json:"image,omitempty"`
}

func computePatchHash(patch string) string {
	h := sha256.Sum256([]byte(patch))
	return fmt.Sprintf("%x", h[:8])
}

func parseUnifiedDiff(patch string) []DiffHunk {
	lines := strings.Split(patch, "\n")
	var hunks []DiffHunk
	var current *DiffHunk
	hunkIdx := 0
	oldLine, newLine := 0, 0

	for _, line := range lines {
		if strings.HasPrefix(line, "@@") {
			hunkIdx++
			hunk := DiffHunk{
				ID:     fmt.Sprintf("hunk-%d", hunkIdx),
				Header: line,
			}
			var oStart, oLines, nStart, nLines int
			fmt.Sscanf(line, "@@ -%d,%d +%d,%d", &oStart, &oLines, &nStart, &nLines)
			if oLines == 0 && oStart > 0 {
				oLines = 1
			}
			if nLines == 0 && nStart > 0 {
				nLines = 1
			}
			hunk.OldStart = oStart
			hunk.OldLines = oLines
			hunk.NewStart = nStart
			hunk.NewLines = nLines
			oldLine = oStart
			newLine = nStart
			hunks = append(hunks, hunk)
			current = &hunks[len(hunks)-1]
			continue
		}

		if current == nil {
			continue
		}

		lineIdx := len(current.Lines) + 1
		if strings.HasPrefix(line, "+") {
			current.Lines = append(current.Lines, DiffLine{
				ID:         fmt.Sprintf("%s-line-%d", current.ID, lineIdx),
				Kind:       "add",
				Content:    line[1:],
				OldLine:    0,
				NewLine:    newLine,
				Selectable: true,
			})
			newLine++
		} else if strings.HasPrefix(line, "-") {
			current.Lines = append(current.Lines, DiffLine{
				ID:         fmt.Sprintf("%s-line-%d", current.ID, lineIdx),
				Kind:       "del",
				Content:    line[1:],
				OldLine:    oldLine,
				NewLine:    0,
				Selectable: true,
			})
			oldLine++
		} else if strings.HasPrefix(line, " ") {
			current.Lines = append(current.Lines, DiffLine{
				ID:         fmt.Sprintf("%s-line-%d", current.ID, lineIdx),
				Kind:       "context",
				Content:    line[1:],
				OldLine:    oldLine,
				NewLine:    newLine,
				Selectable: false,
			})
			oldLine++
			newLine++
		}
	}

	for i := range hunks {
		var patchLines []string
		patchLines = append(patchLines, hunks[i].Header)
		for _, l := range hunks[i].Lines {
			prefix := " "
			if l.Kind == "add" {
				prefix = "+"
			} else if l.Kind == "del" {
				prefix = "-"
			}
			patchLines = append(patchLines, prefix+l.Content)
		}
		hunks[i].Patch = strings.Join(patchLines, "\n")
	}

	return hunks
}

func extractPatchFileHeaders(patch string) (string, string) {
	before := ""
	after := ""

	for _, line := range strings.Split(patch, "\n") {
		if before == "" && strings.HasPrefix(line, "--- ") {
			before = line
			continue
		}
		if before != "" && after == "" && strings.HasPrefix(line, "+++ ") {
			after = line
			break
		}
	}

	return before, after
}

func formatPatchRange(startLine, count int) string {
	if count == 0 {
		return fmt.Sprintf("%d,0", startLine)
	}
	if count == 1 {
		return fmt.Sprintf("%d", startLine)
	}
	return fmt.Sprintf("%d,%d", startLine, count)
}

func buildSelectionPatch(diff *InteractiveDiff, selectedLineIDs []string) string {
	if diff == nil || len(diff.Hunks) == 0 {
		return ""
	}

	selectedLineSet := make(map[string]struct{}, len(selectedLineIDs))
	for _, lineID := range selectedLineIDs {
		selectedLineSet[lineID] = struct{}{}
	}

	beforeHeader, afterHeader := extractPatchFileHeaders(diff.Patch)
	if beforeHeader == "" || afterHeader == "" {
		return ""
	}

	isNewFile := strings.HasPrefix(beforeHeader, "--- /dev/null")
	hunks := make([]string, 0)

	for _, hunk := range diff.Hunks {
		lines := make([]string, 0, len(hunk.Lines))
		oldCount := 0
		newCount := 0
		hasSelectedChange := false

		for _, line := range hunk.Lines {
			switch line.Kind {
			case "context":
				lines = append(lines, " "+line.Content)
				oldCount++
				newCount++
			case "del":
				if _, ok := selectedLineSet[line.ID]; ok {
					lines = append(lines, "-"+line.Content)
					oldCount++
					hasSelectedChange = true
				} else {
					lines = append(lines, " "+line.Content)
					oldCount++
					newCount++
				}
			case "add":
				if _, ok := selectedLineSet[line.ID]; ok {
					lines = append(lines, "+"+line.Content)
					newCount++
					hasSelectedChange = true
				} else if !isNewFile {
					continue
				}
			}
		}

		if !hasSelectedChange {
			continue
		}

		header := fmt.Sprintf(
			"@@ -%s +%s @@",
			formatPatchRange(hunk.OldStart, oldCount),
			formatPatchRange(hunk.NewStart, newCount),
		)
		hunks = append(hunks, header+"\n"+strings.Join(lines, "\n"))
	}

	if len(hunks) == 0 {
		return ""
	}

	return beforeHeader + "\n" + afterHeader + "\n" + strings.Join(hunks, "\n") + "\n"
}

func buildReverseSelectionPatch(diff *InteractiveDiff, selectedLineIDs []string) string {
	if diff == nil || len(diff.Hunks) == 0 {
		return ""
	}

	selectedLineSet := make(map[string]struct{}, len(selectedLineIDs))
	for _, lineID := range selectedLineIDs {
		selectedLineSet[lineID] = struct{}{}
	}

	beforeHeader, afterHeader := extractPatchFileHeaders(diff.Patch)
	if beforeHeader == "" || afterHeader == "" {
		return ""
	}

	beforeHeader = strings.Replace(beforeHeader, "--- a/", "--- b/", 1)

	hunks := make([]string, 0)
	delta := 0

	for _, hunk := range diff.Hunks {
		lines := make([]string, 0, len(hunk.Lines))
		oldCount := 0
		newCount := 0
		hasSelectedChange := false

		for _, line := range hunk.Lines {
			_, selected := selectedLineSet[line.ID]

			switch line.Kind {
			case "context":
				lines = append(lines, " "+line.Content)
				oldCount++
				newCount++
			case "add":
				if selected {
					lines = append(lines, "-"+line.Content)
					oldCount++
					hasSelectedChange = true
				} else {
					lines = append(lines, " "+line.Content)
					oldCount++
					newCount++
				}
			case "del":
				if selected {
					lines = append(lines, "+"+line.Content)
					newCount++
					hasSelectedChange = true
				}
			}
		}

		if !hasSelectedChange {
			continue
		}

		header := fmt.Sprintf(
			"@@ -%s +%s @@",
			formatPatchRange(hunk.NewStart, oldCount),
			formatPatchRange(hunk.NewStart+delta, newCount),
		)
		hunks = append(hunks, header+"\n"+strings.Join(lines, "\n"))
		delta += newCount - oldCount
	}

	if len(hunks) == 0 {
		return ""
	}

	return beforeHeader + "\n" + afterHeader + "\n" + strings.Join(hunks, "\n") + "\n"
}

func getSelectableLineIDs(diff *InteractiveDiff) []string {
	if diff == nil {
		return nil
	}

	lineIDs := make([]string, 0)
	for _, hunk := range diff.Hunks {
		for _, line := range hunk.Lines {
			if line.Selectable {
				lineIDs = append(lineIDs, line.ID)
			}
		}
	}
	return lineIDs
}

func getTargetLineIDs(diff *InteractiveDiff, target string, lineIDs []string, hunkIDs []string) []string {
	if diff == nil {
		return nil
	}

	switch target {
	case "file":
		return getSelectableLineIDs(diff)
	case "hunk":
		hunkIDSet := make(map[string]struct{}, len(hunkIDs))
		for _, hunkID := range hunkIDs {
			hunkIDSet[hunkID] = struct{}{}
		}

		result := make([]string, 0)
		for _, hunk := range diff.Hunks {
			if _, ok := hunkIDSet[hunk.ID]; !ok {
				continue
			}
			for _, line := range hunk.Lines {
				if line.Selectable {
					result = append(result, line.ID)
				}
			}
		}
		return result
	default:
		return append([]string(nil), lineIDs...)
	}
}

func buildNextSelectionState(currentState fileSelectionState, diff *InteractiveDiff, action string, targetLineIDs []string) fileSelectionState {
	selectableLineIDs := getSelectableLineIDs(diff)
	selectableLineSet := make(map[string]struct{}, len(selectableLineIDs))
	for _, lineID := range selectableLineIDs {
		selectableLineSet[lineID] = struct{}{}
	}

	selectedLineSet := make(map[string]struct{})
	for _, lineID := range getSelectedLineIDsForState(currentState, diff) {
		if _, ok := selectableLineSet[lineID]; ok {
			selectedLineSet[lineID] = struct{}{}
		}
	}

	for _, lineID := range targetLineIDs {
		if _, ok := selectableLineSet[lineID]; !ok {
			continue
		}
		if action == "include" {
			selectedLineSet[lineID] = struct{}{}
		} else {
			delete(selectedLineSet, lineID)
		}
	}

	nextSelectedLineIDs := make([]string, 0, len(selectedLineSet))
	for _, lineID := range selectableLineIDs {
		if _, ok := selectedLineSet[lineID]; ok {
			nextSelectedLineIDs = append(nextSelectedLineIDs, lineID)
		}
	}

	switch {
	case len(nextSelectedLineIDs) == 0:
		return fileSelectionState{PatchHash: diff.PatchHash, IncludedState: "none"}
	case len(nextSelectedLineIDs) == len(selectableLineIDs):
		return fileSelectionState{PatchHash: diff.PatchHash, IncludedState: "all"}
	default:
		return fileSelectionState{
			PatchHash:       diff.PatchHash,
			IncludedState:   "partial",
			SelectedLineIDs: nextSelectedLineIDs,
		}
	}
}

func getGitDiff(repoRoot, filePath, mode string) (*InteractiveDiff, error) {
	previewLimit := gitDiffPreviewLimitForPath(filePath)
	var args []string
	switch mode {
	case "staged":
		args = []string{"diff", "--cached", "--no-ext-diff", "--no-textconv", "--", filePath}
	default:
		args = []string{"diff", "HEAD", "--no-ext-diff", "--no-textconv", "--", filePath}
	}

	oldPreview := gitContentPreview{}
	if old, oldErr := readGitObjectPreviewWithLimit(repoRoot, "HEAD:"+filePath, previewLimit); oldErr == nil {
		oldPreview = old
	}
	newPreview := gitContentPreview{}
	if mode == "staged" {
		if staged, stagedErr := readGitObjectPreviewWithLimit(repoRoot, ":"+filePath, previewLimit); stagedErr == nil {
			newPreview = staged
		}
	} else {
		if working, workingErr := readWorkingGitPreviewWithLimit(filepath.Join(repoRoot, filePath), previewLimit); workingErr == nil {
			newPreview = working
		}
	}

	cmd := newGitCommand(args...)
	cmd.Dir = repoRoot
	patchCapture, _, err := runGitBoundedOutput(cmd, gitDiffPatchLimit)
	patchAvailable := err == nil
	if err != nil && !(mode == "working" && !oldPreview.exists && newPreview.exists) {
		return &InteractiveDiff{
			Path:       filePath,
			Mode:       mode,
			Hunks:      []DiffHunk{},
			Stats:      DiffStats{},
			Capability: DiffCapability{LineSelectable: true},
		}, nil
	}
	output := []byte{}
	patchTruncated := false
	if patchAvailable {
		output = patchCapture.Bytes()
		patchTruncated = patchCapture.truncated
	}

	if mode == "working" && len(output) == 0 && !oldPreview.exists && newPreview.exists {
		noIndexCmd := newGitCommand("diff", "--no-index", "--no-ext-diff", "--no-textconv", "--", "/dev/null", filePath)
		noIndexCmd.Dir = repoRoot
		noIndexCapture, _, noIndexErr := runGitBoundedOutput(noIndexCmd, gitDiffPatchLimit)
		if noIndexErr == nil {
			output = noIndexCapture.Bytes()
			patchTruncated = noIndexCapture.truncated
			patchCapture = noIndexCapture
			patchAvailable = true
		} else if exitErr, ok := noIndexErr.(*exec.ExitError); ok && exitErr.ExitCode() == 1 {
			output = noIndexCapture.Bytes()
			patchTruncated = noIndexCapture.truncated
			patchCapture = noIndexCapture
			patchAvailable = true
		}
	}
	if !patchAvailable {
		return &InteractiveDiff{
			Path:       filePath,
			Mode:       mode,
			Hunks:      []DiffHunk{},
			Stats:      DiffStats{},
			Capability: DiffCapability{LineSelectable: true},
		}, nil
	}

	patch := string(output)
	if submodule := buildGitSubmoduleDiff(repoRoot, filePath, mode, output); submodule != nil {
		return &InteractiveDiff{
			Path: filePath, Mode: mode, Kind: "submodule", Patch: patch,
			PatchHash: patchCapture.Digest(), PatchSize: patchCapture.Size(),
			PatchTruncated: patchTruncated, Capability: DiffCapability{LineSelectable: false},
			Submodule: submodule, IncludedState: "all",
		}, nil
	}
	binary := oldPreview.binary || newPreview.binary || bytes.Contains(output, []byte("Binary files ")) || bytes.Contains(output, []byte("GIT binary patch"))
	imagePreview := buildGitImagePreview(filePath, oldPreview, newPreview)
	hunks := []DiffHunk{}
	if !patchTruncated && !binary {
		hunks = parseUnifiedDiff(patch)
	}

	stats := DiffStats{Hunks: len(hunks)}
	for _, h := range hunks {
		for _, l := range h.Lines {
			stats.Lines++
			if l.Kind == "add" {
				stats.Added++
			} else if l.Kind == "del" {
				stats.Deleted++
			}
		}
	}

	if binary {
		// Binary contents are intentionally not serialized as JSON strings. The
		// exact byte sizes and binary marker remain available to the caller.
		oldPreview.content = nil
		newPreview.content = nil
	}
	large := patchTruncated || oldPreview.truncated || newPreview.truncated
	lineSelectable := !binary && !patchTruncated

	return &InteractiveDiff{
		Path:           filePath,
		Mode:           mode,
		Patch:          patch,
		PatchHash:      patchCapture.Digest(),
		PatchSize:      patchCapture.Size(),
		PatchTruncated: patchTruncated,
		Hunks:          hunks,
		Stats:          stats,
		Capability:     DiffCapability{LineSelectable: lineSelectable},
		Old:            gitPreviewText(oldPreview),
		New:            gitPreviewText(newPreview),
		OldSize:        oldPreview.size,
		NewSize:        newPreview.size,
		OldBinary:      oldPreview.binary,
		NewBinary:      newPreview.binary,
		OldTruncated:   oldPreview.truncated,
		NewTruncated:   newPreview.truncated,
		Binary:         binary,
		Large:          large,
		Image:          imagePreview.response(),
	}, nil
}

type FileDiffRequest struct {
	Path     string `json:"path" binding:"required"`
	FilePath string `json:"filePath" binding:"required"`
	Mode     string `json:"mode"`
	GitScopeRequest
}

func (h *GitHandler) FileDiff(c *gin.Context) {
	var req FileDiffRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	if req.Mode == "" {
		req.Mode = "working"
	}
	if req.Mode != "working" && req.Mode != "staged" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "mode must be working or staged"})
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
	scopeKey := buildGitScopeKey(req.WorkspaceSessionID, req.GroupID, repoRoot)
	diff, err := getGitDiff(repoRoot, req.FilePath, req.Mode)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	if req.Mode == "working" {
		selectionState := resolveSelectionState(h.selectionStore, scopeKey, req.FilePath, diff)
		applySelectionStateToDiff(diff, selectionState)
	}

	c.JSON(http.StatusOK, diff)
}

type ApplySelectionRequest struct {
	Path      string   `json:"path" binding:"required"`
	FilePath  string   `json:"filePath" binding:"required"`
	Mode      string   `json:"mode" binding:"required"`
	Target    string   `json:"target" binding:"required"`
	Action    string   `json:"action" binding:"required"`
	PatchHash string   `json:"patchHash"`
	LineIds   []string `json:"lineIds"`
	HunkIds   []string `json:"hunkIds"`
	GitScopeRequest
}

type ApplySelectionBatchRequest struct {
	Path      string   `json:"path" binding:"required"`
	Mode      string   `json:"mode" binding:"required"`
	Action    string   `json:"action" binding:"required"`
	FilePaths []string `json:"filePaths" binding:"required"`
	GitScopeRequest
}

func (h *GitHandler) ApplySelection(c *gin.Context) {
	var req ApplySelectionRequest
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
	scopeKey := buildGitScopeKey(req.WorkspaceSessionID, req.GroupID, repoRoot)

	if req.Mode == "staged" {
		switch req.Action {
		case "include":
			if req.Target == "file" {
				cmd := newGitCommand("add", "--", req.FilePath)
				cmd.Dir = repoRoot
				if out, cmdErr := cmd.CombinedOutput(); cmdErr != nil {
					c.JSON(http.StatusInternalServerError, gin.H{"error": gitCommandError(cmdErr, out).Error()})
					return
				}
				break
			}

			workingDiff, err := getGitDiff(repoRoot, req.FilePath, "working")
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
				return
			}

			if req.PatchHash != "" && workingDiff.PatchHash != req.PatchHash {
				c.JSON(http.StatusConflict, gin.H{"error": "diff changed, please refresh"})
				return
			}

			targetLineIDs := getTargetLineIDs(workingDiff, req.Target, req.LineIds, req.HunkIds)
			patch := buildSelectionPatch(workingDiff, targetLineIDs)
			if patch == "" {
				c.JSON(http.StatusBadRequest, gin.H{"error": "no selected changes"})
				return
			}
			if err := applyPatchToIndex(repoRoot, patch); err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
				return
			}
		case "exclude":
			diff, err := getGitDiff(repoRoot, req.FilePath, req.Mode)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
				return
			}

			if req.PatchHash != "" && diff.PatchHash != req.PatchHash {
				c.JSON(http.StatusConflict, gin.H{"error": "diff changed, please refresh"})
				return
			}

			if req.Target == "file" {
				cmd := newGitCommand("reset", "HEAD", "--", req.FilePath)
				cmd.Dir = repoRoot
				if out, cmdErr := cmd.CombinedOutput(); cmdErr != nil {
					c.JSON(http.StatusInternalServerError, gin.H{"error": gitCommandError(cmdErr, out).Error()})
					return
				}
				break
			}

			targetLineIDs := getTargetLineIDs(diff, req.Target, req.LineIds, req.HunkIds)
			patch := buildReverseSelectionPatch(diff, targetLineIDs)
			if patch == "" {
				c.JSON(http.StatusBadRequest, gin.H{"error": "no selected changes"})
				return
			}
			if err := applyGitPatch(repoRoot, patch, true, false); err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
				return
			}
		case "discard":
			if req.Target != "file" {
				c.JSON(http.StatusBadRequest, gin.H{"error": "partial staged discard is not supported"})
				return
			}

			if err := discardStagedGitPath(repoRoot, req.FilePath); err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
				return
			}
		default:
			c.JSON(http.StatusBadRequest, gin.H{"error": "unsupported staged selection action"})
			return
		}

		files, summary := h.collectStructuredStatusWithScope(repoRoot, scopeKey)
		nextDiff, _ := getGitDiff(repoRoot, req.FilePath, req.Mode)
		result := gin.H{"ok": true, "status": gin.H{"files": files, "summary": summary}}
		if nextDiff != nil && len(nextDiff.Hunks) > 0 {
			result["diff"] = nextDiff
		}
		unlockRepo()
		h.broadcastStatus(req.Path)
		c.JSON(http.StatusOK, result)
		return
	}

	diff, err := getGitDiff(repoRoot, req.FilePath, "working")
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	if req.PatchHash != "" && diff.PatchHash != req.PatchHash {
		c.JSON(http.StatusConflict, gin.H{"error": "diff changed, please refresh"})
		return
	}

	targetLineIDs := getTargetLineIDs(diff, req.Target, req.LineIds, req.HunkIds)
	currentState := resolveSelectionState(h.selectionStore, scopeKey, req.FilePath, diff)

	switch req.Action {
	case "include", "exclude":
		nextState := buildNextSelectionState(currentState, diff, req.Action, targetLineIDs)
		persistSelectionState(h.selectionStore, scopeKey, req.FilePath, nextState)
	case "discard":
		if req.Target == "file" {
			if err := discardGitPath(repoRoot, req.FilePath); err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
				return
			}
			h.selectionStore.delete(scopeKey, req.FilePath)
			break
		}
		patch := buildSelectionPatch(diff, targetLineIDs)
		if patch == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "no selected changes"})
			return
		}
		if err := applyGitPatch(repoRoot, patch, false, true); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
	default:
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid action"})
		return
	}

	files, summary := h.collectStructuredStatusWithScope(repoRoot, scopeKey)
	diff, _ = getGitDiff(repoRoot, req.FilePath, "working")
	if diff != nil {
		selectionState := resolveSelectionState(h.selectionStore, scopeKey, req.FilePath, diff)
		applySelectionStateToDiff(diff, selectionState)
	}

	result := gin.H{"ok": true, "status": gin.H{"files": files, "summary": summary}}
	if diff != nil && len(diff.Hunks) > 0 {
		result["diff"] = diff
	}
	unlockRepo()
	h.broadcastStatusScoped(req.Path, req.WorkspaceSessionID, req.GroupID)
	h.broadcastRepoSyncNeededScoped(req.Path, req.WorkspaceSessionID, req.GroupID, gin.H{"status": true, "draft": true})
	c.JSON(http.StatusOK, result)
}

func (h *GitHandler) ApplySelectionBatch(c *gin.Context) {
	var req ApplySelectionBatchRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	if req.Mode != "working" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "only working mode batch selection is supported"})
		return
	}
	if req.Action != "include" && req.Action != "exclude" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid action"})
		return
	}

	repoRoot, err := h.getRepoRoot(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	unlockRepo := lockGitOperationRepo(repoRoot)
	defer unlockRepo()
	if err := validateRepoRelativePaths(repoRoot, req.FilePaths); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	scopeKey := buildGitScopeKey(req.WorkspaceSessionID, req.GroupID, repoRoot)

	for _, filePath := range req.FilePaths {
		diff, diffErr := getGitDiff(repoRoot, filePath, "working")
		if diffErr != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": diffErr.Error()})
			return
		}
		currentState := resolveSelectionState(h.selectionStore, scopeKey, filePath, diff)
		nextState := buildNextSelectionState(currentState, diff, req.Action, getSelectableLineIDs(diff))
		persistSelectionState(h.selectionStore, scopeKey, filePath, nextState)
	}

	files, summary := h.collectStructuredStatusWithScope(repoRoot, scopeKey)
	unlockRepo()
	h.broadcastStatusScoped(req.Path, req.WorkspaceSessionID, req.GroupID)
	h.broadcastRepoSyncNeededScoped(req.Path, req.WorkspaceSessionID, req.GroupID, gin.H{"status": true, "draft": true})
	c.JSON(http.StatusOK, gin.H{"ok": true, "status": gin.H{"files": files, "summary": summary}})
}

type StashFilesRequest struct {
	Path  string `json:"path" binding:"required"`
	Index int    `json:"index"`
	OID   string `json:"oid"`
}

type StashFileInfo struct {
	Path   string `json:"path"`
	Status string `json:"status"`
}

func (h *GitHandler) StashFiles(c *gin.Context) {
	var req StashFilesRequest
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
	_, stashOID, err := resolveGitStashReference(repoRoot, req.Index, req.OID)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	cmd := newGitCommand("stash", "show", "--name-status", "--include-untracked", "-z", stashOID)
	cmd.Dir = repoRoot
	output, err := cmd.Output()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get stash files"})
		return
	}

	var files []StashFileInfo
	parts := strings.Split(string(output), "\x00")
	for i := 0; i < len(parts); {
		statusCode := parts[i]
		i++
		if statusCode == "" || i >= len(parts) {
			break
		}
		status := "modified"
		if len(statusCode) > 0 {
			switch statusCode[0] {
			case 'A':
				status = "added"
			case 'D':
				status = "deleted"
			case 'R':
				status = "renamed"
			case 'C':
				status = "copied"
			}
		}
		filePath := parts[i]
		i++
		if len(statusCode) > 0 && (statusCode[0] == 'R' || statusCode[0] == 'C') {
			if i >= len(parts) {
				break
			}
			filePath = parts[i]
			i++
		}
		files = append(files, StashFileInfo{Path: filePath, Status: status})
	}

	c.JSON(http.StatusOK, gin.H{"files": files})
}

type StashDiffRequest struct {
	Path     string `json:"path" binding:"required"`
	Index    int    `json:"index"`
	OID      string `json:"oid"`
	FilePath string `json:"filePath" binding:"required"`
}

func (h *GitHandler) StashDiff(c *gin.Context) {
	var req StashDiffRequest
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
	_, stashOID, err := resolveGitStashReference(repoRoot, req.Index, req.OID)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := validateRepoRelativeLiteralPath(repoRoot, req.FilePath); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	stashRef := stashOID
	oldRef := stashRef + "^"
	newRef := stashRef
	oldSpec := oldRef + ":" + req.FilePath
	newSpec := newRef + ":" + req.FilePath

	// `stash push --include-untracked` stores untracked files in a third
	// parent rather than the stash tree itself. Use that parent as the new
	// side, reversing the diff range, so an untracked file is rendered as an
	// addition instead of disappearing from the detail view.
	if _, err := readGitObjectPreview(repoRoot, newSpec); err != nil {
		untrackedSpec := stashRef + "^3:" + req.FilePath
		if _, untrackedErr := readGitObjectPreview(repoRoot, untrackedSpec); untrackedErr == nil {
			oldRef = stashRef
			newRef = stashRef + "^3"
			oldSpec = stashRef + ":" + req.FilePath
			newSpec = untrackedSpec
		}
	}

	cmd := newGitCommand("--literal-pathspecs", "diff", oldRef+".."+newRef, "--no-ext-diff", "--no-textconv", "--", req.FilePath)
	cmd.Dir = repoRoot
	patchCapture, _, err := runGitBoundedOutput(cmd, gitDiffPatchLimit)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get stash diff"})
		return
	}

	output := patchCapture.Bytes()
	patchTruncated := patchCapture.truncated
	patch := string(output)
	previewLimit := gitDiffPreviewLimitForPath(req.FilePath)
	parentPreview, _ := readGitObjectPreviewWithLimit(repoRoot, oldSpec, previewLimit)
	stashPreview, _ := readGitObjectPreviewWithLimit(repoRoot, newSpec, previewLimit)
	binary := parentPreview.binary || stashPreview.binary || bytes.Contains(output, []byte("Binary files ")) || bytes.Contains(output, []byte("GIT binary patch"))
	imagePreview := buildGitImagePreview(req.FilePath, parentPreview, stashPreview)
	hunks := []DiffHunk{}
	if !patchTruncated && !binary {
		hunks = parseUnifiedDiff(patch)
	}

	stats := DiffStats{Hunks: len(hunks)}
	for _, h := range hunks {
		for _, l := range h.Lines {
			stats.Lines++
			if l.Kind == "add" {
				stats.Added++
			} else if l.Kind == "del" {
				stats.Deleted++
			}
		}
	}

	if binary {
		parentPreview.content = nil
		stashPreview.content = nil
	}

	c.JSON(http.StatusOK, InteractiveDiff{
		Path:           req.FilePath,
		Mode:           "stash",
		Patch:          patch,
		PatchHash:      patchCapture.Digest(),
		PatchSize:      patchCapture.Size(),
		PatchTruncated: patchTruncated,
		Hunks:          hunks,
		Stats:          stats,
		Capability:     DiffCapability{LineSelectable: false},
		Old:            gitPreviewText(parentPreview),
		New:            gitPreviewText(stashPreview),
		OldSize:        parentPreview.size,
		NewSize:        stashPreview.size,
		OldBinary:      parentPreview.binary,
		NewBinary:      stashPreview.binary,
		OldTruncated:   parentPreview.truncated,
		NewTruncated:   stashPreview.truncated,
		Binary:         binary,
		Large:          patchTruncated || parentPreview.truncated || stashPreview.truncated,
		Image:          imagePreview.response(),
	})
}

type ConflictSegment struct {
	Type    string   `json:"type"`
	Text    string   `json:"text,omitempty"`
	BlockID string   `json:"blockId,omitempty"`
	Ours    []string `json:"ours,omitempty"`
	Base    []string `json:"base,omitempty"`
	Theirs  []string `json:"theirs,omitempty"`
}

type ConflictStageDetails struct {
	Present bool `json:"present"`
	Deleted bool `json:"deleted"`
}

type ConflictStages struct {
	Base   ConflictStageDetails `json:"base"`
	Ours   ConflictStageDetails `json:"ours"`
	Theirs ConflictStageDetails `json:"theirs"`
}

type ConflictDetailsResponse struct {
	Path        string            `json:"path"`
	Hash        string            `json:"hash"`
	Segments    []ConflictSegment `json:"segments"`
	BlocksTotal int               `json:"blocksTotal"`
	Stages      ConflictStages    `json:"stages"`
}

type conflictStageSnapshot struct {
	mode     string
	objectID string
	present  bool
}

type conflictStagesSnapshot struct {
	base   conflictStageSnapshot
	ours   conflictStageSnapshot
	theirs conflictStageSnapshot
}

func (stages conflictStagesSnapshot) hasEntries() bool {
	return stages.base.present || stages.ours.present || stages.theirs.present
}

func (stages conflictStagesSnapshot) details() ConflictStages {
	basePresent := stages.base.present
	sidePresent := stages.ours.present || stages.theirs.present
	return ConflictStages{
		Base: ConflictStageDetails{Present: basePresent},
		Ours: ConflictStageDetails{
			Present: stages.ours.present,
			Deleted: sidePresent && !stages.ours.present,
		},
		Theirs: ConflictStageDetails{
			Present: stages.theirs.present,
			Deleted: sidePresent && !stages.theirs.present,
		},
	}
}

func readConflictStages(repoRoot, filePath string) (conflictStagesSnapshot, error) {
	cmd := newGitCommand("--literal-pathspecs", "ls-files", "--unmerged", "-z", "--", filePath)
	cmd.Dir = repoRoot
	output, err := cmd.Output()
	if err != nil {
		return conflictStagesSnapshot{}, err
	}

	var stages conflictStagesSnapshot
	for _, record := range bytes.Split(output, []byte{0}) {
		if len(record) == 0 {
			continue
		}
		header, _, ok := bytes.Cut(record, []byte{'\t'})
		if !ok {
			return conflictStagesSnapshot{}, fmt.Errorf("invalid unmerged index entry")
		}
		fields := strings.Fields(string(header))
		if len(fields) != 3 {
			return conflictStagesSnapshot{}, fmt.Errorf("invalid unmerged index entry")
		}
		stage := conflictStageSnapshot{mode: fields[0], objectID: fields[1], present: true}
		switch fields[2] {
		case "1":
			stages.base = stage
		case "2":
			stages.ours = stage
		case "3":
			stages.theirs = stage
		default:
			return conflictStagesSnapshot{}, fmt.Errorf("invalid unmerged index stage")
		}
	}
	return stages, nil
}

func computeConflictSnapshotHash(content []byte, worktreePresent bool, stages conflictStagesSnapshot) string {
	var snapshot strings.Builder
	fmt.Fprintf(&snapshot, "worktree:%t:%d:", worktreePresent, len(content))
	snapshot.Write(content)
	for _, stage := range []conflictStageSnapshot{stages.base, stages.ours, stages.theirs} {
		fmt.Fprintf(&snapshot, "\x00stage:%t:%s:%s", stage.present, stage.mode, stage.objectID)
	}
	return computePatchHash(snapshot.String())
}

func conflictSnapshotHashMatches(content []byte, worktreePresent bool, stages conflictStagesSnapshot, hash string) bool {
	if hash == "" {
		return true
	}
	// Accept the pre-structured resolver's content-only hash for clients that
	// loaded details before stage metadata was added. New details still return
	// the stronger snapshot hash above, which also protects the unmerged index.
	return hash == computeConflictSnapshotHash(content, worktreePresent, stages) ||
		(worktreePresent && hash == computePatchHash(string(content)))
}

func readConflictWorktree(path string) ([]byte, bool, bool, error) {
	content, truncated, err := readGitFileBounded(path, gitConflictContentLimit)
	if os.IsNotExist(err) {
		return nil, false, false, nil
	}
	return content, true, truncated, err
}

func readConflictStageLines(repoRoot string, stage conflictStageSnapshot) ([]string, error) {
	content, err := readConflictStageContent(repoRoot, stage)
	if err != nil {
		return nil, err
	}
	if !stage.present {
		return nil, nil
	}
	return strings.Split(string(content), "\n"), nil
}

func readConflictStageContent(repoRoot string, stage conflictStageSnapshot) ([]byte, error) {
	if !stage.present {
		return nil, nil
	}
	preview, err := readGitObjectPreviewWithLimit(repoRoot, stage.objectID, gitConflictContentLimit)
	if err != nil {
		return nil, err
	}
	if preview.truncated {
		return nil, fmt.Errorf("conflict stage is too large")
	}
	return append([]byte(nil), preview.content...), nil
}

func buildModifyDeleteConflictSegment(repoRoot string, stages conflictStagesSnapshot) (ConflictSegment, error) {
	ours, err := readConflictStageLines(repoRoot, stages.ours)
	if err != nil {
		return ConflictSegment{}, err
	}
	base, err := readConflictStageLines(repoRoot, stages.base)
	if err != nil {
		return ConflictSegment{}, err
	}
	theirs, err := readConflictStageLines(repoRoot, stages.theirs)
	if err != nil {
		return ConflictSegment{}, err
	}
	return ConflictSegment{
		Type:    "conflict",
		BlockID: "block-1",
		Ours:    ours,
		Base:    base,
		Theirs:  theirs,
	}, nil
}

func (h *GitHandler) ConflictDetails(c *gin.Context) {
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
	if err := rejectGitWritePath(repoRoot, req.FilePath); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	absPath := filepath.Join(repoRoot, req.FilePath)
	stages, err := readConflictStages(repoRoot, req.FilePath)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "cannot read conflict stages"})
		return
	}
	contentBytes, worktreePresent, contentTruncated, err := readConflictWorktree(absPath)
	if err != nil || (!worktreePresent && !stages.hasEntries()) {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "cannot read file"})
		return
	}
	if contentTruncated {
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "conflict file is too large"})
		return
	}
	content := string(contentBytes)
	stageDetails := stages.details()

	segments, blocks := parseConflictMarkers(content)
	if stageDetails.Ours.Deleted || stageDetails.Theirs.Deleted {
		segment, segmentErr := buildModifyDeleteConflictSegment(repoRoot, stages)
		if segmentErr != nil {
			if strings.Contains(segmentErr.Error(), "too large") {
				c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": segmentErr.Error()})
			} else {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "cannot read conflict stages"})
			}
			return
		}
		segments = []ConflictSegment{segment}
		blocks = 1
	}
	hash := computeConflictSnapshotHash(contentBytes, worktreePresent, stages)

	c.JSON(http.StatusOK, ConflictDetailsResponse{
		Path:        req.FilePath,
		Hash:        hash,
		Segments:    segments,
		BlocksTotal: blocks,
		Stages:      stageDetails,
	})
}

func parseConflictMarkers(content string) ([]ConflictSegment, int) {
	lines := strings.Split(content, "\n")
	var segments []ConflictSegment
	var plainLines []string
	blockCount := 0

	type conflictState int
	const (
		stateNone conflictState = iota
		stateOurs
		stateBase
		stateTheirs
	)

	state := stateNone
	var ours, base, theirs []string

	flushPlain := func() {
		if len(plainLines) > 0 {
			segments = append(segments, ConflictSegment{
				Type: "plain",
				Text: strings.Join(plainLines, "\n"),
			})
			plainLines = nil
		}
	}

	for _, line := range lines {
		switch {
		case strings.HasPrefix(line, "<<<<<<<"):
			flushPlain()
			state = stateOurs
			ours = nil
			base = nil
			theirs = nil
		case strings.HasPrefix(line, "|||||||") && state == stateOurs:
			state = stateBase
		case line == "=======" && (state == stateOurs || state == stateBase):
			state = stateTheirs
		case strings.HasPrefix(line, ">>>>>>>") && state == stateTheirs:
			blockCount++
			segments = append(segments, ConflictSegment{
				Type:    "conflict",
				BlockID: fmt.Sprintf("block-%d", blockCount),
				Ours:    ours,
				Base:    base,
				Theirs:  theirs,
			})
			state = stateNone
		default:
			switch state {
			case stateNone:
				plainLines = append(plainLines, line)
			case stateOurs:
				ours = append(ours, line)
			case stateBase:
				base = append(base, line)
			case stateTheirs:
				theirs = append(theirs, line)
			}
		}
	}

	flushPlain()
	return segments, blockCount
}

type ConflictResolveRequest struct {
	Path            string  `json:"path" binding:"required"`
	FilePath        string  `json:"filePath" binding:"required"`
	Mode            string  `json:"mode" binding:"required"`
	Hash            string  `json:"hash"`
	ResolvedContent *string `json:"resolvedContent"`
	ManualContent   *string `json:"manualContent"`
}

func (h *GitHandler) ConflictResolve(c *gin.Context) {
	var req ConflictResolveRequest
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
	if err := rejectGitWritePath(repoRoot, req.FilePath); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	absPath := filepath.Join(repoRoot, req.FilePath)
	stages, stagesErr := readConflictStages(repoRoot, req.FilePath)
	currentBytes, worktreePresent, truncated, readErr := readConflictWorktree(absPath)
	if req.Hash != "" {
		if readErr != nil || stagesErr != nil || truncated ||
			!conflictSnapshotHashMatches(currentBytes, worktreePresent, stages, req.Hash) {
			// The details response is an optimistic snapshot. Refuse to replace a
			// file or unmerged index that changed after it was displayed.
			c.JSON(http.StatusConflict, gin.H{"error": "conflict file changed, please refresh"})
			return
		}
	}
	if readErr != nil || (!worktreePresent && !stages.hasEntries()) {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "cannot read file"})
		return
	}
	if truncated {
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "conflict file is too large"})
		return
	}
	if stagesErr != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "cannot read conflict stages"})
		return
	}

	var resolvedContent string
	deleteResolution := false
	switch req.Mode {
	case "ours":
		if stages.details().Ours.Deleted {
			deleteResolution = true
			break
		}
		stageContent, err := readConflictStageContent(repoRoot, stages.ours)
		if err != nil || !stages.ours.present {
			c.JSON(http.StatusBadRequest, gin.H{"error": "ours version is unavailable"})
			return
		}
		resolvedContent = string(stageContent)
	case "theirs":
		if stages.details().Theirs.Deleted {
			deleteResolution = true
			break
		}
		stageContent, err := readConflictStageContent(repoRoot, stages.theirs)
		if err != nil || !stages.theirs.present {
			c.JSON(http.StatusBadRequest, gin.H{"error": "theirs version is unavailable"})
			return
		}
		resolvedContent = string(stageContent)
	case "delete":
		stageDetails := stages.details()
		if !stageDetails.Ours.Deleted && !stageDetails.Theirs.Deleted {
			c.JSON(http.StatusBadRequest, gin.H{"error": "conflict does not have a deleted side"})
			return
		}
		deleteResolution = true
	case "manual", "line-map":
		if req.ManualContent != nil {
			resolvedContent = *req.ManualContent
		} else if req.ResolvedContent != nil {
			resolvedContent = *req.ResolvedContent
		} else {
			c.JSON(http.StatusBadRequest, gin.H{"error": "manual content required"})
			return
		}
	default:
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid mode"})
		return
	}
	if !deleteResolution && int64(len(resolvedContent)) > gitConflictContentLimit {
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "resolved content is too large"})
		return
	}

	if deleteResolution {
		rmCmd := newGitCommand("--literal-pathspecs", "rm", "--", req.FilePath)
		rmCmd.Dir = repoRoot
		if out, err := rmCmd.CombinedOutput(); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": gitCommandError(err, out).Error()})
			return
		}
	} else {
		if err := os.WriteFile(absPath, []byte(resolvedContent), 0644); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}

		addCmd := newGitCommand("add", "--", req.FilePath)
		addCmd.Dir = repoRoot
		if out, err := addCmd.CombinedOutput(); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": gitCommandError(err, out).Error()})
			return
		}
	}

	conflicts := collectConflictFiles(repoRoot)
	files, summary := h.collectStructuredStatus(repoRoot)

	unlockRepo()
	h.broadcastStatus(req.Path)
	h.broadcastRepoSyncNeeded(req.Path, gin.H{"conflicts": true})
	c.JSON(http.StatusOK, gin.H{
		"ok":        true,
		"conflicts": conflicts,
		"status":    gin.H{"files": files, "summary": summary},
	})
}
