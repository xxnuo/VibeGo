package handler

import (
	"archive/tar"
	"archive/zip"
	"bufio"
	"compress/gzip"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"os/user"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
)

var systemPrefixes []string
var exePath string

func init() {
	if runtime.GOOS == "windows" {
		systemPrefixes = []string{`C:\Windows`, `C:\Program Files`, `C:\Program Files (x86)`}
		if sysRoot := os.Getenv("SystemRoot"); sysRoot != "" {
			systemPrefixes = append(systemPrefixes, sysRoot)
		}
	} else {
		systemPrefixes = []string{"/bin", "/boot", "/dev", "/etc", "/lib", "/lib64", "/proc", "/root", "/sbin", "/sys", "/usr", "/var"}
		if runtime.GOOS == "darwin" {
			systemPrefixes = append(systemPrefixes, "/System", "/Library", "/Applications")
		}
	}
	if exe, err := os.Executable(); err == nil {
		exePath, _ = filepath.Abs(exe)
	}
}

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
	g.POST("/search", h.Search)
	g.POST("/tree", h.GetFileTree)
	g.POST("/new", h.Create)
	g.POST("/del", h.Delete)
	g.POST("/batch/del", h.BatchDelete)
	g.POST("/mode", h.ChangeMode)
	g.POST("/owner", h.ChangeOwner)
	g.POST("/compress", h.Compress)
	g.POST("/decompress", h.Decompress)
	g.POST("/content", h.GetContent)
	g.POST("/save", h.SaveContent)
	g.POST("/upload", h.Upload)
	g.POST("/check", h.CheckExist)
	g.POST("/batch/check", h.BatchCheckExist)
	g.POST("/rename", h.Rename)
	g.POST("/move", h.Move)
	g.GET("/download", h.Download)
	g.POST("/size", h.GetSize)
	g.POST("/batch/role", h.BatchChangeModeAndOwner)
	g.GET("/read", h.Read)
	g.POST("/write", h.Write)
	g.GET("/list", h.List)
	g.GET("/grep", h.Grep)
	g.DELETE("", h.Remove)
	g.POST("/mkdir", h.Mkdir)
	g.GET("/abs", h.Abs)
	g.POST("/copy", h.Copy)
	g.GET("/info", h.Info)
}

type FileInfo struct {
	Path      string     `json:"path"`
	Name      string     `json:"name"`
	User      string     `json:"user"`
	Group     string     `json:"group"`
	Uid       string     `json:"uid"`
	Gid       string     `json:"gid"`
	Extension string     `json:"extension"`
	Content   string     `json:"content,omitempty"`
	Size      int64      `json:"size"`
	IsDir     bool       `json:"isDir"`
	IsSymlink bool       `json:"isSymlink"`
	IsHidden  bool       `json:"isHidden"`
	LinkPath  string     `json:"linkPath,omitempty"`
	Type      string     `json:"type,omitempty"`
	Mode      string     `json:"mode"`
	MimeType  string     `json:"mimeType,omitempty"`
	ModTime   time.Time  `json:"modTime"`
	Items     []FileInfo `json:"items,omitempty"`
	ItemTotal int        `json:"itemTotal"`
}

type FileOption struct {
	Path       string `json:"path" binding:"required"`
	Search     string `json:"search"`
	ContainSub bool   `json:"containSub"`
	Expand     bool   `json:"expand"`
	Dir        bool   `json:"dir"`
	ShowHidden bool   `json:"showHidden"`
	Page       int    `json:"page"`
	PageSize   int    `json:"pageSize"`
	SortBy     string `json:"sortBy"`
	SortOrder  string `json:"sortOrder"`
}

type FileTree struct {
	ID        string     `json:"id"`
	Name      string     `json:"name"`
	Path      string     `json:"path"`
	IsDir     bool       `json:"isDir"`
	Extension string     `json:"extension"`
	Children  []FileTree `json:"children,omitempty"`
}

type FileCreate struct {
	Path      string `json:"path" binding:"required"`
	Content   string `json:"content"`
	IsDir     bool   `json:"isDir"`
	Mode      int64  `json:"mode"`
	IsLink    bool   `json:"isLink"`
	IsSymlink bool   `json:"isSymlink"`
	LinkPath  string `json:"linkPath"`
}

type FileDelete struct {
	Path        string `json:"path" binding:"required"`
	IsDir       bool   `json:"isDir"`
	ForceDelete bool   `json:"forceDelete"`
}

type FileBatchDelete struct {
	Paths []string `json:"paths" binding:"required"`
}

type FileRename struct {
	OldName string `json:"oldName" binding:"required"`
	NewName string `json:"newName" binding:"required"`
}

type FileMove struct {
	Type     string   `json:"type" binding:"required"`
	OldPaths []string `json:"oldPaths" binding:"required"`
	NewPath  string   `json:"newPath" binding:"required"`
	Name     string   `json:"name"`
	Cover    bool     `json:"cover"`
}

type FileCompress struct {
	Files   []string `json:"files" binding:"required"`
	Dst     string   `json:"dst" binding:"required"`
	Type    string   `json:"type" binding:"required"`
	Name    string   `json:"name" binding:"required"`
	Replace bool     `json:"replace"`
}

type FileDecompress struct {
	Dst  string `json:"dst" binding:"required"`
	Type string `json:"type" binding:"required"`
	Path string `json:"path" binding:"required"`
}

type FileContentReq struct {
	Path string `json:"path" binding:"required"`
}

type FileEdit struct {
	Path    string `json:"path" binding:"required"`
	Content string `json:"content"`
}

type FilePathCheck struct {
	Path string `json:"path" binding:"required"`
}

type FilePathsCheck struct {
	Paths []string `json:"paths" binding:"required"`
}

type FileRoleReq struct {
	Paths []string `json:"paths" binding:"required"`
	Mode  string   `json:"mode" binding:"required"`
	User  string   `json:"user" binding:"required"`
	Group string   `json:"group" binding:"required"`
	Sub   bool     `json:"sub"`
}

type FileRoleUpdate struct {
	Path  string `json:"path" binding:"required"`
	User  string `json:"user" binding:"required"`
	Group string `json:"group" binding:"required"`
	Sub   bool   `json:"sub"`
}

type FileModeUpdate struct {
	Path string `json:"path" binding:"required"`
	Mode string `json:"mode" binding:"required"`
	Sub  bool   `json:"sub"`
}

type DirSizeReq struct {
	Path string `json:"path" binding:"required"`
}

type ExistFileInfo struct {
	Name    string    `json:"name"`
	Path    string    `json:"path"`
	Size    int64     `json:"size"`
	ModTime time.Time `json:"modTime"`
	IsDir   bool      `json:"isDir"`
}

type FileCopy struct {
	SrcPaths []string `json:"srcPaths" binding:"required"`
	DstPath  string   `json:"dstPath" binding:"required"`
	Cover    bool     `json:"cover"`
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
	if exePath != "" && p == exePath {
		return os.ErrPermission
	}
	for _, prefix := range systemPrefixes {
		cleanPrefix := filepath.Clean(prefix)
		if p == cleanPrefix || strings.HasPrefix(p, cleanPrefix+string(filepath.Separator)) {
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

func getFileInfo(path string) (*FileInfo, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	fi := &FileInfo{
		Path:      path,
		Name:      info.Name(),
		Size:      info.Size(),
		IsDir:     info.IsDir(),
		IsSymlink: info.Mode()&os.ModeSymlink != 0,
		IsHidden:  strings.HasPrefix(info.Name(), "."),
		Extension: filepath.Ext(info.Name()),
		Mode:      fmt.Sprintf("%04o", info.Mode().Perm()),
		ModTime:   info.ModTime(),
	}
	if stat, ok := info.Sys().(*syscall.Stat_t); ok {
		fi.Uid = strconv.FormatUint(uint64(stat.Uid), 10)
		fi.Gid = strconv.FormatUint(uint64(stat.Gid), 10)
		if u, err := user.LookupId(fi.Uid); err == nil {
			fi.User = u.Username
		} else {
			fi.User = fi.Uid
		}
		if g, err := user.LookupGroupId(fi.Gid); err == nil {
			fi.Group = g.Name
		} else {
			fi.Group = fi.Gid
		}
	}
	if fi.IsSymlink {
		if linkPath, err := os.Readlink(path); err == nil {
			fi.LinkPath = linkPath
		}
		if targetInfo, err := os.Stat(path); err == nil {
			fi.IsDir = targetInfo.IsDir()
		} else {
			fi.Type = "invalid_link"
		}
	}
	return fi, nil
}

// @Summary List files with pagination and sorting
// @Tags File
// @Accept json
// @Produce json
// @Param request body FileOption true "File option"
// @Success 200 {object} FileInfo
// @Router /api/file/search [post]
func (h *FileHandler) Search(c *gin.Context) {
	var req FileOption
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	p, err := h.resolvePath(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	info, err := os.Stat(p)
	if err != nil {
		if os.IsNotExist(err) {
			c.JSON(http.StatusOK, FileInfo{Path: p})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if !info.IsDir() {
		req.Path = filepath.Dir(p)
		p = req.Path
	}
	fileInfo, err := getFileInfo(p)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if req.Page == 0 {
		req.Page = 1
	}
	if req.PageSize == 0 {
		req.PageSize = 100
	}
	items, total := h.listChildren(p, req)
	fileInfo.Items = items
	fileInfo.ItemTotal = total
	c.JSON(http.StatusOK, fileInfo)
}

func (h *FileHandler) listChildren(path string, opt FileOption) ([]FileInfo, int) {
	entries, err := os.ReadDir(path)
	if err != nil {
		return nil, 0
	}
	var items []FileInfo
	for _, e := range entries {
		if !opt.ShowHidden && strings.HasPrefix(e.Name(), ".") {
			continue
		}
		if opt.Dir && !e.IsDir() {
			continue
		}
		if opt.Search != "" && !opt.ContainSub {
			if !strings.Contains(strings.ToLower(e.Name()), strings.ToLower(opt.Search)) {
				continue
			}
		}
		fPath := filepath.Join(path, e.Name())
		fi, err := getFileInfo(fPath)
		if err != nil {
			continue
		}
		items = append(items, *fi)
	}
	h.sortFileList(items, opt.SortBy, opt.SortOrder)
	total := len(items)
	start := (opt.Page - 1) * opt.PageSize
	end := start + opt.PageSize
	if start > total {
		return []FileInfo{}, total
	}
	if end > total {
		end = total
	}
	return items[start:end], total
}

func (h *FileHandler) sortFileList(list []FileInfo, sortBy, sortOrder string) {
	sort.Slice(list, func(i, j int) bool {
		if list[i].IsDir != list[j].IsDir {
			return list[i].IsDir
		}
		var less bool
		switch sortBy {
		case "size":
			less = list[i].Size < list[j].Size
		case "modTime":
			less = list[i].ModTime.Before(list[j].ModTime)
		default:
			less = strings.ToLower(list[i].Name) < strings.ToLower(list[j].Name)
		}
		if sortOrder == "descending" {
			return !less
		}
		return less
	})
}

// @Summary Get file tree
// @Tags File
// @Accept json
// @Produce json
// @Param request body FileOption true "File option"
// @Success 200 {array} FileTree
// @Router /api/file/tree [post]
func (h *FileHandler) GetFileTree(c *gin.Context) {
	var req FileOption
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
		c.JSON(http.StatusOK, []FileTree{})
		return
	}
	fi, _ := getFileInfo(p)
	tree := FileTree{
		ID:        fmt.Sprintf("%d", time.Now().UnixNano()),
		Name:      fi.Name,
		Path:      fi.Path,
		IsDir:     fi.IsDir,
		Extension: fi.Extension,
	}
	h.buildFileTree(&tree, req, 2)
	c.JSON(http.StatusOK, []FileTree{tree})
}

func (h *FileHandler) buildFileTree(node *FileTree, opt FileOption, level int) {
	if level <= 0 || !node.IsDir {
		return
	}
	entries, err := os.ReadDir(node.Path)
	if err != nil {
		return
	}
	for _, e := range entries {
		if !opt.ShowHidden && strings.HasPrefix(e.Name(), ".") {
			continue
		}
		if opt.Dir && !e.IsDir() {
			continue
		}
		child := FileTree{
			ID:        fmt.Sprintf("%d", time.Now().UnixNano()),
			Name:      e.Name(),
			Path:      filepath.Join(node.Path, e.Name()),
			IsDir:     e.IsDir(),
			Extension: filepath.Ext(e.Name()),
		}
		if e.IsDir() {
			h.buildFileTree(&child, opt, level-1)
		}
		node.Children = append(node.Children, child)
	}
}

// @Summary Create file or directory
// @Tags File
// @Accept json
// @Produce json
// @Param request body FileCreate true "File create request"
// @Success 200 {object} map[string]interface{}
// @Router /api/file/new [post]
func (h *FileHandler) Create(c *gin.Context) {
	var req FileCreate
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
	mode := os.FileMode(0755)
	if req.Mode != 0 {
		mode = os.FileMode(req.Mode)
	}
	if req.IsDir {
		if err := os.MkdirAll(p, mode); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
	} else if req.IsLink {
		if req.LinkPath == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "linkPath is required"})
			return
		}
		if req.IsSymlink {
			if err := os.Symlink(req.LinkPath, p); err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
				return
			}
		} else {
			if err := os.Link(req.LinkPath, p); err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
				return
			}
		}
	} else {
		dir := filepath.Dir(p)
		if err := os.MkdirAll(dir, 0755); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		if err := os.WriteFile(p, []byte(req.Content), mode); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "path": p})
}

// @Summary Delete file or directory
// @Tags File
// @Accept json
// @Produce json
// @Param request body FileDelete true "File delete request"
// @Success 200 {object} map[string]interface{}
// @Router /api/file/del [post]
func (h *FileHandler) Delete(c *gin.Context) {
	var req FileDelete
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	p, err := h.resolvePath(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := os.RemoveAll(p); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// @Summary Batch delete files
// @Tags File
// @Accept json
// @Produce json
// @Param request body FileBatchDelete true "Batch delete request"
// @Success 200 {object} map[string]interface{}
// @Router /api/file/batch/del [post]
func (h *FileHandler) BatchDelete(c *gin.Context) {
	var req FileBatchDelete
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	var errs []string
	for _, path := range req.Paths {
		p, err := h.resolvePath(path)
		if err != nil {
			errs = append(errs, fmt.Sprintf("%s: %s", path, err.Error()))
			continue
		}
		if err := os.RemoveAll(p); err != nil {
			errs = append(errs, fmt.Sprintf("%s: %s", path, err.Error()))
		}
	}
	if len(errs) > 0 {
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "errors": errs})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// @Summary Change file mode
// @Tags File
// @Accept json
// @Produce json
// @Param request body FileModeUpdate true "Mode update request"
// @Success 200 {object} map[string]interface{}
// @Router /api/file/mode [post]
func (h *FileHandler) ChangeMode(c *gin.Context) {
	var req FileModeUpdate
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	p, err := h.resolvePath(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	mode, err := strconv.ParseUint(req.Mode, 8, 32)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid mode"})
		return
	}
	if req.Sub {
		err = filepath.WalkDir(p, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			return os.Chmod(path, os.FileMode(mode))
		})
	} else {
		err = os.Chmod(p, os.FileMode(mode))
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// @Summary Change file owner
// @Tags File
// @Accept json
// @Produce json
// @Param request body FileRoleUpdate true "Owner update request"
// @Success 200 {object} map[string]interface{}
// @Router /api/file/owner [post]
func (h *FileHandler) ChangeOwner(c *gin.Context) {
	var req FileRoleUpdate
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	p, err := h.resolvePath(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	uid, _ := strconv.Atoi(req.User)
	gid, _ := strconv.Atoi(req.Group)
	if req.Sub {
		err = filepath.WalkDir(p, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			return os.Chown(path, uid, gid)
		})
	} else {
		err = os.Chown(p, uid, gid)
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// @Summary Batch change mode and owner
// @Tags File
// @Accept json
// @Produce json
// @Param request body FileRoleReq true "Batch role request"
// @Success 200 {object} map[string]interface{}
// @Router /api/file/batch/role [post]
func (h *FileHandler) BatchChangeModeAndOwner(c *gin.Context) {
	var req FileRoleReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	mode, err := strconv.ParseUint(req.Mode, 8, 32)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid mode"})
		return
	}
	uid, _ := strconv.Atoi(req.User)
	gid, _ := strconv.Atoi(req.Group)
	var errs []string
	for _, path := range req.Paths {
		p, err := h.resolvePath(path)
		if err != nil {
			errs = append(errs, fmt.Sprintf("%s: %s", path, err.Error()))
			continue
		}
		if req.Sub {
			filepath.WalkDir(p, func(fpath string, d fs.DirEntry, err error) error {
				if err != nil {
					return nil
				}
				os.Chmod(fpath, os.FileMode(mode))
				os.Chown(fpath, uid, gid)
				return nil
			})
		} else {
			os.Chmod(p, os.FileMode(mode))
			os.Chown(p, uid, gid)
		}
	}
	if len(errs) > 0 {
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "errors": errs})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// @Summary Get file content
// @Tags File
// @Accept json
// @Produce json
// @Param request body FileContentReq true "Content request"
// @Success 200 {object} FileInfo
// @Router /api/file/content [post]
func (h *FileHandler) GetContent(c *gin.Context) {
	var req FileContentReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	p, err := h.resolvePath(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	fi, err := getFileInfo(p)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if fi.IsDir {
		c.JSON(http.StatusBadRequest, gin.H{"error": "path is a directory"})
		return
	}
	if fi.Size > 10*1024*1024 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "file too large (>10MB)"})
		return
	}
	content, err := os.ReadFile(p)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	fi.Content = string(content)
	c.JSON(http.StatusOK, fi)
}

// @Summary Save file content
// @Tags File
// @Accept json
// @Produce json
// @Param request body FileEdit true "Edit request"
// @Success 200 {object} map[string]interface{}
// @Router /api/file/save [post]
func (h *FileHandler) SaveContent(c *gin.Context) {
	var req FileEdit
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	p, err := h.resolvePath(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	info, err := os.Stat(p)
	mode := os.FileMode(0644)
	if err == nil {
		mode = info.Mode()
	}
	if err := os.WriteFile(p, []byte(req.Content), mode); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// @Summary Upload file
// @Tags File
// @Accept multipart/form-data
// @Produce json
// @Param file formData file true "File"
// @Param path formData string true "Destination path"
// @Param overwrite formData bool false "Overwrite"
// @Success 200 {object} map[string]interface{}
// @Router /api/file/upload [post]
func (h *FileHandler) Upload(c *gin.Context) {
	form, err := c.MultipartForm()
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	files := form.File["file"]
	paths := form.Value["path"]
	if len(paths) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "path is required"})
		return
	}
	overwrite := false
	if ow, ok := form.Value["overwrite"]; ok && len(ow) > 0 {
		overwrite, _ = strconv.ParseBool(ow[0])
	}
	dstDir, err := h.resolvePath(paths[0])
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := os.MkdirAll(dstDir, 0755); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	var uploaded []string
	var errs []string
	for _, file := range files {
		dstPath := filepath.Join(dstDir, file.Filename)
		if !overwrite {
			if _, err := os.Stat(dstPath); err == nil {
				errs = append(errs, fmt.Sprintf("%s: file exists", file.Filename))
				continue
			}
		}
		if err := c.SaveUploadedFile(file, dstPath); err != nil {
			errs = append(errs, fmt.Sprintf("%s: %s", file.Filename, err.Error()))
			continue
		}
		uploaded = append(uploaded, dstPath)
	}
	if len(errs) > 0 && len(uploaded) == 0 {
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "errors": errs})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "uploaded": uploaded, "errors": errs})
}

// @Summary Check file exists
// @Tags File
// @Accept json
// @Produce json
// @Param request body FilePathCheck true "Check request"
// @Success 200 {object} map[string]interface{}
// @Router /api/file/check [post]
func (h *FileHandler) CheckExist(c *gin.Context) {
	var req FilePathCheck
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	p, err := h.resolvePath(req.Path)
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"exist": false})
		return
	}
	if _, err := os.Stat(p); os.IsNotExist(err) {
		c.JSON(http.StatusOK, gin.H{"exist": false})
		return
	}
	c.JSON(http.StatusOK, gin.H{"exist": true, "path": p})
}

// @Summary Batch check files exist
// @Tags File
// @Accept json
// @Produce json
// @Param request body FilePathsCheck true "Check request"
// @Success 200 {array} ExistFileInfo
// @Router /api/file/batch/check [post]
func (h *FileHandler) BatchCheckExist(c *gin.Context) {
	var req FilePathsCheck
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	var result []ExistFileInfo
	for _, path := range req.Paths {
		p, err := h.resolvePath(path)
		if err != nil {
			continue
		}
		info, err := os.Stat(p)
		if err != nil {
			continue
		}
		result = append(result, ExistFileInfo{
			Name:    info.Name(),
			Path:    p,
			Size:    info.Size(),
			ModTime: info.ModTime(),
			IsDir:   info.IsDir(),
		})
	}
	c.JSON(http.StatusOK, result)
}

// @Summary Rename file
// @Tags File
// @Accept json
// @Produce json
// @Param request body FileRename true "Rename request"
// @Success 200 {object} map[string]interface{}
// @Router /api/file/rename [post]
func (h *FileHandler) Rename(c *gin.Context) {
	var req FileRename
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	oldP, err := h.resolvePath(req.OldName)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	newP, err := h.resolvePath(req.NewName)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if _, err := os.Stat(oldP); os.IsNotExist(err) {
		c.JSON(http.StatusNotFound, gin.H{"error": "source not found"})
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
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// @Summary Move files
// @Tags File
// @Accept json
// @Produce json
// @Param request body FileMove true "Move request"
// @Success 200 {object} map[string]interface{}
// @Router /api/file/move [post]
func (h *FileHandler) Move(c *gin.Context) {
	var req FileMove
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	newPath, err := h.resolvePath(req.NewPath)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	var errs []string
	for _, oldPath := range req.OldPaths {
		srcPath, err := h.resolvePath(oldPath)
		if err != nil {
			errs = append(errs, fmt.Sprintf("%s: %s", oldPath, err.Error()))
			continue
		}
		dstPath := filepath.Join(newPath, filepath.Base(srcPath))
		if req.Name != "" && len(req.OldPaths) == 1 {
			dstPath = filepath.Join(newPath, req.Name)
		}
		if !req.Cover {
			if _, err := os.Stat(dstPath); err == nil {
				errs = append(errs, fmt.Sprintf("%s: destination exists", oldPath))
				continue
			}
		}
		if req.Type == "copy" {
			if err := copyPath(srcPath, dstPath); err != nil {
				errs = append(errs, fmt.Sprintf("%s: %s", oldPath, err.Error()))
			}
		} else {
			if err := os.Rename(srcPath, dstPath); err != nil {
				errs = append(errs, fmt.Sprintf("%s: %s", oldPath, err.Error()))
			}
		}
	}
	if len(errs) > 0 {
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "errors": errs})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func copyPath(src, dst string) error {
	info, err := os.Stat(src)
	if err != nil {
		return err
	}
	if info.IsDir() {
		return copyDir(src, dst)
	}
	return copyFile(src, dst)
}

func copyFile(src, dst string) error {
	srcFile, err := os.Open(src)
	if err != nil {
		return err
	}
	defer srcFile.Close()
	if err := os.MkdirAll(filepath.Dir(dst), 0755); err != nil {
		return err
	}
	dstFile, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer dstFile.Close()
	if _, err := io.Copy(dstFile, srcFile); err != nil {
		return err
	}
	info, _ := os.Stat(src)
	return os.Chmod(dst, info.Mode())
}

func copyDir(src, dst string) error {
	srcInfo, err := os.Stat(src)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dst, srcInfo.Mode()); err != nil {
		return err
	}
	entries, err := os.ReadDir(src)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		srcPath := filepath.Join(src, entry.Name())
		dstPath := filepath.Join(dst, entry.Name())
		if entry.IsDir() {
			if err := copyDir(srcPath, dstPath); err != nil {
				return err
			}
		} else {
			if err := copyFile(srcPath, dstPath); err != nil {
				return err
			}
		}
	}
	return nil
}

// @Summary Download file
// @Tags File
// @Produce octet-stream
// @Param path query string true "File path"
// @Success 200 {file} binary
// @Router /api/file/download [get]
func (h *FileHandler) Download(c *gin.Context) {
	path := c.Query("path")
	if path == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "path required"})
		return
	}
	p, err := h.resolvePath(path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	file, err := os.Open(p)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "file not found"})
		return
	}
	defer file.Close()
	info, _ := file.Stat()
	c.Header("Content-Length", strconv.FormatInt(info.Size(), 10))
	c.Header("Content-Disposition", "attachment; filename*=utf-8''"+url.PathEscape(info.Name()))
	http.ServeContent(c.Writer, c.Request, info.Name(), info.ModTime(), file)
}

// @Summary Get directory size
// @Tags File
// @Accept json
// @Produce json
// @Param request body DirSizeReq true "Size request"
// @Success 200 {object} map[string]interface{}
// @Router /api/file/size [post]
func (h *FileHandler) GetSize(c *gin.Context) {
	var req DirSizeReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	p, err := h.resolvePath(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	var size int64
	filepath.WalkDir(p, func(_ string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		if info, err := d.Info(); err == nil {
			size += info.Size()
		}
		return nil
	})
	c.JSON(http.StatusOK, gin.H{"path": p, "size": size})
}

// @Summary Read file content (GET)
// @Tags File
// @Produce json
// @Param path query string true "File path"
// @Success 200 {object} map[string]interface{}
// @Router /api/file/read [get]
func (h *FileHandler) Read(c *gin.Context) {
	path := c.Query("path")
	if path == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "path required"})
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

// @Summary Write file content
// @Tags File
// @Accept json
// @Produce json
// @Param request body FileEdit true "Write request"
// @Success 200 {object} map[string]interface{}
// @Router /api/file/write [post]
func (h *FileHandler) Write(c *gin.Context) {
	var req FileEdit
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	p, err := h.resolvePath(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	os.MkdirAll(filepath.Dir(p), 0755)
	if err := os.WriteFile(p, []byte(req.Content), 0644); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "path": p})
}

// @Summary List directory (GET)
// @Tags File
// @Produce json
// @Param path query string false "Directory path"
// @Success 200 {object} map[string]interface{}
// @Router /api/file/list [get]
func (h *FileHandler) List(c *gin.Context) {
	path := c.DefaultQuery("path", ".")
	p, err := h.resolvePath(path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	info, err := os.Stat(p)
	if err != nil {
		if os.IsNotExist(err) {
			c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if !info.IsDir() {
		c.JSON(http.StatusBadRequest, gin.H{"error": "not a directory"})
		return
	}
	entries, _ := os.ReadDir(p)
	var files []FileInfo
	for _, e := range entries {
		eInfo, _ := e.Info()
		fi, _ := getFileInfo(filepath.Join(p, e.Name()))
		if fi != nil {
			files = append(files, *fi)
		} else if eInfo != nil {
			files = append(files, FileInfo{Name: e.Name(), Path: filepath.Join(p, e.Name()), IsDir: e.IsDir(), Size: eInfo.Size(), ModTime: eInfo.ModTime()})
		}
	}
	c.JSON(http.StatusOK, gin.H{"path": p, "files": files})
}

type GrepMatch struct {
	File    string `json:"file"`
	Line    int    `json:"line"`
	Content string `json:"content"`
}

// @Summary Grep files
// @Tags File
// @Produce json
// @Param pattern query string true "Search pattern"
// @Param path query string false "Search path"
// @Param limit query int false "Max results"
// @Success 200 {object} map[string]interface{}
// @Router /api/file/grep [get]
func (h *FileHandler) Grep(c *gin.Context) {
	pattern := c.Query("pattern")
	if pattern == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "pattern required"})
		return
	}
	path := c.DefaultQuery("path", ".")
	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "100"))
	p, err := h.resolvePath(path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	re, err := regexp.Compile(pattern)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid pattern: " + err.Error()})
		return
	}
	var matches []GrepMatch
	filepath.WalkDir(p, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || len(matches) >= limit {
			return nil
		}
		file, err := os.Open(path)
		if err != nil {
			return nil
		}
		defer file.Close()
		scanner := bufio.NewScanner(file)
		lineNum := 0
		for scanner.Scan() && len(matches) < limit {
			lineNum++
			line := scanner.Text()
			if re.MatchString(line) {
				matches = append(matches, GrepMatch{File: path, Line: lineNum, Content: line})
			}
		}
		return nil
	})
	c.JSON(http.StatusOK, gin.H{"matches": matches})
}

// @Summary Remove file or directory
// @Tags File
// @Produce json
// @Param path query string true "Path to remove"
// @Success 200 {object} map[string]interface{}
// @Router /api/file [delete]
func (h *FileHandler) Remove(c *gin.Context) {
	path := c.Query("path")
	if path == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "path required"})
		return
	}
	p, err := h.resolvePath(path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if _, err := os.Stat(p); os.IsNotExist(err) {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	if err := os.RemoveAll(p); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// @Summary Create directory
// @Tags File
// @Accept json
// @Produce json
// @Param request body FileCreate true "Mkdir request"
// @Success 200 {object} map[string]interface{}
// @Router /api/file/mkdir [post]
func (h *FileHandler) Mkdir(c *gin.Context) {
	var req FileCreate
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
		c.JSON(http.StatusConflict, gin.H{"error": "already exists"})
		return
	}
	if err := os.MkdirAll(p, 0755); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "path": p})
}

// @Summary Get absolute path
// @Tags File
// @Produce json
// @Param path query string true "Path"
// @Success 200 {object} map[string]interface{}
// @Router /api/file/abs [get]
func (h *FileHandler) Abs(c *gin.Context) {
	path := c.Query("path")
	if path == "" {
		path = "."
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"path": abs})
}

// @Summary Copy files
// @Tags File
// @Accept json
// @Produce json
// @Param request body FileCopy true "Copy request"
// @Success 200 {object} map[string]interface{}
// @Router /api/file/copy [post]
func (h *FileHandler) Copy(c *gin.Context) {
	var req FileCopy
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	dstPath, err := h.resolvePath(req.DstPath)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	var errs []string
	for _, src := range req.SrcPaths {
		srcPath, err := h.resolvePath(src)
		if err != nil {
			errs = append(errs, fmt.Sprintf("%s: %s", src, err.Error()))
			continue
		}
		target := filepath.Join(dstPath, filepath.Base(srcPath))
		if !req.Cover {
			if _, err := os.Stat(target); err == nil {
				errs = append(errs, fmt.Sprintf("%s: destination exists", src))
				continue
			}
		}
		if err := copyPath(srcPath, target); err != nil {
			errs = append(errs, fmt.Sprintf("%s: %s", src, err.Error()))
		}
	}
	if len(errs) > 0 {
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "errors": errs})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// @Summary Get file info
// @Tags File
// @Produce json
// @Param path query string true "File path"
// @Success 200 {object} FileInfo
// @Router /api/file/info [get]
func (h *FileHandler) Info(c *gin.Context) {
	path := c.Query("path")
	if path == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "path required"})
		return
	}
	p, err := h.resolvePath(path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	info, err := getFileInfo(p)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, info)
}

// @Summary Compress files
// @Tags File
// @Accept json
// @Produce json
// @Param request body FileCompress true "Compress request"
// @Success 200 {object} map[string]interface{}
// @Router /api/file/compress [post]
func (h *FileHandler) Compress(c *gin.Context) {
	var req FileCompress
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	dst, err := h.resolvePath(req.Dst)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	var paths []string
	for _, f := range req.Files {
		p, err := h.resolvePath(f)
		if err == nil {
			paths = append(paths, p)
		}
	}
	if len(paths) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "no valid files"})
		return
	}
	var compressErr error
	switch strings.ToLower(req.Type) {
	case "zip":
		compressErr = compressZip(paths, dst)
	case "tar.gz", "tgz":
		compressErr = compressTarGz(paths, dst)
	default:
		c.JSON(http.StatusBadRequest, gin.H{"error": "unsupported type, use zip or tar.gz"})
		return
	}
	if compressErr != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": compressErr.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "path": dst})
}

func compressZip(files []string, dst string) error {
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer out.Close()
	w := zip.NewWriter(out)
	defer w.Close()
	for _, file := range files {
		if err := addToZip(w, file, filepath.Base(file)); err != nil {
			return err
		}
	}
	return nil
}

func addToZip(w *zip.Writer, path, base string) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if info.IsDir() {
		entries, _ := os.ReadDir(path)
		for _, e := range entries {
			if err := addToZip(w, filepath.Join(path, e.Name()), filepath.Join(base, e.Name())); err != nil {
				return err
			}
		}
		return nil
	}
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	header, _ := zip.FileInfoHeader(info)
	header.Name = base
	header.Method = zip.Deflate
	writer, err := w.CreateHeader(header)
	if err != nil {
		return err
	}
	_, err = io.Copy(writer, file)
	return err
}

func compressTarGz(files []string, dst string) error {
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer out.Close()
	gw := gzip.NewWriter(out)
	defer gw.Close()
	tw := tar.NewWriter(gw)
	defer tw.Close()
	for _, file := range files {
		if err := addToTar(tw, file, filepath.Base(file)); err != nil {
			return err
		}
	}
	return nil
}

func addToTar(tw *tar.Writer, path, base string) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if info.IsDir() {
		entries, _ := os.ReadDir(path)
		for _, e := range entries {
			if err := addToTar(tw, filepath.Join(path, e.Name()), filepath.Join(base, e.Name())); err != nil {
				return err
			}
		}
		return nil
	}
	header, _ := tar.FileInfoHeader(info, "")
	header.Name = base
	if err := tw.WriteHeader(header); err != nil {
		return err
	}
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	_, err = io.Copy(tw, file)
	return err
}

// @Summary Decompress archive
// @Tags File
// @Accept json
// @Produce json
// @Param request body FileDecompress true "Decompress request"
// @Success 200 {object} map[string]interface{}
// @Router /api/file/decompress [post]
func (h *FileHandler) Decompress(c *gin.Context) {
	var req FileDecompress
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	src, err := h.resolvePath(req.Path)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	dst, err := h.resolvePath(req.Dst)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	var decompressErr error
	switch strings.ToLower(req.Type) {
	case "zip":
		decompressErr = decompressZip(src, dst)
	case "tar.gz", "tgz":
		decompressErr = decompressTarGz(src, dst)
	default:
		c.JSON(http.StatusBadRequest, gin.H{"error": "unsupported type, use zip or tar.gz"})
		return
	}
	if decompressErr != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": decompressErr.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "path": dst})
}

func decompressZip(src, dst string) error {
	r, err := zip.OpenReader(src)
	if err != nil {
		return err
	}
	defer r.Close()
	for _, f := range r.File {
		path := filepath.Join(dst, f.Name)
		if f.FileInfo().IsDir() {
			os.MkdirAll(path, f.Mode())
			continue
		}
		os.MkdirAll(filepath.Dir(path), 0755)
		rc, err := f.Open()
		if err != nil {
			return err
		}
		out, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, f.Mode())
		if err != nil {
			rc.Close()
			return err
		}
		io.Copy(out, rc)
		out.Close()
		rc.Close()
	}
	return nil
}

func decompressTarGz(src, dst string) error {
	file, err := os.Open(src)
	if err != nil {
		return err
	}
	defer file.Close()
	gr, err := gzip.NewReader(file)
	if err != nil {
		return err
	}
	defer gr.Close()
	tr := tar.NewReader(gr)
	for {
		header, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		path := filepath.Join(dst, header.Name)
		if header.Typeflag == tar.TypeDir {
			os.MkdirAll(path, os.FileMode(header.Mode))
			continue
		}
		os.MkdirAll(filepath.Dir(path), 0755)
		out, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, os.FileMode(header.Mode))
		if err != nil {
			return err
		}
		io.Copy(out, tr)
		out.Close()
	}
	return nil
}
