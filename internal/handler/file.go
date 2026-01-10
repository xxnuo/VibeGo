package handler

import (
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/gin-gonic/gin"
)

type FileHandler struct {
	baseDir string
}

func NewFileHandler() *FileHandler {
	return &FileHandler{}
}

func (h *FileHandler) SetBaseDir(dir string) {
	h.baseDir = dir
}

func (h *FileHandler) Register(r *gin.RouterGroup) {
	g := r.Group("/file")
	g.POST("/new", h.New)
	g.GET("/read", h.Read)
	g.POST("/write", h.Write)
	g.GET("/list", h.List)
	g.GET("/tree", h.Tree)
	g.GET("/search", h.Search)
	g.DELETE("/rm", h.Remove)
	g.POST("/rename", h.Rename)
	g.POST("/mkdir", h.Mkdir)
	g.GET("/abs", h.Abs)
}

func (h *FileHandler) resolvePath(p string) (string, error) {
	p = filepath.Clean(p)
	var absPath string
	var err error

	if h.baseDir != "" {
		if !filepath.IsAbs(p) {
			p = filepath.Join(h.baseDir, p)
		}
		absBase, err := filepath.Abs(h.baseDir)
		if err != nil {
			return "", err
		}
		absPath, err = filepath.Abs(p)
		if err != nil {
			return "", err
		}
		if !strings.HasPrefix(absPath, absBase) {
			return "", os.ErrPermission
		}
	} else {
		absPath, err = filepath.Abs(p)
		if err != nil {
			return "", err
		}
	}

	if err := h.checkBlacklist(absPath); err != nil {
		return "", err
	}

	return absPath, nil
}

func (h *FileHandler) checkBlacklist(p string) error {
	// Check against running executable
	if exe, err := os.Executable(); err == nil {
		if exeP, err := filepath.Abs(exe); err == nil {
			if p == exeP {
				return os.ErrPermission
			}
		}
	}

	// Check system paths
	var systemPrefixes []string
	if runtime.GOOS == "windows" {
		systemPrefixes = []string{
			`C:\Windows`, `C:\Program Files`, `C:\Program Files (x86)`,
		}
		// On Windows, checking env vars is safer but this covers basics
		if sysRoot := os.Getenv("SystemRoot"); sysRoot != "" {
			systemPrefixes = append(systemPrefixes, sysRoot)
		}
	} else {
		systemPrefixes = []string{
			"/bin", "/boot", "/dev", "/etc", "/lib", "/lib64",
			"/proc", "/root", "/sbin", "/sys", "/usr", "/var",
		}
		if runtime.GOOS == "darwin" {
			systemPrefixes = append(systemPrefixes, "/System", "/Library", "/Applications")
		}
	}

	for _, prefix := range systemPrefixes {
		cleanPrefix := filepath.Clean(prefix)
		if p == cleanPrefix || strings.HasPrefix(p, cleanPrefix+string(filepath.Separator)) {
			// If baseDir is explicitly set and is inside the system prefix, allow it, e.g. macOS's temporary directory /var/folders/...
			if h.baseDir != "" {
				if absBase, err := filepath.Abs(h.baseDir); err == nil {
					if absBase == cleanPrefix || strings.HasPrefix(absBase, cleanPrefix+string(filepath.Separator)) {
						continue
					}
				}
			}
			return os.ErrPermission
		}
	}

	return nil
}

// @Summary Get absolute path
// @Tags File
// @Produce json
// @Param path query string true "Path"
// @Success 200 {object} map[string]string
// @Failure 400 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/file/abs [get]
func (h *FileHandler) Abs(c *gin.Context) {
	path := c.Query("path")
	if path == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "path is required"})
		return
	}
	absPath, err := filepath.Abs(path)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"path": absPath})
}

type NewFileRequest struct {
	Path    string `json:"path" binding:"required"`
	Content string `json:"content"`
	IsDir   bool   `json:"is_dir"`
}

// @Summary Create new file or directory
// @Tags File
// @Accept json
// @Produce json
// @Param request body NewFileRequest true "New file request"
// @Success 200 {object} map[string]interface{}
// @Failure 400 {object} map[string]string
// @Failure 409 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/file/new [post]
func (h *FileHandler) New(c *gin.Context) {
	var req NewFileRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	p, err := h.resolvePath(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if _, err := os.Stat(p); err == nil {
		c.JSON(http.StatusConflict, gin.H{"error": "path already exists"})
		return
	}
	if req.IsDir {
		if err := os.MkdirAll(p, 0755); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
	} else {
		dir := filepath.Dir(p)
		if err := os.MkdirAll(dir, 0755); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		if err := os.WriteFile(p, []byte(req.Content), 0644); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "path": p})
}

// @Summary Read file content
// @Tags File
// @Produce json
// @Param path query string true "File path"
// @Success 200 {object} map[string]interface{}
// @Failure 400 {object} map[string]string
// @Failure 404 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/file/read [get]
func (h *FileHandler) Read(c *gin.Context) {
	path := c.Query("path")
	if path == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "path is required"})
		return
	}
	p, err := h.resolvePath(path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	info, err := os.Stat(p)
	if err != nil {
		if os.IsNotExist(err) {
			c.JSON(http.StatusNotFound, gin.H{"error": "file not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if info.IsDir() {
		c.JSON(http.StatusBadRequest, gin.H{"error": "path is a directory"})
		return
	}
	content, err := os.ReadFile(p)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"path": p, "content": string(content), "size": info.Size()})
}

type WriteFileRequest struct {
	Path    string `json:"path" binding:"required"`
	Content string `json:"content" binding:"required"`
}

// @Summary Write file content
// @Tags File
// @Accept json
// @Produce json
// @Param request body WriteFileRequest true "Write file request"
// @Success 200 {object} map[string]interface{}
// @Failure 400 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/file/write [post]
func (h *FileHandler) Write(c *gin.Context) {
	var req WriteFileRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	p, err := h.resolvePath(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	dir := filepath.Dir(p)
	if err := os.MkdirAll(dir, 0755); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if err := os.WriteFile(p, []byte(req.Content), 0644); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "path": p})
}

type FileInfo struct {
	Name    string `json:"name"`
	Path    string `json:"path"`
	IsDir   bool   `json:"is_dir"`
	Size    int64  `json:"size"`
	ModTime int64  `json:"mod_time"`
}

// @Summary List directory contents
// @Tags File
// @Produce json
// @Param path query string false "Directory path"
// @Success 200 {object} map[string]interface{}
// @Failure 400 {object} map[string]string
// @Failure 404 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/file/list [get]
func (h *FileHandler) List(c *gin.Context) {
	path := c.Query("path")
	if path == "" {
		path = "."
	}
	p, err := h.resolvePath(path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	info, err := os.Stat(p)
	if err != nil {
		if os.IsNotExist(err) {
			c.JSON(http.StatusNotFound, gin.H{"error": "directory not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if !info.IsDir() {
		c.JSON(http.StatusBadRequest, gin.H{"error": "path is not a directory"})
		return
	}
	entries, err := os.ReadDir(p)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	files := make([]FileInfo, 0, len(entries))
	for _, e := range entries {
		info, err := e.Info()
		if err != nil {
			continue
		}
		files = append(files, FileInfo{
			Name:    e.Name(),
			Path:    filepath.Join(p, e.Name()),
			IsDir:   e.IsDir(),
			Size:    info.Size(),
			ModTime: info.ModTime().Unix(),
		})
	}
	c.JSON(http.StatusOK, gin.H{"path": p, "files": files})
}

type TreeNode struct {
	Name     string      `json:"name"`
	Path     string      `json:"path"`
	IsDir    bool        `json:"is_dir"`
	Children []*TreeNode `json:"children,omitempty"`
}

// @Summary Get directory tree
// @Tags File
// @Produce json
// @Param path query string false "Directory path"
// @Success 200 {object} TreeNode
// @Failure 400 {object} map[string]string
// @Failure 404 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/file/tree [get]
func (h *FileHandler) Tree(c *gin.Context) {
	path := c.Query("path")
	if path == "" {
		path = "."
	}
	p, err := h.resolvePath(path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	info, err := os.Stat(p)
	if err != nil {
		if os.IsNotExist(err) {
			c.JSON(http.StatusNotFound, gin.H{"error": "directory not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if !info.IsDir() {
		c.JSON(http.StatusBadRequest, gin.H{"error": "path is not a directory"})
		return
	}
	root := &TreeNode{Name: filepath.Base(p), Path: p, IsDir: true}
	h.buildTree(root, p, 3)
	c.JSON(http.StatusOK, root)
}

func (h *FileHandler) buildTree(node *TreeNode, path string, depth int) {
	if depth <= 0 {
		return
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		return
	}
	for _, e := range entries {
		child := &TreeNode{
			Name:  e.Name(),
			Path:  filepath.Join(path, e.Name()),
			IsDir: e.IsDir(),
		}
		if e.IsDir() {
			h.buildTree(child, child.Path, depth-1)
		}
		node.Children = append(node.Children, child)
	}
}

// @Summary Search files by pattern
// @Tags File
// @Produce json
// @Param path query string false "Search path"
// @Param pattern query string true "Search pattern"
// @Success 200 {object} map[string][]FileInfo
// @Failure 400 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/file/search [get]
func (h *FileHandler) Search(c *gin.Context) {
	path := c.Query("path")
	if path == "" {
		path = "."
	}
	pattern := c.Query("pattern")
	if pattern == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "pattern is required"})
		return
	}
	p, err := h.resolvePath(path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	var matches []FileInfo
	err = filepath.WalkDir(p, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		matched, err := filepath.Match(pattern, d.Name())
		if err != nil {
			return nil
		}
		if matched {
			info, err := d.Info()
			if err != nil {
				return nil
			}
			matches = append(matches, FileInfo{
				Name:    d.Name(),
				Path:    path,
				IsDir:   d.IsDir(),
				Size:    info.Size(),
				ModTime: info.ModTime().Unix(),
			})
		}
		return nil
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"matches": matches})
}

type RemoveRequest struct {
	Path string `json:"path" binding:"required"`
}

// @Summary Remove file or directory
// @Tags File
// @Accept json
// @Produce json
// @Param request body RemoveRequest true "Remove request"
// @Success 200 {object} map[string]bool
// @Failure 400 {object} map[string]string
// @Failure 404 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/file/rm [delete]
func (h *FileHandler) Remove(c *gin.Context) {
	var req RemoveRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	p, err := h.resolvePath(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if _, err := os.Stat(p); os.IsNotExist(err) {
		c.JSON(http.StatusNotFound, gin.H{"error": "path not found"})
		return
	}
	if err := os.RemoveAll(p); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

type RenameRequest struct {
	OldPath string `json:"old_path" binding:"required"`
	NewPath string `json:"new_path" binding:"required"`
}

// @Summary Rename file or directory
// @Tags File
// @Accept json
// @Produce json
// @Param request body RenameRequest true "Rename request"
// @Success 200 {object} map[string]interface{}
// @Failure 400 {object} map[string]string
// @Failure 404 {object} map[string]string
// @Failure 409 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/file/rename [post]
func (h *FileHandler) Rename(c *gin.Context) {
	var req RenameRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	oldP, err := h.resolvePath(req.OldPath)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	newP, err := h.resolvePath(req.NewPath)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if _, err := os.Stat(oldP); os.IsNotExist(err) {
		c.JSON(http.StatusNotFound, gin.H{"error": "source path not found"})
		return
	}
	if _, err := os.Stat(newP); err == nil {
		c.JSON(http.StatusConflict, gin.H{"error": "destination already exists"})
		return
	}
	if err := os.Rename(oldP, newP); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "path": newP})
}

type MkdirRequest struct {
	Path string `json:"path" binding:"required"`
}

// @Summary Create directory
// @Tags File
// @Accept json
// @Produce json
// @Param request body MkdirRequest true "Mkdir request"
// @Success 200 {object} map[string]interface{}
// @Failure 400 {object} map[string]string
// @Failure 409 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /api/file/mkdir [post]
func (h *FileHandler) Mkdir(c *gin.Context) {
	var req MkdirRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	p, err := h.resolvePath(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if _, err := os.Stat(p); err == nil {
		c.JSON(http.StatusConflict, gin.H{"error": "path already exists"})
		return
	}
	if err := os.MkdirAll(p, 0755); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "path": p})
}
