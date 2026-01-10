package main

import (
	"embed"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/gorilla/websocket"
	"github.com/xxnuo/vibego/internal/model"
	"github.com/xxnuo/vibego/internal/service/terminal"
	"github.com/xxnuo/vibego/internal/utils"
	"gorm.io/gorm"
)

//go:embed index.html
var content embed.FS

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

func main() {
	db, err := gorm.Open(sqlite.Open("tests_terminal.db"), &gorm.Config{})
	if err != nil {
		log.Fatalf("failed to connect database: %v", err)
	}

	if err := db.AutoMigrate(&model.TerminalSession{}, &model.TerminalHistory{}); err != nil {
		log.Fatalf("failed to migrate: %v", err)
	}

	manager := terminal.NewManager(db, &terminal.ManagerConfig{
		Shell:          os.Getenv("SHELL"),
		MaxConnections: 10,
		BufferSize:     32 * 1024,
	})
	manager.CleanupOnStart()

	r := gin.Default()
	gin.SetMode(gin.ReleaseMode)

	r.GET("/", func(c *gin.Context) {
		data, _ := content.ReadFile("index.html")
		c.Data(http.StatusOK, "text/html; charset=utf-8", data)
	})

	r.GET("/api/terminals", func(c *gin.Context) {
		sessions, err := manager.List()
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, sessions)
	})

	r.POST("/api/terminals", func(c *gin.Context) {
		var req struct {
			Name string `json:"name"`
			Cwd  string `json:"cwd"`
			Cols int    `json:"cols"`
			Rows int    `json:"rows"`
		}

		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}

		info, err := manager.Create(terminal.CreateOptions{
			Name: req.Name,
			Cwd:  req.Cwd,
			Cols: req.Cols,
			Rows: req.Rows,
		})
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}

		c.JSON(http.StatusOK, info)
	})

	r.DELETE("/api/terminals/:id", func(c *gin.Context) {
		id := c.Param("id")
		if err := manager.Close(id); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"message": "closed"})
	})

	r.DELETE("/api/terminals/:id/delete", func(c *gin.Context) {
		id := c.Param("id")
		if err := manager.Delete(id); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"message": "deleted"})
	})

	r.GET("/api/terminals/:id/ws", func(c *gin.Context) {
		id := c.Param("id")

		wsConn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
		if err != nil {
			log.Printf("upgrade error: %v", err)
			return
		}

		conn, err := manager.Attach(id, wsConn)
		if err != nil {
			log.Printf("attach error: %v", err)
			wsConn.Close()
			return
		}

		<-conn.Done
	})

	r.POST("/api/terminals/:id/resize", func(c *gin.Context) {
		id := c.Param("id")

		var req terminal.ResizeMessage
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}

		if err := manager.Resize(id, req.Cols, req.Rows); err != nil {
			if errors.Is(err, terminal.ErrTerminalNotFound) {
				c.JSON(http.StatusNotFound, gin.H{"error": "terminal not found"})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}

		c.JSON(http.StatusOK, gin.H{"message": "resized"})
	})

	p, err := utils.GetFreePort()
	if err != nil {
		log.Fatalf("failed to get free port: %v", err)
	}
	log.Printf("Server starting on http://localhost:%d", p)
	if err := r.Run(fmt.Sprintf(":%d", p)); err != nil {
		log.Fatalf("failed to start server: %v", err)
	}
}
