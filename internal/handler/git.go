package handler

import (
	"bytes"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/go-git/go-git/v6"
	"github.com/go-git/go-git/v6/plumbing"
	"github.com/go-git/go-git/v6/plumbing/object"
	"github.com/google/uuid"
	"gorm.io/gorm"
)

type GitRepository struct {
	ID        string `gorm:"column:id;primaryKey" json:"id"`
	Path      string `gorm:"column:path" json:"path"`
	Remotes   string `gorm:"column:remotes;type:text" json:"remotes"`
	CreatedAt int64  `gorm:"column:created_at" json:"created_at"`
	UpdatedAt int64  `gorm:"column:updated_at" json:"updated_at"`
}

type GitHandler struct {
	db *gorm.DB
}

func NewGitHandler(db *gorm.DB) *GitHandler {
	return &GitHandler{db: db}
}

func (h *GitHandler) Register(r *gin.RouterGroup) {
	g := r.Group("/git")
	g.POST("/bind", h.Bind)
	g.DELETE("/:id", h.Unbind)
	g.GET("", h.List)
	g.POST("/init", h.New)
	g.POST("/clone", h.Clone)
	g.GET("/status", h.Status)
	g.GET("/log", h.Log)
	g.GET("/diff", h.Diff)
	g.GET("/show", h.Show)
	g.POST("/commit", h.Commit)
	g.POST("/add", h.Add)
	g.POST("/reset", h.Reset)
	g.POST("/checkout", h.Checkout)
	g.POST("/undo-commit", h.UndoCommit)
}

func (h *GitHandler) openRepo(id string) (*git.Repository, error) {
	if id == "" {
		return nil, os.ErrInvalid
	}
	var repoModel GitRepository
	if err := h.db.First(&repoModel, "id = ?", id).Error; err != nil {
		return nil, err
	}
	// Verify it's a git repo or inside one
	return git.PlainOpenWithOptions(repoModel.Path, &git.PlainOpenOptions{DetectDotGit: true})
}

// @Summary List bound repos
// @Tags Git
// @Produce json
// @Param page query int false "Page number (default 1)"
// @Param page_size query int false "Page size (default 20)"
// @Success 200 {object} map[string]interface{}
// @Router /api/git [get]
func (h *GitHandler) List(c *gin.Context) {
	page := 1
	pageSize := 20
	if p := c.Query("page"); p != "" {
		if n, err := strconv.Atoi(p); err == nil && n > 0 {
			page = n
		}
	}
	if ps := c.Query("page_size"); ps != "" {
		if n, err := strconv.Atoi(ps); err == nil && n > 0 && n <= 100 {
			pageSize = n
		}
	}

	var total int64
	h.db.Model(&GitRepository{}).Count(&total)

	var repos []GitRepository
	offset := (page - 1) * pageSize
	if err := h.db.Offset(offset).Limit(pageSize).Find(&repos).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"repos": repos, "page": page, "page_size": pageSize, "total": total})
}

type NewRepoRequest struct {
	Path string `json:"path" binding:"required"`
}

// @Summary Initialize new git repository
// @Tags Git
// @Accept json
// @Produce json
// @Param request body NewRepoRequest true "New repo request"
// @Success 200 {object} map[string]interface{}
// @Failure 500 {object} map[string]string
// @Router /api/git/new [post]
func (h *GitHandler) New(c *gin.Context) {
	var req NewRepoRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Init repo
	_, err := git.PlainInit(req.Path, false)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to init repo: " + err.Error()})
		return
	}

	// Bind
	now := time.Now().Unix()
	repo := GitRepository{
		ID:        uuid.New().String(),
		Path:      req.Path,
		CreatedAt: now,
		UpdatedAt: now,
	}

	if err := h.db.Create(&repo).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "id": repo.ID})
}

type CloneRepoRequest struct {
	URL  string `json:"url" binding:"required"`
	Path string `json:"path" binding:"required"`
}

// @Summary Clone git repository
// @Tags Git
// @Accept json
// @Produce json
// @Param request body CloneRepoRequest true "Clone repo request"
// @Success 200 {object} map[string]interface{}
// @Failure 500 {object} map[string]string
// @Router /api/git/clone [post]
func (h *GitHandler) Clone(c *gin.Context) {
	var req CloneRepoRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Clone repo
	_, err := git.PlainClone(req.Path, &git.CloneOptions{
		URL:      req.URL,
		Progress: os.Stdout,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to clone repo: " + err.Error()})
		return
	}

	// Bind
	now := time.Now().Unix()
	repo := GitRepository{
		ID:        uuid.New().String(),
		Path:      req.Path,
		Remotes:   req.URL, // Simple assumption: storing URL as Remotes for now
		CreatedAt: now,
		UpdatedAt: now,
	}

	if err := h.db.Create(&repo).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "id": repo.ID})
}

// @Summary Unbind repo
// @Tags Git
// @Produce json
// @Param id path string true "Repo ID"
// @Success 200 {object} map[string]bool
// @Failure 500 {object} map[string]string
// @Router /api/git/{id} [delete]
func (h *GitHandler) Unbind(c *gin.Context) {
	id := c.Param("id")
	if err := h.db.Delete(&GitRepository{}, "id = ?", id).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

type BindRepoRequest struct {
	Path    string `json:"path" binding:"required"`
	Remotes string `json:"remotes"`
}

// @Summary Bind git repository
// @Tags Git
// @Accept json
// @Produce json
// @Param request body BindRepoRequest true "Bind repo request"
// @Success 200 {object} map[string]interface{}
// @Failure 500 {object} map[string]string
// @Router /api/git/bind [post]
func (h *GitHandler) Bind(c *gin.Context) {
	var req BindRepoRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Verify path exists and is a git repo
	if _, err := git.PlainOpenWithOptions(req.Path, &git.PlainOpenOptions{DetectDotGit: true}); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid git repository: " + err.Error()})
		return
	}

	now := time.Now().Unix()
	repo := GitRepository{
		ID:        uuid.New().String(),
		Path:      req.Path,
		Remotes:   req.Remotes,
		CreatedAt: now,
		UpdatedAt: now,
	}

	if err := h.db.Create(&repo).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "id": repo.ID})
}

type FileStatus struct {
	Path   string `json:"path"`
	Status string `json:"status"` // "M", "A", "D", "?", etc.
	Staged bool   `json:"staged"`
}

// @Summary Get git status
// @Tags Git
// @Produce json
// @Param id query string true "Repo ID"
// @Success 200 {object} map[string]interface{}
// @Failure 400 {object} map[string]string
// @Router /api/git/status [get]
func (h *GitHandler) Status(c *gin.Context) {
	id := c.Query("id")
	repo, err := h.openRepo(id)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	w, err := repo.Worktree()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	status, err := w.Status()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	var fileStatuses []FileStatus
	for path, s := range status {
		// Staged status
		if s.Staging != git.Unmodified {
			code := string(s.Staging)
			fileStatuses = append(fileStatuses, FileStatus{
				Path:   path,
				Status: code,
				Staged: true,
			})
		}
		// Worktree status
		if s.Worktree != git.Unmodified {
			code := string(s.Worktree)
			fileStatuses = append(fileStatuses, FileStatus{
				Path:   path,
				Status: code,
				Staged: false,
			})
		}
	}

	// Sort by path
	sort.Slice(fileStatuses, func(i, j int) bool {
		return fileStatuses[i].Path < fileStatuses[j].Path
	})

	c.JSON(http.StatusOK, gin.H{"files": fileStatuses})
}

type CommitInfo struct {
	Hash    string `json:"hash"`
	Message string `json:"message"`
	Author  string `json:"author"`
	Date    string `json:"date"`
}

// @Summary Get git commit log
// @Tags Git
// @Produce json
// @Param id query string true "Repo ID"
// @Param limit query int false "Limit"
// @Success 200 {object} map[string]interface{}
// @Router /api/git/log [get]
func (h *GitHandler) Log(c *gin.Context) {
	id := c.Query("id")
	repo, err := h.openRepo(id)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Get HEAD ref
	ref, err := repo.Head()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "No HEAD found (empty repo?)"})
		return
	}

	cIter, err := repo.Log(&git.LogOptions{From: ref.Hash()})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	var commits []CommitInfo
	limit := 20 // Default limit
	if l := c.Query("limit"); l != "" {
		if n, err := strconv.Atoi(l); err == nil && n > 0 {
			limit = n
		}
	}
	count := 0

	err = cIter.ForEach(func(c *object.Commit) error {
		if count >= limit {
			return io.EOF
		}
		commits = append(commits, CommitInfo{
			Hash:    c.Hash.String(),
			Message: c.Message,
			Author:  c.Author.Name,
			Date:    c.Author.When.Format(time.RFC3339),
		})
		count++
		return nil
	})
	if err != nil && err != io.EOF {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"commits": commits})
}

// @Summary Get file diff
// @Tags Git
// @Produce json
// @Param id query string true "Repo ID"
// @Param path query string true "File path"
// @Success 200 {object} map[string]string
// @Router /api/git/diff [get]
func (h *GitHandler) Diff(c *gin.Context) {
	id := c.Query("id")
	path := c.Query("path")
	if path == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "path is required"})
		return
	}

	repo, err := h.openRepo(id)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	headRef, err := repo.Head()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "No HEAD"})
		return
	}
	headCommit, err := repo.CommitObject(headRef.Hash())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	tree, err := headCommit.Tree()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// Old content (HEAD)
	var oldContent string
	file, err := tree.File(path)
	if err == nil {
		r, err := file.Reader()
		if err == nil {
			buf := new(bytes.Buffer)
			buf.ReadFrom(r)
			oldContent = buf.String()
			r.Close()
		}
	}

	// New content (Worktree/Disk)
	// We read directly from disk for the "current" state
	w, err := repo.Worktree()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	absPath := filepath.Join(w.Filesystem.Root(), path)
	newContentBytes, err := os.ReadFile(absPath)
	if err != nil {
		// File might be deleted
		newContentBytes = []byte{}
	}
	newContent := string(newContentBytes)

	c.JSON(http.StatusOK, gin.H{
		"path": path,
		"old":  oldContent,
		"new":  newContent,
	})
}

// @Summary Show file content at specific ref
// @Tags Git
// @Produce json
// @Param id query string true "Repo ID"
// @Param path query string true "File path"
// @Param ref query string false "Ref (default: HEAD)"
// @Success 200 {object} map[string]string
// @Router /api/git/show [get]
func (h *GitHandler) Show(c *gin.Context) {
	id := c.Query("id")
	path := c.Query("path")
	if path == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "path is required"})
		return
	}
	refStr := c.Query("ref")
	if refStr == "" {
		refStr = "HEAD"
	}

	repo, err := h.openRepo(id)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Resolve ref
	hash, err := repo.ResolveRevision(plumbing.Revision(refStr))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid ref: " + err.Error()})
		return
	}

	commit, err := repo.CommitObject(*hash)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	tree, err := commit.Tree()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	file, err := tree.File(path)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "File not found in tree"})
		return
	}

	r, err := file.Reader()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer r.Close()

	buf := new(bytes.Buffer)
	buf.ReadFrom(r)

	c.JSON(http.StatusOK, gin.H{"content": buf.String()})
}

type GitActionRequest struct {
	ID      string   `json:"id" binding:"required"`
	Files   []string `json:"files"`
	Message string   `json:"message"`
	Author  string   `json:"author"`
	Email   string   `json:"email"`
}

// @Summary Stage files
// @Tags Git
// @Accept json
// @Produce json
// @Param request body GitActionRequest true "Files to add"
// @Router /api/git/add [post]
func (h *GitHandler) Add(c *gin.Context) {
	var req GitActionRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	repo, err := h.openRepo(req.ID)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	w, err := repo.Worktree()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	for _, file := range req.Files {
		_, err := w.Add(file)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to add " + file + ": " + err.Error()})
			return
		}
	}

	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// @Summary Unstage files (Reset)
// @Tags Git
// @Accept json
// @Produce json
// @Param request body GitActionRequest true "Files to reset (empty for all)"
// @Router /api/git/reset [post]
func (h *GitHandler) Reset(c *gin.Context) {
	var req GitActionRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	repo, err := h.openRepo(req.ID)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	w, err := repo.Worktree()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	if len(req.Files) == 0 {
		head, err := repo.Head()
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Cannot reset without HEAD"})
			return
		}
		err = w.Reset(&git.ResetOptions{Commit: head.Hash(), Mode: git.MixedReset})
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true, "message": "All changes unstaged"})
	} else {
		for _, file := range req.Files {
			if _, err := w.Remove(file); err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to unstage " + file + ": " + err.Error()})
				return
			}
		}
		c.JSON(http.StatusOK, gin.H{"ok": true, "message": "Files unstaged"})
	}
}

// @Summary Discard changes (Checkout file from index/HEAD)
// @Tags Git
// @Accept json
// @Produce json
// @Param request body GitActionRequest true "Files to restore"
// @Router /api/git/checkout [post]
func (h *GitHandler) Checkout(c *gin.Context) {
	var req GitActionRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	repo, err := h.openRepo(req.ID)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	idx, err := repo.Storer.Index()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	w, err := repo.Worktree()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	baseDir := w.Filesystem.Root()

	if len(req.Files) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "No files specified to discard"})
		return
	}

	for _, p := range req.Files {
		entry, err := idx.Entry(p)
		if err != nil {
			absP := filepath.Join(baseDir, p)
			if _, e := os.Stat(absP); e == nil {
				os.Remove(absP)
			}
			continue
		}

		blob, err := repo.BlobObject(entry.Hash)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Blob not found: " + err.Error()})
			return
		}

		content, err := func() ([]byte, error) {
			r, err := blob.Reader()
			if err != nil {
				return nil, err
			}
			defer r.Close()
			return io.ReadAll(r)
		}()
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Read error: " + err.Error()})
			return
		}

		absP := filepath.Join(baseDir, p)
		if err := os.WriteFile(absP, content, 0644); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Write error: " + err.Error()})
			return
		}
	}

	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// @Summary Commit staged changes
// @Tags Git
// @Accept json
// @Produce json
// @Param request body GitActionRequest true "Commit message and author"
// @Router /api/git/commit [post]
func (h *GitHandler) Commit(c *gin.Context) {
	var req GitActionRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	repo, err := h.openRepo(req.ID)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	w, err := repo.Worktree()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	author := req.Author
	if author == "" {
		author = "Code Vibe User"
	}
	email := req.Email
	if email == "" {
		email = "user@codevibe.local"
	}

	hash, err := w.Commit(req.Message, &git.CommitOptions{
		Author: &object.Signature{
			Name:  author,
			Email: email,
			When:  time.Now(),
		},
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"ok": true, "hash": hash.String()})
}

// @Summary Undo last commit (Soft reset to HEAD~1)
// @Tags Git
// @Accept json
// @Produce json
// @Param request body GitActionRequest true "Repo ID"
// @Router /api/git/undo-commit [post]
func (h *GitHandler) UndoCommit(c *gin.Context) {
	var req GitActionRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	repo, err := h.openRepo(req.ID)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	w, err := repo.Worktree()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// Resolve HEAD~1
	head, err := repo.Head()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Cannot find HEAD"})
		return
	}

	commit, err := repo.CommitObject(head.Hash())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	if commit.NumParents() == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Initial commit cannot be undone"})
		return
	}

	parent, err := commit.Parent(0)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// Soft reset to parent (keeps changes in index/stage)
	err = w.Reset(&git.ResetOptions{
		Commit: parent.Hash,
		Mode:   git.SoftReset,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"ok": true, "message": "Undid last commit (Soft Reset)"})
}