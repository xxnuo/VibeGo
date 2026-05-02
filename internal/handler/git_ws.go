package handler

import (
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"github.com/rs/zerolog/log"
)

type GitWSEvent struct {
	Type string      `json:"type"`
	Data interface{} `json:"data"`
}

type GitWSStatusPayload struct {
	Files   []StructuredFile `json:"files"`
	Summary StatusSummary    `json:"summary"`
}

type GitWSSnapshot struct {
	Status       GitWSStatusPayload `json:"status"`
	BranchStatus BranchStatusInfo   `json:"branchStatus"`
	Branches     BranchesSnapshot   `json:"branches"`
	Remotes      []RemoteInfo       `json:"remotes"`
	Stashes      []StashEntry       `json:"stashes"`
	Conflicts    []string           `json:"conflicts"`
	Draft        GitDraftResponse   `json:"draft"`
	HeadHash     string             `json:"headHash"`
}

type gitWSClient struct {
	conn               *websocket.Conn
	path               string
	repoRoot           string
	workspaceSessionID string
	groupID            string
	done               chan struct{}
	closeOnce          sync.Once
	mu                 sync.Mutex
}

type gitRepoWatcher struct {
	repoRoot          string
	stop              chan struct{}
	done              chan struct{}
	startOnce         sync.Once
	mu                sync.RWMutex
	clients           map[*gitWSClient]struct{}
	statusFingerprint string
	branchStatusJSON  string
	branchesJSON      string
	remotesJSON       string
	stashesJSON       string
	conflictsJSON     string
	headHash          string
}

type GitWSHandler struct {
	upgrader   websocket.Upgrader
	gitHandler *GitHandler
	mu         sync.RWMutex
	repos      map[string]*gitRepoWatcher
}

func NewGitWSHandler(gitHandler *GitHandler) *GitWSHandler {
	return &GitWSHandler{
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool { return true },
		},
		gitHandler: gitHandler,
		repos:      make(map[string]*gitRepoWatcher),
	}
}

func (h *GitWSHandler) Register(r *gin.RouterGroup) {
	r.GET("/git/ws", h.HandleWS)
}

func (h *GitWSHandler) HandleWS(c *gin.Context) {
	path := c.Query("path")
	if path == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "path is required"})
		return
	}

	repoRoot, err := h.gitHandler.getRepoRoot(path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	conn, err := h.upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		log.Error().Err(err).Msg("git ws upgrade failed")
		return
	}

	client := &gitWSClient{
		conn:               conn,
		path:               path,
		repoRoot:           repoRoot,
		workspaceSessionID: c.Query("workspace_session_id"),
		groupID:            c.Query("group_id"),
		done:               make(chan struct{}),
	}

	watcher := h.attachClient(client)
	if err := h.sendSnapshot(client); err != nil {
		h.detachClient(client)
		client.conn.Close()
		return
	}

	go h.readPump(client)
	go h.pingLoop(client)
	watcher.startOnce.Do(func() {
		go h.watchRepo(watcher)
	})

	<-client.done
	h.detachClient(client)
}

func (h *GitWSHandler) readPump(client *gitWSClient) {
	defer func() {
		h.closeClient(client)
		client.conn.Close()
	}()

	client.conn.SetReadDeadline(time.Now().Add(120 * time.Second))
	client.conn.SetPongHandler(func(string) error {
		client.conn.SetReadDeadline(time.Now().Add(120 * time.Second))
		return nil
	})

	for {
		if _, _, err := client.conn.ReadMessage(); err != nil {
			return
		}
	}
}

func (h *GitWSHandler) pingLoop(client *gitWSClient) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-client.done:
			return
		case <-ticker.C:
			client.mu.Lock()
			err := client.conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(5*time.Second))
			client.mu.Unlock()
			if err != nil {
				h.closeClient(client)
				return
			}
		}
	}
}

func (h *GitWSHandler) closeClient(client *gitWSClient) {
	client.closeOnce.Do(func() {
		close(client.done)
	})
}

func (h *GitWSHandler) attachClient(client *gitWSClient) *gitRepoWatcher {
	h.mu.Lock()
	defer h.mu.Unlock()

	watcher, ok := h.repos[client.repoRoot]
	if !ok {
		watcher = &gitRepoWatcher{
			repoRoot: client.repoRoot,
			stop:     make(chan struct{}),
			done:     make(chan struct{}),
			clients:  make(map[*gitWSClient]struct{}),
		}
		watcher.refreshState()
		h.repos[client.repoRoot] = watcher
	}

	watcher.mu.Lock()
	watcher.clients[client] = struct{}{}
	watcher.mu.Unlock()

	return watcher
}

func (h *GitWSHandler) detachClient(client *gitWSClient) {
	h.mu.Lock()
	watcher, ok := h.repos[client.repoRoot]
	if !ok {
		h.mu.Unlock()
		return
	}

	watcher.mu.Lock()
	delete(watcher.clients, client)
	empty := len(watcher.clients) == 0
	watcher.mu.Unlock()

	if empty {
		delete(h.repos, client.repoRoot)
		close(watcher.stop)
	}
	h.mu.Unlock()
}

func (h *GitWSHandler) watchRepo(watcher *gitRepoWatcher) {
	select {
	case <-watcher.done:
		return
	default:
	}

	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-watcher.stop:
			close(watcher.done)
			return
		case <-ticker.C:
			h.pollRepoChanges(watcher)
		}
	}
}

func (h *GitWSHandler) pollRepoChanges(watcher *gitRepoWatcher) {
	repoRoot := watcher.repoRoot

	nextStatusFingerprint := collectStatusFingerprint(repoRoot)
	if nextStatusFingerprint != watcher.statusFingerprint {
		watcher.statusFingerprint = nextStatusFingerprint
		h.broadcastStatusByRepoRoot(repoRoot, func(workspaceSessionID string, groupID string) GitWSEvent {
			files, summary := h.gitHandler.collectStructuredStatusWithScope(repoRoot, buildGitScopeKey(workspaceSessionID, groupID, repoRoot))
			return GitWSEvent{
				Type: "status_changed",
				Data: GitWSStatusPayload{Files: files, Summary: summary},
			}
		})
	}

	branchStatus := collectBranchStatus(repoRoot)
	branchStatusJSON := marshalGitWSData(branchStatus)
	if branchStatusJSON != watcher.branchStatusJSON {
		watcher.branchStatusJSON = branchStatusJSON
		h.broadcastRepoRoot(repoRoot, GitWSEvent{Type: "branch_status_changed", Data: branchStatus})
	}

	branches := collectBranchesSnapshot(repoRoot)
	branchesJSON := marshalGitWSData(branches)
	if branchesJSON != watcher.branchesJSON {
		watcher.branchesJSON = branchesJSON
		h.broadcastRepoRoot(repoRoot, GitWSEvent{Type: "branches_changed", Data: branches})
	}

	remotes := collectRemoteInfos(repoRoot)
	remotesPayload := gin.H{"remotes": remotes}
	remotesJSON := marshalGitWSData(remotesPayload)
	if remotesJSON != watcher.remotesJSON {
		watcher.remotesJSON = remotesJSON
		h.broadcastRepoRoot(repoRoot, GitWSEvent{Type: "remotes_changed", Data: remotesPayload})
	}

	stashes := collectStashEntries(repoRoot)
	stashesPayload := gin.H{"stashes": stashes}
	stashesJSON := marshalGitWSData(stashesPayload)
	if stashesJSON != watcher.stashesJSON {
		watcher.stashesJSON = stashesJSON
		h.broadcastRepoRoot(repoRoot, GitWSEvent{Type: "stashes_changed", Data: stashesPayload})
	}

	conflicts := collectConflictFiles(repoRoot)
	conflictsPayload := gin.H{"conflicts": conflicts}
	conflictsJSON := marshalGitWSData(conflictsPayload)
	if conflictsJSON != watcher.conflictsJSON {
		watcher.conflictsJSON = conflictsJSON
		h.broadcastRepoRoot(repoRoot, GitWSEvent{Type: "conflicts_changed", Data: conflictsPayload})
	}

	headHash := collectHeadHash(repoRoot)
	if headHash != watcher.headHash {
		watcher.headHash = headHash
		h.broadcastRepoRoot(repoRoot, GitWSEvent{Type: "history_changed", Data: gin.H{"headHash": headHash}})
	}
}

func (watcher *gitRepoWatcher) refreshState() {
	watcher.statusFingerprint = collectStatusFingerprint(watcher.repoRoot)
	watcher.branchStatusJSON = marshalGitWSData(collectBranchStatus(watcher.repoRoot))
	watcher.branchesJSON = marshalGitWSData(collectBranchesSnapshot(watcher.repoRoot))
	watcher.remotesJSON = marshalGitWSData(gin.H{"remotes": collectRemoteInfos(watcher.repoRoot)})
	watcher.stashesJSON = marshalGitWSData(gin.H{"stashes": collectStashEntries(watcher.repoRoot)})
	watcher.conflictsJSON = marshalGitWSData(gin.H{"conflicts": collectConflictFiles(watcher.repoRoot)})
	watcher.headHash = collectHeadHash(watcher.repoRoot)
}

func marshalGitWSData(value interface{}) string {
	data, _ := json.Marshal(value)
	return string(data)
}

func (h *GitWSHandler) sendSnapshot(client *gitWSClient) error {
	files, summary := h.gitHandler.collectStructuredStatusWithScope(
		client.repoRoot,
		buildGitScopeKey(client.workspaceSessionID, client.groupID, client.repoRoot),
	)
	draft, _ := h.gitHandler.selectionStore.getDraftFields(buildGitScopeKey(client.workspaceSessionID, client.groupID, client.repoRoot))
	snapshot := GitWSSnapshot{
		Status: GitWSStatusPayload{
			Files:   files,
			Summary: summary,
		},
		Branches:     collectBranchesSnapshot(client.repoRoot),
		Remotes:      collectRemoteInfos(client.repoRoot),
		Stashes:      collectStashEntries(client.repoRoot),
		Conflicts:    collectConflictFiles(client.repoRoot),
		HeadHash:     collectHeadHash(client.repoRoot),
		BranchStatus: BranchStatusInfo{},
		Draft: GitDraftResponse{
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
	}
	if branchStatus := collectBranchStatus(client.repoRoot); branchStatus != nil {
		snapshot.BranchStatus = *branchStatus
	}
	return h.sendEvent(client, GitWSEvent{Type: "snapshot", Data: snapshot})
}

func (h *GitWSHandler) sendEvent(client *gitWSClient, event GitWSEvent) error {
	client.mu.Lock()
	defer client.mu.Unlock()
	client.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	if err := client.conn.WriteJSON(event); err != nil {
		log.Debug().Err(err).Msg("git ws send failed")
		return err
	}
	return nil
}

func (h *GitWSHandler) refreshRepoWatcher(repoRoot string) {
	h.mu.RLock()
	watcher := h.repos[repoRoot]
	h.mu.RUnlock()
	if watcher == nil {
		return
	}
	watcher.refreshState()
}

func (h *GitWSHandler) broadcastRepoRoot(repoRoot string, event GitWSEvent) {
	h.mu.RLock()
	watcher := h.repos[repoRoot]
	h.mu.RUnlock()
	if watcher == nil {
		return
	}

	clients := watcher.snapshotClients()
	for _, client := range clients {
		h.sendEvent(client, event)
	}
}

func (h *GitWSHandler) broadcastRepoRootScoped(repoRoot string, workspaceSessionID string, groupID string, event GitWSEvent) {
	h.mu.RLock()
	watcher := h.repos[repoRoot]
	h.mu.RUnlock()
	if watcher == nil {
		return
	}

	clients := watcher.snapshotClients()
	for _, client := range clients {
		if workspaceSessionID != "" && client.workspaceSessionID != workspaceSessionID {
			continue
		}
		if groupID != "" && client.groupID != groupID {
			continue
		}
		h.sendEvent(client, event)
	}
}

func (h *GitWSHandler) broadcastStatusByRepoRoot(repoRoot string, build func(workspaceSessionID string, groupID string) GitWSEvent) {
	h.mu.RLock()
	watcher := h.repos[repoRoot]
	h.mu.RUnlock()
	if watcher == nil {
		return
	}

	clients := watcher.snapshotClients()
	for _, client := range clients {
		h.sendEvent(client, build(client.workspaceSessionID, client.groupID))
	}
}

func (watcher *gitRepoWatcher) snapshotClients() []*gitWSClient {
	watcher.mu.RLock()
	defer watcher.mu.RUnlock()

	clients := make([]*gitWSClient, 0, len(watcher.clients))
	for client := range watcher.clients {
		clients = append(clients, client)
	}
	return clients
}

func (h *GitWSHandler) Broadcast(path string, event GitWSEvent) {
	repoRoot, err := h.gitHandler.getRepoRoot(path)
	if err != nil {
		return
	}
	h.broadcastRepoRoot(repoRoot, event)
	h.refreshRepoWatcher(repoRoot)
}

func (h *GitWSHandler) BroadcastScoped(path string, workspaceSessionID string, groupID string, event GitWSEvent) {
	repoRoot, err := h.gitHandler.getRepoRoot(path)
	if err != nil {
		return
	}
	h.broadcastRepoRootScoped(repoRoot, workspaceSessionID, groupID, event)
	h.refreshRepoWatcher(repoRoot)
}

func (h *GitWSHandler) BroadcastStatusByPath(path string, build func(workspaceSessionID string, groupID string) GitWSEvent) {
	repoRoot, err := h.gitHandler.getRepoRoot(path)
	if err != nil {
		return
	}
	h.broadcastStatusByRepoRoot(repoRoot, build)
	h.refreshRepoWatcher(repoRoot)
}
