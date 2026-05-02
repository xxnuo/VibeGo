package handler

import (
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

const (
	defaultGitHistoryRecoveryLimit = 100
	maxGitHistoryRecoveryLimit     = 2500
)

// GitReflogRequest controls the bounded reflog query. By default the HEAD
// reflog is returned. Set all=true to inspect all local reflogs, or provide a
// specific ref such as refs/heads/main.
type GitReflogRequest struct {
	Path  string `json:"path" binding:"required"`
	Ref   string `json:"ref"`
	Limit int    `json:"limit"`
	Skip  int    `json:"skip"`
	All   bool   `json:"all"`
}

// GitReflogEntry is a single reflog event. Hash is the object at the tip
// after the event; selector identifies the reflog entry (for example
// HEAD@{0}), while ref is the selector's ref without the date/index suffix.
type GitReflogEntry struct {
	Hash          string `json:"hash"`
	Selector      string `json:"selector"`
	ShortSelector string `json:"shortSelector"`
	Ref           string `json:"ref"`
	Message       string `json:"message"`
	Action        string `json:"action"`
	Date          string `json:"date"`
	Author        string `json:"author"`
	AuthorEmail   string `json:"authorEmail"`
}

type GitReflogResponse struct {
	Entries []GitReflogEntry `json:"entries"`
	Ref     string           `json:"ref"`
	All     bool             `json:"all"`
	HasMore bool             `json:"hasMore"`
}

// GitRecentBranchesRequest controls the number of checkout targets returned.
type GitRecentBranchesRequest struct {
	Path  string `json:"path" binding:"required"`
	Limit int    `json:"limit"`
}

type GitRecentBranchInfo struct {
	Name         string `json:"name"`
	LastCheckout string `json:"lastCheckout"`
	Exists       bool   `json:"exists"`
}

type GitRecentBranchesResponse struct {
	Branches       []GitRecentBranchInfo `json:"branches"`
	RecentBranches []string              `json:"recentBranches"`
}

type GitUnreachableCommitsRequest struct {
	Path  string `json:"path" binding:"required"`
	Limit int    `json:"limit"`
	Skip  int    `json:"skip"`
}

type GitUnreachableCommitsResponse struct {
	Commits []CommitInfo `json:"commits"`
	Total   int          `json:"total"`
	HasMore bool         `json:"hasMore"`
}

var (
	gitCheckoutReflogPattern = regexp.MustCompile(`(?i)^checkout(?:: moving from)?\s+(.*?)\s+to\s+(.*?)\s*$`)
	gitRenameReflogPattern   = regexp.MustCompile(`(?i)^branch:\s+renamed\s+(?:refs/heads/)?(.+?)\s+to\s+(?:refs/heads/)?(.+?)\s*$`)
)

func normalizeGitHistoryRecoveryPagination(limit, skip int) (int, int, error) {
	if limit <= 0 {
		limit = defaultGitHistoryRecoveryLimit
	}
	if limit > maxGitHistoryRecoveryLimit {
		return 0, 0, fmt.Errorf("limit exceeds maximum of %d", maxGitHistoryRecoveryLimit)
	}
	if skip < 0 {
		skip = 0
	}
	if skip > maxGitHistoryRecoveryLimit*maxGitHistoryRecoveryLimit {
		return 0, 0, errors.New("skip is too large")
	}
	return limit, skip, nil
}

func splitGitReflogRecord(line string) (GitReflogEntry, bool) {
	parts := strings.SplitN(line, "\x00", 7)
	if len(parts) != 7 || !isGitObjectID(strings.TrimSpace(parts[0])) {
		return GitReflogEntry{}, false
	}
	selector := strings.TrimSpace(parts[1])
	shortSelector := strings.TrimSpace(parts[2])
	message := strings.TrimSpace(parts[3])
	entry := GitReflogEntry{
		Hash:          strings.TrimSpace(parts[0]),
		Selector:      selector,
		ShortSelector: shortSelector,
		Ref:           gitReflogSelectorRef(selector),
		Message:       message,
		Action:        gitReflogAction(message),
		Date:          strings.TrimSpace(parts[4]),
		Author:        strings.TrimSpace(parts[5]),
		AuthorEmail:   strings.TrimSpace(parts[6]),
	}
	return entry, true
}

// parseGitReflogDateSelector converts the date-bearing selector emitted by
// `%gd` when git is invoked with `--date=iso` into the RFC3339 representation
// used by the API. A selector is intentionally accepted as a fallback: older
// Git versions or unusual date configurations should not erase an otherwise
// useful reflog entry.
func parseGitReflogDateSelector(selector string) string {
	start := strings.Index(selector, "@{")
	end := strings.LastIndex(selector, "}")
	if start < 0 || end <= start+2 {
		return ""
	}
	raw := strings.TrimSpace(selector[start+2 : end])
	for _, layout := range []string{
		"2006-01-02 15:04:05 -0700",
		"2006-01-02 15:04:05 -07:00",
		time.RFC3339,
	} {
		if parsed, err := time.Parse(layout, raw); err == nil {
			return parsed.Format(time.RFC3339)
		}
	}
	return raw
}

type gitReflogDateRecord struct {
	hash    string
	message string
	date    string
}

func splitGitReflogDateRecord(line string) (gitReflogDateRecord, bool) {
	parts := strings.SplitN(line, "\x00", 3)
	if len(parts) != 3 || !isGitObjectID(strings.TrimSpace(parts[0])) {
		return gitReflogDateRecord{}, false
	}
	return gitReflogDateRecord{
		hash:    strings.TrimSpace(parts[0]),
		message: strings.TrimSpace(parts[1]),
		date:    parseGitReflogDateSelector(strings.TrimSpace(parts[2])),
	}, true
}

func gitReflogSelectorRef(selector string) string {
	if at := strings.Index(selector, "@{"); at >= 0 {
		return selector[:at]
	}
	return selector
}

func gitReflogAction(message string) string {
	if colon := strings.IndexByte(message, ':'); colon > 0 {
		return strings.TrimSpace(message[:colon])
	}
	return strings.TrimSpace(message)
}

func gitReflogCommandArgs(req GitReflogRequest, limit, skip int, withEventDate bool) []string {
	format := "%H%x00%gD%x00%gd%x00%gs%x00%aI%x00%gn%x00%ge"
	if withEventDate {
		// `%gd` is date-sensitive, while `%gD`/`%gd` in the primary query are
		// kept in their legacy numeric-selector form for API compatibility.
		format = "%H%x00%gs%x00%gd"
	}
	args := []string{"log", "-g", "--no-abbrev-commit"}
	if withEventDate {
		args = append(args, "--date=iso")
	}
	args = append(args, fmt.Sprintf("--format=%s", format), "-n", strconv.Itoa(limit+skip+1))
	if skip > 0 {
		args = append(args, fmt.Sprintf("--skip=%d", skip))
	}
	if req.All {
		args = append(args, "--all")
	} else {
		ref := strings.TrimSpace(req.Ref)
		if ref == "" {
			ref = "HEAD"
		}
		args = append(args, "--end-of-options", ref)
	}
	return append(args, "--")
}

func (h *GitHandler) collectGitReflog(repoRoot string, req GitReflogRequest) (GitReflogResponse, error) {
	limit, skip, err := normalizeGitHistoryRecoveryPagination(req.Limit, req.Skip)
	if err != nil {
		return GitReflogResponse{}, err
	}

	ref := strings.TrimSpace(req.Ref)
	if req.All {
		ref = ""
	} else {
		if ref == "" {
			ref = "HEAD"
		}
		if err := validateGitRefArgument(ref, "ref"); err != nil {
			return GitReflogResponse{}, err
		}
	}

	args := gitReflogCommandArgs(req, limit, skip, false)
	cmd := newGitCommand(args...)
	cmd.Dir = repoRoot
	output, commandErr := cmd.CombinedOutput()
	if commandErr != nil {
		// An unborn branch has no reflog entries. Git exits 128 for this case;
		// callers should receive an empty, successful response just like /git/log.
		if isGitNoReflogError(repoRoot, commandErr, output, ref, req.All) {
			return GitReflogResponse{Entries: []GitReflogEntry{}, Ref: ref, All: req.All}, nil
		}
		return GitReflogResponse{}, gitCommandError(commandErr, output)
	}

	entries := make([]GitReflogEntry, 0, limit)
	for _, line := range strings.Split(strings.TrimSpace(string(output)), "\n") {
		if line == "" {
			continue
		}
		entry, ok := splitGitReflogRecord(line)
		if !ok {
			continue
		}
		entries = append(entries, entry)
		if len(entries) > limit {
			break
		}
	}
	if len(entries) > 0 {
		// Git's normal author date (`%aI`) describes the pointed-to commit,
		// which is often stale for checkout/reset events. Query the same reflog
		// slice with `--date=iso` and use `%gd`'s event timestamp instead.
		dateCmd := newGitCommand(gitReflogCommandArgs(req, limit, skip, true)...)
		dateCmd.Dir = repoRoot
		dateOutput, dateErr := dateCmd.CombinedOutput()
		if dateErr != nil {
			if !isGitNoReflogError(repoRoot, dateErr, dateOutput, ref, req.All) {
				return GitReflogResponse{}, gitCommandError(dateErr, dateOutput)
			}
		} else {
			dateRecords := make([]gitReflogDateRecord, 0, len(entries))
			for _, line := range strings.Split(strings.TrimSpace(string(dateOutput)), "\n") {
				if record, ok := splitGitReflogDateRecord(line); ok {
					dateRecords = append(dateRecords, record)
				}
			}
			// Match by hash and subject rather than line number so a malformed
			// record in either output cannot shift every later timestamp.
			dateByKey := make(map[string][]string, len(dateRecords))
			for _, record := range dateRecords {
				key := record.hash + "\x00" + record.message
				dateByKey[key] = append(dateByKey[key], record.date)
			}
			for i := range entries {
				key := entries[i].Hash + "\x00" + entries[i].Message
				if dates := dateByKey[key]; len(dates) > 0 {
					if dates[0] != "" {
						entries[i].Date = dates[0]
					}
					dateByKey[key] = dates[1:]
				}
			}
		}
	}
	hasMore := len(entries) > limit
	if len(entries) > limit {
		entries = entries[:limit]
	}
	return GitReflogResponse{
		Entries: entries,
		Ref:     ref,
		All:     req.All,
		HasMore: hasMore,
	}, nil
}

func isGitNoReflogError(repoRoot string, err error, output []byte, ref string, all bool) bool {
	message := strings.ToLower(err.Error() + "\n" + string(output))
	if strings.Contains(message, "does not have any commits yet") {
		return true
	}
	if !all && !strings.Contains(message, "unknown revision") && !strings.Contains(message, "bad revision") {
		return false
	}
	// `git log -g HEAD` reports "bad revision" for an unborn branch, the
	// same wording it uses for an explicitly missing ref. Only swallow that
	// error when the requested ref is the repository's unborn symbolic HEAD.
	return isGitUnbornRef(repoRoot, ref)
}

func isGitUnbornRef(repoRoot, ref string) bool {
	verifyCmd := newGitCommand("rev-parse", "--verify", "--quiet", "HEAD^{commit}")
	verifyCmd.Dir = repoRoot
	if verifyCmd.Run() == nil {
		return false
	}
	symbolicCmd := newGitCommand("symbolic-ref", "--quiet", "HEAD")
	symbolicCmd.Dir = repoRoot
	symbolicOutput, symbolicErr := symbolicCmd.Output()
	if symbolicErr != nil {
		return false
	}
	symbolicRef := strings.TrimSpace(string(symbolicOutput))
	if symbolicRef == "" {
		return false
	}
	ref = strings.TrimSpace(ref)
	if ref == "HEAD" {
		return true
	}
	if strings.HasPrefix(ref, "refs/heads/") {
		return ref == symbolicRef
	}
	// A plain branch name is also accepted by the endpoint. Do not treat
	// revision expressions (e.g. HEAD~1) as an unborn branch selector.
	if strings.HasPrefix(ref, "refs/") || strings.ContainsAny(ref, "^~@{}") {
		return false
	}
	return "refs/heads/"+ref == symbolicRef
}

func (h *GitHandler) collectGitRecentBranches(repoRoot string, limit int) ([]GitRecentBranchInfo, error) {
	if limit <= 0 {
		limit = 5
	}
	if limit > maxGitHistoryRecoveryLimit {
		return nil, fmt.Errorf("limit exceeds maximum of %d", maxGitHistoryRecoveryLimit)
	}

	// Keep the query bounded even for repositories with very large HEAD
	// reflogs. The ordering is newest first, matching GitHub Desktop.
	cmd := newGitCommand("log", "-g", "HEAD", "--no-abbrev-commit", "--date=iso", "-n", strconv.Itoa(maxGitHistoryRecoveryLimit), "--format=%gs%x00%gd", "--")
	cmd.Dir = repoRoot
	output, commandErr := cmd.CombinedOutput()
	if commandErr != nil {
		if isGitNoReflogError(repoRoot, commandErr, output, "HEAD", false) {
			return []GitRecentBranchInfo{}, nil
		}
		return nil, gitCommandError(commandErr, output)
	}

	localBranches := collectLocalBranchNames(repoRoot)
	// The current branch is the destination of the newest checkout reflog
	// entry. Desktop's recent-branch list is intended to surface branches the
	// user can return to, so omit that current destination and start with the
	// branch that was left most recently.
	currentBranch := ""
	currentCmd := newGitCommand("symbolic-ref", "--quiet", "--short", "HEAD")
	currentCmd.Dir = repoRoot
	if output, currentErr := currentCmd.Output(); currentErr == nil {
		currentBranch = normalizeRecentBranchName(string(output))
	}
	excluded := map[string]struct{}{}
	seen := map[string]struct{}{}
	result := make([]GitRecentBranchInfo, 0, limit)
	for _, line := range strings.Split(strings.TrimSpace(string(output)), "\n") {
		parts := strings.SplitN(line, "\x00", 2)
		if len(parts) != 2 {
			continue
		}
		message := strings.TrimSpace(parts[0])
		date := parseGitReflogDateSelector(strings.TrimSpace(parts[1]))
		match := gitCheckoutReflogPattern.FindStringSubmatch(message)
		if len(match) != 3 {
			if rename := gitRenameReflogPattern.FindStringSubmatch(message); len(rename) == 3 {
				excluded[normalizeRecentBranchName(rename[1])] = struct{}{}
				name := normalizeRecentBranchName(rename[2])
				if name != "" {
					if _, already := seen[name]; !already {
						seen[name] = struct{}{}
						if _, excludedName := excluded[name]; !excludedName {
							result = append(result, GitRecentBranchInfo{Name: name, LastCheckout: date, Exists: localBranches[name]})
						}
					}
				}
				if len(result) >= limit {
					break
				}
			}
			continue
		}
		name := normalizeRecentBranchName(match[2])
		if name == "" || name == "HEAD" || name == "(no branch)" {
			continue
		}
		if currentBranch != "" && name == currentBranch {
			continue
		}
		if _, already := seen[name]; already {
			continue
		}
		if _, excludedName := excluded[name]; excludedName {
			continue
		}
		seen[name] = struct{}{}
		result = append(result, GitRecentBranchInfo{Name: name, LastCheckout: date, Exists: localBranches[name]})
		if len(result) >= limit {
			break
		}
	}

	// Deleted branches remain useful in the reflog endpoint, but the branch
	// picker can only select existing local refs. Preserve the richer details
	// while making the compatibility list match Desktop's filtering behavior.
	return result, nil
}

func collectLocalBranchNames(repoRoot string) map[string]bool {
	cmd := newGitCommand("for-each-ref", "--format=%(refname:strip=2)", "refs/heads")
	cmd.Dir = repoRoot
	output, err := cmd.Output()
	if err != nil {
		return map[string]bool{}
	}
	branches := map[string]bool{}
	for _, line := range strings.Split(strings.TrimSpace(string(output)), "\n") {
		if name := strings.TrimSpace(line); name != "" {
			branches[name] = true
		}
	}
	return branches
}

func normalizeRecentBranchName(name string) string {
	name = strings.TrimSpace(name)
	name = strings.TrimPrefix(name, "refs/heads/")
	name = strings.TrimPrefix(name, "heads/")
	if strings.HasPrefix(name, "refs/remotes/") || strings.HasPrefix(name, "remotes/") {
		return ""
	}
	return name
}

func (h *GitHandler) collectGitUnreachableCommits(repoRoot string, limit, skip int) (GitUnreachableCommitsResponse, error) {
	limit, skip, err := normalizeGitHistoryRecoveryPagination(limit, skip)
	if err != nil {
		return GitUnreachableCommitsResponse{}, err
	}

	cmd := newGitCommand("fsck", "--full", "--no-reflogs", "--unreachable", "--no-progress")
	cmd.Dir = repoRoot
	output, commandErr := cmd.CombinedOutput()
	// fsck exits non-zero when it finds dangling objects. Its output is still
	// the result we need, so only fail when no parseable object was emitted.
	if commandErr != nil && len(output) == 0 {
		return GitUnreachableCommitsResponse{}, gitCommandError(commandErr, output)
	}

	allHashes := make([]string, 0)
	seen := map[string]struct{}{}
	for _, line := range strings.Split(string(output), "\n") {
		fields := strings.Fields(line)
		if len(fields) != 3 || fields[0] != "unreachable" || fields[1] != "commit" || !isGitObjectID(fields[2]) {
			continue
		}
		if _, exists := seen[fields[2]]; exists {
			continue
		}
		seen[fields[2]] = struct{}{}
		allHashes = append(allHashes, fields[2])
	}

	// Sort by commit date, then hash, so repeated requests are stable even
	// though fsck itself does not promise object ordering.
	type datedHash struct {
		hash string
		date string
	}
	dated := make([]datedHash, 0, len(allHashes))
	for _, hash := range allHashes {
		info, infoErr := collectCommitInfoByHash(repoRoot, hash)
		if infoErr != nil {
			continue
		}
		dated = append(dated, datedHash{hash: hash, date: info.Date})
	}
	sort.SliceStable(dated, func(i, j int) bool {
		if dated[i].date == dated[j].date {
			return dated[i].hash > dated[j].hash
		}
		return dated[i].date > dated[j].date
	})

	total := len(dated)
	if skip >= total {
		return GitUnreachableCommitsResponse{Commits: []CommitInfo{}, Total: total, HasMore: false}, nil
	}
	end := skip + limit
	if end > total {
		end = total
	}
	commits := make([]CommitInfo, 0, end-skip)
	for _, item := range dated[skip:end] {
		info, infoErr := collectCommitInfoByHash(repoRoot, item.hash)
		if infoErr == nil {
			commits = append(commits, info)
		}
	}
	return GitUnreachableCommitsResponse{
		Commits: commits,
		Total:   total,
		HasMore: end < total,
	}, nil
}

func collectCommitInfoByHash(repoRoot, hash string) (CommitInfo, error) {
	if !isGitObjectID(hash) {
		return CommitInfo{}, errors.New("invalid commit hash")
	}
	format := "%H%x00%s%x00%an%x00%ae%x00%aI%x00%P%x00%D"
	cmd := newGitCommand("show", "-s", fmt.Sprintf("--format=%s", format), "--end-of-options", hash)
	cmd.Dir = repoRoot
	output, err := cmd.Output()
	if err != nil {
		return CommitInfo{}, gitCommandError(err, output)
	}
	line := strings.TrimSpace(string(output))
	parts := strings.SplitN(line, "\x00", 7)
	if len(parts) != 7 || !isGitObjectID(strings.TrimSpace(parts[0])) {
		return CommitInfo{}, errors.New("invalid commit metadata")
	}
	parentCount := 0
	if strings.TrimSpace(parts[5]) != "" {
		parentCount = len(strings.Fields(parts[5]))
	}
	return CommitInfo{
		Hash:        strings.TrimSpace(parts[0]),
		Message:     strings.TrimSpace(parts[1]),
		Author:      strings.TrimSpace(parts[2]),
		AuthorEmail: strings.TrimSpace(parts[3]),
		Date:        strings.TrimSpace(parts[4]),
		ParentCount: parentCount,
		Tags:        parseGitDecorationTags(parts[6]),
	}, nil
}

func (h *GitHandler) Reflog(c *gin.Context) {
	var req GitReflogRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	repoRoot, err := h.getRepoRoot(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	response, err := h.collectGitReflog(repoRoot, req)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, response)
}

func (h *GitHandler) RecentBranches(c *gin.Context) {
	var req GitRecentBranchesRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	repoRoot, err := h.getRepoRoot(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	branches, err := h.collectGitRecentBranches(repoRoot, req.Limit)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	names := make([]string, 0, len(branches))
	for _, branch := range branches {
		if branch.Exists {
			names = append(names, branch.Name)
		}
	}
	c.JSON(http.StatusOK, GitRecentBranchesResponse{Branches: branches, RecentBranches: names})
}

func (h *GitHandler) UnreachableCommits(c *gin.Context) {
	var req GitUnreachableCommitsRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	repoRoot, err := h.getRepoRoot(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	response, err := h.collectGitUnreachableCommits(repoRoot, req.Limit, req.Skip)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, response)
}
