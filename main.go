package main

import (
	"context"
	"crypto/tls"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
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
	"github.com/xxnuo/vibego/internal/service/asr"
	"github.com/xxnuo/vibego/internal/svcctl"
	vibegoTls "github.com/xxnuo/vibego/internal/tls"
	"github.com/xxnuo/vibego/internal/transport"
	"github.com/xxnuo/vibego/internal/version"
	"github.com/xxnuo/vibego/ui"
)

func printAccessibleAddresses(host, port, scheme string) {
	if host == "0.0.0.0" || host == "::" || host == "" {
		fmt.Printf("VibeGo server listening on:\n")
		ifaces, err := net.Interfaces()
		if err == nil {
			for _, iface := range ifaces {
				if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
					continue
				}
				addrs, err := iface.Addrs()
				if err != nil {
					continue
				}
				for _, addr := range addrs {
					var ip net.IP
					switch v := addr.(type) {
					case *net.IPNet:
						ip = v.IP
					case *net.IPAddr:
						ip = v.IP
					}
					if ip == nil || ip.IsLoopback() {
						continue
					}
					if ip.To4() != nil {
						fmt.Printf("  -> %s://%s:%s\n", scheme, ip.String(), port)
					} else {
						fmt.Printf("  -> %s://[%s]:%s\n", scheme, ip.String(), port)
					}
				}
			}
		}
	} else {
		fmt.Printf("VibeGo server listening on:\n")
		fmt.Printf("  -> %s://%s:%s\n", scheme, host, port)
	}
}

// @title VibeGo API
// @version 0.3.0
// @description VibeGo 后端服务 API
// @host localhost:1984
// @BasePath /api
func main() {
	if svcctl.Run(os.Args, runServer) {
		return
	}

	if err := runServerWithSignals(); err != nil {
		log.Fatal().Err(err).Msg("Server stopped")
	}
}

func runServerWithSignals() error {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	return runServer(ctx)
}

func runServer(ctx context.Context) error {
	cfg := config.GetConfig()

	logger.Setup(cfg.LogLevel)
	logger.SetLogFile(cfg.LogDir, cfg.DisableLogToFile)

	scheme := "https"
	if cfg.NoTLS {
		scheme = "http"
	}
	printAccessibleAddresses(cfg.Host, cfg.Port, scheme)

	log.Info().
		Str("host", cfg.Host).
		Str("port", cfg.Port).
		Str("version", version.Version).
		Str("cors-origins", cfg.CORSOrigins).
		Bool("allow-wan", cfg.AllowWAN).
		Bool("tls", !cfg.NoTLS).
		Msg("Starting VibeGo server")

	gin.SetMode(gin.ReleaseMode)
	r := gin.New()

	r.Use(middleware.Recovery())
	r.Use(middleware.Logger())
	r.Use(middleware.RateLimit(5000, time.Minute))
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
	asrService := asr.New(asr.Config{
		Version:          cfg.AsrVersion,
		WasmURL:          cfg.AsrWasmURL,
		DataURL:          cfg.AsrDataURL,
		Source:           cfg.AsrSource,
		ExtraSourcesJSON: cfg.AsrSources,
	})

	db := config.GetDB(
		&model.User{},
		&model.UserSession{},
		&model.AISessionIndex{},
		&model.KV{},
		&model.UserSetting{},
		&model.TerminalSession{},
		&model.TerminalHistory{},
	)

	api := r.Group("/api")

	authHandler := handler.NewAuthHandler(db, cfg.Key, cfg.NeedKey)
	authHandler.Register(api)

	if cfg.NeedKey {
		r.Use(middleware.Auth(cfg.Key))
	}

	handler.NewSettingsHandler(db).Register(api)
	handler.NewASRHandler(asrService).Register(api)
	handler.NewSessionHandler(db).Register(api)
	handler.NewAISessionHandler(db).Register(api)
	handler.NewFileHandler().Register(api)
	handler.NewTerminalHandler(db, cfg.DefaultShell).Register(api)
	gitHandler := handler.NewGitHandler(db)
	gitHandler.Register(api)
	gitWSHandler := handler.NewGitWSHandler(gitHandler)
	gitHandler.SetWSHandler(gitWSHandler)
	gitWSHandler.Register(api)
	handler.NewProcessHandler().Register(api)
	handler.NewPortHandler().Register(api)
	handler.NewRemoteHandler().Register(api)

	distFS, distErr := ui.GetDistFS()

	if cfg.DevUI != "" {
		devTarget, err := url.Parse(cfg.DevUI)
		if err != nil {
			log.Fatal().Err(err).Msg("Invalid dev-ui URL")
		}
		proxy := httputil.NewSingleHostReverseProxy(devTarget)
		proxy.Director = func(req *http.Request) {
			req.URL.Scheme = devTarget.Scheme
			req.URL.Host = devTarget.Host
			req.Host = devTarget.Host
		}
		r.NoRoute(func(c *gin.Context) {
			proxy.ServeHTTP(c.Writer, c.Request)
		})
		log.Info().Str("target", cfg.DevUI).Msg("Dev UI proxy enabled")
	} else {
		if distErr == nil {
			fileServer := http.FileServer(http.FS(distFS))
			transport.RegisterASRAssets(r, asr.BaseURL, distFS)
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
	}

	srv := &http.Server{
		Addr:    fmt.Sprintf("%s:%s", cfg.Host, cfg.Port),
		Handler: r,
	}

	var (
		certFile   string
		keyFile    string
		upgradeSrv *http.Server
		mux        *transport.ProtocolMux
	)

	if !cfg.NoTLS {
		var err error
		certFile, keyFile, err = resolveTLSCert(cfg)
		if err != nil {
			log.Fatal().Err(err).Msg("Failed to setup TLS certificate")
		}

		listener, listenErr := net.Listen("tcp", srv.Addr)
		if listenErr != nil {
			log.Fatal().Err(listenErr).Msg("Failed to listen")
		}

		if distErr != nil {
			log.Fatal().Err(distErr).Msg("Failed to load UI dist for HTTP upgrade page")
		}

		upgradeHandler, upgradeErr := transport.NewHTTPSUpgradeHandler(transport.HTTPSUpgradeHandlerConfig{
			DistFS:          distFS,
			Fallback:        r,
			UpgradePagePath: "http-upgrade.html",
		})
		if upgradeErr != nil {
			log.Fatal().Err(upgradeErr).Msg("Failed to setup HTTP upgrade page")
		}

		mux = transport.NewProtocolMux(listener)
		upgradeSrv = &http.Server{
			Handler: upgradeHandler,
		}
		srv.TLSConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	}

	serverErr := make(chan error, 1)
	go func() {
		var err error
		if cfg.NoTLS {
			err = srv.ListenAndServe()
		} else {
			go func() {
				upgradeErr := upgradeSrv.Serve(mux.HTTP())
				if upgradeErr != nil && upgradeErr != http.ErrServerClosed {
					log.Fatal().Err(upgradeErr).Msg("HTTP upgrade server error")
				}
			}()

			err = srv.ServeTLS(mux.TLS(), certFile, keyFile)
		}
		if err != nil && err != http.ErrServerClosed {
			serverErr <- err
			return
		}
		serverErr <- nil
	}()

	select {
	case <-ctx.Done():
	case err := <-serverErr:
		return err
	}

	log.Info().Msg("Shutting down server...")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if upgradeSrv != nil {
		if err := upgradeSrv.Shutdown(shutdownCtx); err != nil {
			log.Error().Err(err).Msg("HTTP upgrade server shutdown error")
		}
	}
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Error().Err(err).Msg("Server shutdown error")
	}
	if mux != nil {
		_ = mux.Close()
	}
	return nil
}

func resolveTLSCert(cfg *config.Config) (certFile, keyFile string, err error) {
	if cfg.TlsCert != "" && cfg.TlsKey != "" {
		return cfg.TlsCert, cfg.TlsKey, nil
	}
	certFile, keyFile, err = vibegoTls.EnsureCert(cfg.ConfigDir)
	if err != nil {
		return "", "", fmt.Errorf("auto-generate self-signed cert: %w", err)
	}
	log.Info().Str("cert", certFile).Str("key", keyFile).Msg("Using self-signed TLS certificate")
	return
}
