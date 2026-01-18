package main

import (
	"context"
	"fmt"
	"io/fs"
	"net/http"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/rs/zerolog/log"
	swaggerFiles "github.com/swaggo/files"
	ginSwagger "github.com/swaggo/gin-swagger"
	"github.com/xxnuo/vibego/internal/config"

	"github.com/xxnuo/vibego/internal/docs"
	"github.com/xxnuo/vibego/internal/handler"
	"github.com/xxnuo/vibego/internal/logger"
	"github.com/xxnuo/vibego/internal/middleware"
	"github.com/xxnuo/vibego/internal/model"
	"github.com/xxnuo/vibego/internal/version"
	"github.com/xxnuo/vibego/ui"
)

// @title VibeGo API
// @version 0.0.1
// @description VibeGo 后端服务 API
// @host localhost:1984
// @BasePath /api
func main() {
	cfg := config.GetConfig()

	logger.Setup(cfg.LogLevel)
	logger.SetLogFile(cfg.LogDir, cfg.DisableLogToFile)

	fmt.Printf("Starting VibeGo server at: http://%s:%s\n", cfg.Host, cfg.Port)

	log.Info().
		Str("host", cfg.Host).
		Str("port", cfg.Port).
		Str("version", version.Version).
		Str("cors-origins", cfg.CORSOrigins).
		Bool("allow-wan", cfg.AllowWAN).
		Msg("Starting VibeGo server")

	gin.SetMode(gin.ReleaseMode)
	r := gin.New()

	r.Use(middleware.Recovery())
	r.Use(middleware.Logger())
	r.Use(middleware.RateLimit(100, time.Minute))
	r.Use(middleware.AllowWAN(cfg.AllowWAN))
	r.Use(middleware.CORS(cfg.CORSOrigins))

	docs.SwaggerInfo.BasePath = "/"
	swaggerHandler := ginSwagger.WrapHandler(swaggerFiles.Handler)
	r.GET("/docs/*any", func(c *gin.Context) {
		if c.Param("any") == "/" {
			c.Redirect(http.StatusMovedPermanently, "/docs/index.html")
			return
		}
		swaggerHandler(c)
	})

	r.GET("/docs", func(c *gin.Context) {
		c.Redirect(http.StatusMovedPermanently, "/docs/index.html")
	})

	handler.NewSystemHandler().Register(r)

	db := config.GetDB(
		&model.User{},
		&model.UserSession{},
		&model.KV{},
		&model.UserSetting{},
		&model.TerminalSession{},
		&model.TerminalHistory{},
	)

	api := r.Group("/api")

	authHandler := handler.NewAuthHandler(db, cfg.Token)
	authHandler.Register(api)

	r.Use(middleware.Auth(cfg.Token))

	handler.NewSettingsHandler(db).Register(api)
	handler.NewSessionHandler(db).Register(api)
	handler.NewFileHandler().Register(api)
	handler.NewTerminalHandler(db, cfg.DefaultShell).Register(api)
	handler.NewGitHandler().Register(api)

	distFS, err := ui.GetDistFS()
	if err == nil {
		fileServer := http.FileServer(http.FS(distFS))
		r.NoRoute(func(c *gin.Context) {
			path := strings.TrimPrefix(c.Request.URL.Path, "/")
			if path == "" {
				path = "index.html"
			}
			if _, err := fs.Stat(distFS, path); err == nil {
				fileServer.ServeHTTP(c.Writer, c.Request)
				return
			}
			c.Status(http.StatusNotFound)
		})
	}

	srv := &http.Server{
		Addr:    fmt.Sprintf("%s:%s", cfg.Host, cfg.Port),
		Handler: r,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatal().Err(err).Msg("Server error")
		}
	}()

	<-ctx.Done()
	log.Info().Msg("Shutting down server...")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Error().Err(err).Msg("Server shutdown error")
	}
}
