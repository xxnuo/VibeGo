package handler

import (
	"bytes"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/go-git/go-git/v6"
	"github.com/go-git/go-git/v6/plumbing"
	"github.com/go-git/go-git/v6/plumbing/object"
)

type GitHandler struct{}

func NewGitHandler() *GitHandler {
	return &GitHandler{}
}

func (h *GitHandler) Register(r *gin.RouterGroup) {
	g := r.Group("/git")
	g.POST("/init", h.Init)
	g.POST("/clone", h.Clone)
	g.POST("/status", h.Status)
	g.POST("/log", h.Log)
	g.POST("/diff", h.Diff)
	g.POST("/show", h.Show)
	g.POST("/add", h.Add)
	g.POST("/reset", h.Reset)
	g.POST("/checkout", h.Checkout)
	g.POST("/commit", h.Commit)
	g.POST("/undo", h.UndoCommit)
}

func (h *GitHandler) openRepo(path string) (*git.Repository, error) {
	return git.PlainOpenWithOptions(path, &git.PlainOpenOptions{DetectDotGit: true})
}

type GitInitRequest struct {
	Path string `json:"path" binding:"required"`
}

// Init godoc
// @Summary Initialize git repository
// @Description Initialize a new git repository
// @Tags Git
// @Accept json
// @Produce json
// @Param request body GitInitRequest true "Init request"
// @Success 200 {object} map[string]bool
// @Failure 400 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/git/init [post]
func (h *GitHandler) Init(c *gin.Context) {
	var req GitInitRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	_, err := git.PlainInit(req.Path, false)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"ok": true})
}

type GitCloneRequest struct {
	URL  string `json:"url" binding:"required"`
	Path string `json:"path" binding:"required"`
}

// Clone godoc
// @Summary Clone git repository
// @Description Clone a git repository from URL
// @Tags Git
// @Accept json
// @Produce json
// @Param request body GitCloneRequest true "Clone request"
// @Success 200 {object} map[string]bool
// @Failure 400 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/git/clone [post]
func (h *GitHandler) Clone(c *gin.Context) {
	var req GitCloneRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	_, err := git.PlainClone(req.Path, &git.CloneOptions{
		URL:      req.URL,
		Progress: os.Stdout,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"ok": true})
}

type GitPathRequest struct {
	Path string `json:"path" binding:"required"`
}

type FileStatus struct {
	Path   string `json:"path"`
	Status string `json:"status"`
	Staged bool   `json:"staged"`
}

// Status godoc
// @Summary Get git status
// @Description Get the status of files in the repository
// @Tags Git
// @Accept json
// @Produce json
// @Param request body GitPathRequest true "Path request"
// @Success 200 {object} map[string]interface{}
// @Failure 400 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/git/status [post]
func (h *GitHandler) Status(c *gin.Context) {
	var req GitPathRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	repo, err := h.openRepo(req.Path)
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
		if s.Staging != git.Unmodified {
			fileStatuses = append(fileStatuses, FileStatus{
				Path:   path,
				Status: string(s.Staging),
				Staged: true,
			})
		}
		if s.Worktree != git.Unmodified {
			fileStatuses = append(fileStatuses, FileStatus{
				Path:   path,
				Status: string(s.Worktree),
				Staged: false,
			})
		}
	}

	sort.Slice(fileStatuses, func(i, j int) bool {
		return fileStatuses[i].Path < fileStatuses[j].Path
	})

	c.JSON(http.StatusOK, gin.H{"files": fileStatuses})
}

type GitLogRequest struct {
	Path  string `json:"path" binding:"required"`
	Limit int    `json:"limit"`
}

type CommitInfo struct {
	Hash    string `json:"hash"`
	Message string `json:"message"`
	Author  string `json:"author"`
	Date    string `json:"date"`
}

// Log godoc
// @Summary Get git log
// @Description Get commit history
// @Tags Git
// @Accept json
// @Produce json
// @Param request body GitLogRequest true "Log request"
// @Success 200 {object} map[string]interface{}
// @Failure 400 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/git/log [post]
func (h *GitHandler) Log(c *gin.Context) {
	var req GitLogRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	repo, err := h.openRepo(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	ref, err := repo.Head()
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"commits": []CommitInfo{}})
		return
	}

	cIter, err := repo.Log(&git.LogOptions{From: ref.Hash()})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	var commits []CommitInfo
	limit := req.Limit
	if limit <= 0 {
		limit = 20
	}
	count := 0

	err = cIter.ForEach(func(commit *object.Commit) error {
		if count >= limit {
			return io.EOF
		}
		commits = append(commits, CommitInfo{
			Hash:    commit.Hash.String(),
			Message: commit.Message,
			Author:  commit.Author.Name,
			Date:    commit.Author.When.Format(time.RFC3339),
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

type GitDiffRequest struct {
	Path     string `json:"path" binding:"required"`
	FilePath string `json:"filePath" binding:"required"`
}

// Diff godoc
// @Summary Get file diff
// @Description Get diff between working tree and HEAD for a file
// @Tags Git
// @Accept json
// @Produce json
// @Param request body GitDiffRequest true "Diff request"
// @Success 200 {object} map[string]interface{}
// @Failure 400 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/git/diff [post]
func (h *GitHandler) Diff(c *gin.Context) {
	var req GitDiffRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	repo, err := h.openRepo(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	var oldContent string
	headRef, err := repo.Head()
	if err == nil {
		headCommit, err := repo.CommitObject(headRef.Hash())
		if err == nil {
			tree, err := headCommit.Tree()
			if err == nil {
				file, err := tree.File(req.FilePath)
				if err == nil {
					r, err := file.Reader()
					if err == nil {
						buf := new(bytes.Buffer)
						buf.ReadFrom(r)
						oldContent = buf.String()
						r.Close()
					}
				}
			}
		}
	}

	w, err := repo.Worktree()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	absPath := filepath.Join(w.Filesystem.Root(), req.FilePath)
	newContentBytes, err := os.ReadFile(absPath)
	if err != nil {
		newContentBytes = []byte{}
	}

	c.JSON(http.StatusOK, gin.H{
		"path": req.FilePath,
		"old":  oldContent,
		"new":  string(newContentBytes),
	})
}

type GitShowRequest struct {
	Path     string `json:"path" binding:"required"`
	FilePath string `json:"filePath" binding:"required"`
	Ref      string `json:"ref"`
}

// Show godoc
// @Summary Show file at ref
// @Description Get file content at a specific ref
// @Tags Git
// @Accept json
// @Produce json
// @Param request body GitShowRequest true "Show request"
// @Success 200 {object} map[string]string
// @Failure 400 {object} map[string]string
// @Failure 404 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/git/show [post]
func (h *GitHandler) Show(c *gin.Context) {
	var req GitShowRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	if req.Ref == "" {
		req.Ref = "HEAD"
	}

	repo, err := h.openRepo(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	hash, err := repo.ResolveRevision(plumbing.Revision(req.Ref))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid ref: " + err.Error()})
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

	file, err := tree.File(req.FilePath)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "file not found"})
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

type GitFilesRequest struct {
	Path  string   `json:"path" binding:"required"`
	Files []string `json:"files" binding:"required"`
}

// Add godoc
// @Summary Stage files
// @Description Add files to git staging area
// @Tags Git
// @Accept json
// @Produce json
// @Param request body GitFilesRequest true "Add request"
// @Success 200 {object} map[string]bool
// @Failure 400 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/git/add [post]
func (h *GitHandler) Add(c *gin.Context) {
	var req GitFilesRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	repo, err := h.openRepo(req.Path)
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
		if _, err := w.Add(file); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to add " + file + ": " + err.Error()})
			return
		}
	}

	c.JSON(http.StatusOK, gin.H{"ok": true})
}

type GitResetRequest struct {
	Path  string   `json:"path" binding:"required"`
	Files []string `json:"files"`
}

// Reset godoc
// @Summary Unstage files
// @Description Reset files from staging area
// @Tags Git
// @Accept json
// @Produce json
// @Param request body GitResetRequest true "Reset request"
// @Success 200 {object} map[string]bool
// @Failure 400 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/git/reset [post]
func (h *GitHandler) Reset(c *gin.Context) {
	var req GitResetRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	repo, err := h.openRepo(req.Path)
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
			c.JSON(http.StatusInternalServerError, gin.H{"error": "cannot reset without HEAD"})
			return
		}
		if err := w.Reset(&git.ResetOptions{Commit: head.Hash(), Mode: git.MixedReset}); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
	} else {
		for _, file := range req.Files {
			if _, err := w.Remove(file); err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to unstage " + file + ": " + err.Error()})
				return
			}
		}
	}

	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// Checkout godoc
// @Summary Checkout files
// @Description Discard changes in working directory
// @Tags Git
// @Accept json
// @Produce json
// @Param request body GitFilesRequest true "Checkout request"
// @Success 200 {object} map[string]bool
// @Failure 400 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/git/checkout [post]
func (h *GitHandler) Checkout(c *gin.Context) {
	var req GitFilesRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	repo, err := h.openRepo(req.Path)
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
			c.JSON(http.StatusInternalServerError, gin.H{"error": "blob not found: " + err.Error()})
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
			c.JSON(http.StatusInternalServerError, gin.H{"error": "read error: " + err.Error()})
			return
		}

		absP := filepath.Join(baseDir, p)
		if err := os.WriteFile(absP, content, 0644); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "write error: " + err.Error()})
			return
		}
	}

	c.JSON(http.StatusOK, gin.H{"ok": true})
}

type GitCommitRequest struct {
	Path    string `json:"path" binding:"required"`
	Message string `json:"message" binding:"required"`
	Author  string `json:"author"`
	Email   string `json:"email"`
}

// Commit godoc
// @Summary Create commit
// @Description Commit staged changes
// @Tags Git
// @Accept json
// @Produce json
// @Param request body GitCommitRequest true "Commit request"
// @Success 200 {object} map[string]interface{}
// @Failure 400 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/git/commit [post]
func (h *GitHandler) Commit(c *gin.Context) {
	var req GitCommitRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	repo, err := h.openRepo(req.Path)
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
		author = "VibeGo User"
	}
	email := req.Email
	if email == "" {
		email = "user@vibego.local"
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

// UndoCommit godoc
// @Summary Undo last commit
// @Description Soft reset to parent commit
// @Tags Git
// @Accept json
// @Produce json
// @Param request body GitPathRequest true "Path request"
// @Success 200 {object} map[string]bool
// @Failure 400 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/git/undo [post]
func (h *GitHandler) UndoCommit(c *gin.Context) {
	var req GitPathRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	repo, err := h.openRepo(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	w, err := repo.Worktree()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	head, err := repo.Head()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "cannot find HEAD"})
		return
	}

	commit, err := repo.CommitObject(head.Hash())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	if commit.NumParents() == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "initial commit cannot be undone"})
		return
	}

	parent, err := commit.Parent(0)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	if err := w.Reset(&git.ResetOptions{
		Commit: parent.Hash,
		Mode:   git.SoftReset,
	}); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"ok": true})
}
