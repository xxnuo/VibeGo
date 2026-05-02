package handler

import (
	"crypto/sha256"
	"encoding/hex"
	"sync"

	"github.com/xxnuo/vibego/internal/service/kv"
)

type fileSelectionState struct {
	PatchHash       string   `json:"patchHash"`
	IncludedState   string   `json:"includedState"`
	SelectedLineIDs []string `json:"selectedLineIDs"`
}

type gitScopeDraft struct {
	Summary     string                        `json:"summary"`
	Description string                        `json:"description"`
	IsAmend     bool                          `json:"isAmend"`
	NoVerify    bool                          `json:"noVerify"`
	SignOff     bool                          `json:"signOff"`
	AllowEmpty  bool                          `json:"allowEmpty"`
	Files       map[string]fileSelectionState `json:"files"`
}

type gitSelectionStore struct {
	mu    sync.Mutex
	store *kv.Store
	cache map[string]gitScopeDraft
}

func newGitSelectionStore(store *kv.Store) *gitSelectionStore {
	return &gitSelectionStore{
		store: store,
		cache: make(map[string]gitScopeDraft),
	}
}

func buildGitDraftScopeKey(workspaceSessionID, groupID, repoRoot string) string {
	if workspaceSessionID == "" && groupID == "" {
		return repoRoot
	}

	sum := sha256.Sum256([]byte(workspaceSessionID + "\n" + groupID + "\n" + repoRoot))
	return "git_draft:" + hex.EncodeToString(sum[:])
}

func cloneSelectionState(state fileSelectionState) fileSelectionState {
	cloned := state
	if state.SelectedLineIDs != nil {
		cloned.SelectedLineIDs = append([]string(nil), state.SelectedLineIDs...)
	}
	return cloned
}

func cloneDraft(draft gitScopeDraft) gitScopeDraft {
	cloned := gitScopeDraft{
		Summary:     draft.Summary,
		Description: draft.Description,
		IsAmend:     draft.IsAmend,
		NoVerify:    draft.NoVerify,
		SignOff:     draft.SignOff,
		AllowEmpty:  draft.AllowEmpty,
		Files:       make(map[string]fileSelectionState, len(draft.Files)),
	}
	for filePath, state := range draft.Files {
		cloned.Files[filePath] = cloneSelectionState(state)
	}
	return cloned
}

func normalizeDraft(draft gitScopeDraft) gitScopeDraft {
	if draft.Files == nil {
		draft.Files = make(map[string]fileSelectionState)
	}
	return draft
}

func isEmptyDraft(draft gitScopeDraft) bool {
	return draft.Summary == "" && draft.Description == "" && !draft.IsAmend && !draft.NoVerify && !draft.SignOff && !draft.AllowEmpty && len(draft.Files) == 0
}

func (s *gitSelectionStore) load(scopeKey string) (gitScopeDraft, bool, error) {
	if scopeKey == "" {
		return normalizeDraft(gitScopeDraft{}), false, nil
	}

	if s.store == nil {
		draft, ok := s.cache[scopeKey]
		if !ok {
			return normalizeDraft(gitScopeDraft{}), false, nil
		}
		return normalizeDraft(cloneDraft(draft)), true, nil
	}

	var draft gitScopeDraft
	if err := s.store.GetJSON(scopeKey, &draft); err != nil {
		return normalizeDraft(gitScopeDraft{}), false, nil
	}
	return normalizeDraft(draft), true, nil
}

func (s *gitSelectionStore) save(scopeKey string, draft gitScopeDraft) error {
	if scopeKey == "" {
		return nil
	}

	draft = normalizeDraft(draft)
	if s.store == nil {
		if isEmptyDraft(draft) {
			delete(s.cache, scopeKey)
			return nil
		}
		s.cache[scopeKey] = cloneDraft(draft)
		return nil
	}

	if isEmptyDraft(draft) {
		return s.store.Delete(scopeKey)
	}

	return s.store.SetJSON(scopeKey, draft)
}

func (s *gitSelectionStore) get(scopeKey, filePath string) (fileSelectionState, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	draft, ok, err := s.load(scopeKey)
	if err != nil || !ok {
		return fileSelectionState{}, false
	}

	state, ok := draft.Files[filePath]
	if !ok {
		return fileSelectionState{}, false
	}

	return cloneSelectionState(state), true
}

func (s *gitSelectionStore) set(scopeKey, filePath string, state fileSelectionState) {
	s.mu.Lock()
	defer s.mu.Unlock()

	draft, _, _ := s.load(scopeKey)
	draft.Files[filePath] = cloneSelectionState(state)
	_ = s.save(scopeKey, draft)
}

func (s *gitSelectionStore) delete(scopeKey, filePath string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	draft, _, _ := s.load(scopeKey)
	delete(draft.Files, filePath)
	_ = s.save(scopeKey, draft)
}

func (s *gitSelectionStore) resetRepo(scopeKey string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if scopeKey == "" {
		return
	}

	_ = s.save(scopeKey, gitScopeDraft{})
}

// resetAfterCommit clears the one-shot commit draft fields while preserving
// persistent commit preferences such as no-verify and sign-off.
func (s *gitSelectionStore) resetAfterCommit(scopeKey string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if scopeKey == "" {
		return
	}

	draft, ok, _ := s.load(scopeKey)
	if !ok {
		return
	}
	draft.Summary = ""
	draft.Description = ""
	draft.IsAmend = false
	draft.AllowEmpty = false
	draft.Files = make(map[string]fileSelectionState)
	_ = s.save(scopeKey, draft)
}

func (s *gitSelectionStore) pruneRepo(scopeKey string, validPaths map[string]struct{}) {
	s.mu.Lock()
	defer s.mu.Unlock()

	draft, ok, _ := s.load(scopeKey)
	if !ok {
		return
	}

	for path := range draft.Files {
		if _, ok := validPaths[path]; !ok {
			delete(draft.Files, path)
		}
	}

	_ = s.save(scopeKey, draft)
}

func (s *gitSelectionStore) getDraftFields(scopeKey string) (gitScopeDraft, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	draft, ok, err := s.load(scopeKey)
	if err != nil || !ok {
		return normalizeDraft(gitScopeDraft{}), false
	}

	return cloneDraft(draft), true
}

func (s *gitSelectionStore) setDraftFields(scopeKey string, summary, description *string, isAmend, noVerify, signOff, allowEmpty *bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	draft, _, _ := s.load(scopeKey)
	if summary != nil {
		draft.Summary = *summary
	}
	if description != nil {
		draft.Description = *description
	}
	if isAmend != nil {
		draft.IsAmend = *isAmend
	}
	if noVerify != nil {
		draft.NoVerify = *noVerify
	}
	if signOff != nil {
		draft.SignOff = *signOff
	}
	if allowEmpty != nil {
		draft.AllowEmpty = *allowEmpty
	}

	_ = s.save(scopeKey, draft)
}
