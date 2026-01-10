package main

import (
	"embed"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/xxnuo/vibego/internal/utils"
)

//go:embed index.html
var content embed.FS

func main() {
	r := gin.Default()
	gin.SetMode(gin.ReleaseMode)

	r.GET("/", func(c *gin.Context) {
		data, _ := content.ReadFile("index.html")
		c.Data(http.StatusOK, "text/html; charset=utf-8", data)
	})

	r.GET("/api/file/list", listHandler)
	r.POST("/api/file/new", createHandler)
	r.POST("/api/file/del", deleteHandler)
	r.POST("/api/file/rename", renameHandler)
	r.POST("/api/file/content", contentHandler)
	r.POST("/api/file/save", saveHandler)
	r.GET("/api/file/download", downloadHandler)
	r.POST("/api/file/upload", uploadHandler)
	r.POST("/api/file/mkdir", mkdirHandler)
	r.POST("/api/file/copy", copyHandler)
	r.POST("/api/file/move", moveHandler)

	p, err := utils.GetFreePort()
	if err != nil {
		log.Fatalf("failed to get free port: %v", err)
	}
	log.Printf("File Manager starting on http://localhost:%d", p)
	if err := r.Run(fmt.Sprintf(":%d", p)); err != nil {
		log.Fatalf("failed to start server: %v", err)
	}
}

type FileInfo struct {
	Name    string `json:"name"`
	Path    string `json:"path"`
	IsDir   bool   `json:"isDir"`
	Size    int64  `json:"size"`
	ModTime int64  `json:"modTime"`
	Mode    string `json:"mode"`
}

func listHandler(c *gin.Context) {
	path := c.DefaultQuery("path", ".")
	absPath, _ := filepath.Abs(path)
	entries, err := os.ReadDir(absPath)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	var files []FileInfo
	for _, e := range entries {
		info, _ := e.Info()
		files = append(files, FileInfo{
			Name:    e.Name(),
			Path:    filepath.Join(absPath, e.Name()),
			IsDir:   e.IsDir(),
			Size:    info.Size(),
			ModTime: info.ModTime().Unix(),
			Mode:    fmt.Sprintf("%04o", info.Mode().Perm()),
		})
	}
	c.JSON(http.StatusOK, gin.H{"path": absPath, "files": files})
}

func createHandler(c *gin.Context) {
	var req struct {
		Path    string `json:"path"`
		Content string `json:"content"`
		IsDir   bool   `json:"isDir"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if req.IsDir {
		if err := os.MkdirAll(req.Path, 0755); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
	} else {
		os.MkdirAll(filepath.Dir(req.Path), 0755)
		if err := os.WriteFile(req.Path, []byte(req.Content), 0644); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func deleteHandler(c *gin.Context) {
	var req struct {
		Path string `json:"path"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := os.RemoveAll(req.Path); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func renameHandler(c *gin.Context) {
	var req struct {
		OldName string `json:"oldName"`
		NewName string `json:"newName"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := os.Rename(req.OldName, req.NewName); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func contentHandler(c *gin.Context) {
	var req struct {
		Path string `json:"path"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	content, err := os.ReadFile(req.Path)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	info, _ := os.Stat(req.Path)
	c.JSON(http.StatusOK, gin.H{"path": req.Path, "content": string(content), "size": info.Size()})
}

func saveHandler(c *gin.Context) {
	var req struct {
		Path    string `json:"path"`
		Content string `json:"content"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := os.WriteFile(req.Path, []byte(req.Content), 0644); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func downloadHandler(c *gin.Context) {
	path := c.Query("path")
	c.File(path)
}

func uploadHandler(c *gin.Context) {
	form, _ := c.MultipartForm()
	files := form.File["file"]
	paths := form.Value["path"]
	if len(paths) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "path required"})
		return
	}
	dstDir := paths[0]
	os.MkdirAll(dstDir, 0755)
	for _, file := range files {
		dst := filepath.Join(dstDir, file.Filename)
		c.SaveUploadedFile(file, dst)
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func mkdirHandler(c *gin.Context) {
	var req struct {
		Path string `json:"path"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := os.MkdirAll(req.Path, 0755); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func copyHandler(c *gin.Context) {
	var req struct {
		Src string `json:"src"`
		Dst string `json:"dst"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := copyPath(req.Src, req.Dst); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func moveHandler(c *gin.Context) {
	var req struct {
		Src string `json:"src"`
		Dst string `json:"dst"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := os.Rename(req.Src, req.Dst); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
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
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	os.MkdirAll(filepath.Dir(dst), 0755)
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, in)
	return err
}

func copyDir(src, dst string) error {
	os.MkdirAll(dst, 0755)
	entries, _ := os.ReadDir(src)
	for _, e := range entries {
		s := filepath.Join(src, e.Name())
		d := filepath.Join(dst, e.Name())
		if e.IsDir() {
			copyDir(s, d)
		} else {
			copyFile(s, d)
		}
	}
	return nil
}

var _ = strconv.Atoi
var _ = strings.TrimSpace
