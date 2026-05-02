package handler

import "github.com/gin-gonic/gin"

func (h *GitHandler) broadcastStatus(path string) {
	if h == nil || h.wsHandler == nil || path == "" {
		return
	}

	repoRoot, err := h.getRepoRoot(path)
	if err != nil {
		return
	}

	h.wsHandler.BroadcastStatusByPath(path, func(workspaceSessionID string, groupID string) GitWSEvent {
		scopeKey := buildGitScopeKey(workspaceSessionID, groupID, repoRoot)
		files, summary := h.collectStructuredStatusWithScope(repoRoot, scopeKey)
		return GitWSEvent{
			Type: "status_changed",
			Data: GitWSStatusPayload{
				Files:   files,
				Summary: summary,
			},
		}
	})
}

func (h *GitHandler) broadcastStatusScoped(path string, workspaceSessionID string, groupID string) {
	if h == nil || h.wsHandler == nil || path == "" {
		return
	}

	repoRoot, err := h.getRepoRoot(path)
	if err != nil {
		return
	}

	scopeKey := buildGitScopeKey(workspaceSessionID, groupID, repoRoot)
	files, summary := h.collectStructuredStatusWithScope(repoRoot, scopeKey)
	h.wsHandler.BroadcastScoped(path, workspaceSessionID, groupID, GitWSEvent{
		Type: "status_changed",
		Data: GitWSStatusPayload{
			Files:   files,
			Summary: summary,
		},
	})
}

func (h *GitHandler) broadcastBranchStatus(path string) {
	if h == nil || h.wsHandler == nil || path == "" {
		return
	}

	repoRoot, err := h.getRepoRoot(path)
	if err != nil {
		return
	}

	h.wsHandler.Broadcast(path, GitWSEvent{
		Type: "branch_status_changed",
		Data: collectBranchStatus(repoRoot),
	})
}

func (h *GitHandler) broadcastDraftScoped(path string, workspaceSessionID string, groupID string) {
	if h == nil || h.wsHandler == nil || path == "" {
		return
	}

	repoRoot, err := h.getRepoRoot(path)
	if err != nil {
		return
	}

	draft, _ := h.selectionStore.getDraftFields(buildGitScopeKey(workspaceSessionID, groupID, repoRoot))
	h.wsHandler.BroadcastScoped(path, workspaceSessionID, groupID, GitWSEvent{
		Type: "draft_changed",
		Data: GitDraftResponse{
			Summary:          draft.Summary,
			Description:      draft.Description,
			IsAmend:          draft.IsAmend,
			NoVerify:         draft.NoVerify,
			SignOff:          draft.SignOff,
			AllowEmpty:       draft.AllowEmpty,
			SkipCommitHooks:  draft.NoVerify,
			SignOffCommits:   draft.SignOff,
			AllowEmptyCommit: draft.AllowEmpty,
		},
	})
}

func (h *GitHandler) broadcastRepoSyncNeeded(path string, syncData gin.H) {
	if h == nil || h.wsHandler == nil || path == "" || len(syncData) == 0 {
		return
	}

	repoRoot, err := h.getRepoRoot(path)
	if err != nil {
		return
	}

	if syncData["status"] == true {
		h.broadcastStatus(path)
	}
	if syncData["history"] == true {
		h.wsHandler.Broadcast(path, GitWSEvent{
			Type: "history_changed",
			Data: gin.H{"headHash": collectHeadHash(repoRoot)},
		})
	}
	if syncData["branches"] == true {
		h.wsHandler.Broadcast(path, GitWSEvent{
			Type: "branches_changed",
			Data: collectBranchesSnapshot(repoRoot),
		})
	}
	if syncData["remotes"] == true {
		h.wsHandler.Broadcast(path, GitWSEvent{
			Type: "remotes_changed",
			Data: gin.H{"remotes": collectRemoteInfos(repoRoot)},
		})
	}
	if syncData["stashes"] == true {
		h.wsHandler.Broadcast(path, GitWSEvent{
			Type: "stashes_changed",
			Data: gin.H{"stashes": collectStashEntries(repoRoot)},
		})
	}
	if syncData["conflicts"] == true {
		h.wsHandler.Broadcast(path, GitWSEvent{
			Type: "conflicts_changed",
			Data: gin.H{"conflicts": collectConflictFiles(repoRoot)},
		})
	}
}

func (h *GitHandler) broadcastRepoSyncNeededScoped(path string, workspaceSessionID string, groupID string, syncData gin.H) {
	if h == nil || h.wsHandler == nil || path == "" || len(syncData) == 0 {
		return
	}

	if syncData["status"] == true {
		h.broadcastStatusScoped(path, workspaceSessionID, groupID)
	}
	if syncData["draft"] == true {
		h.broadcastDraftScoped(path, workspaceSessionID, groupID)
	}
	if syncData["history"] == true || syncData["branches"] == true || syncData["remotes"] == true || syncData["stashes"] == true || syncData["conflicts"] == true {
		h.broadcastRepoSyncNeeded(path, syncData)
	}
}
