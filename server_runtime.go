//go:build (!desktop && !desktop_window) || desktop_server

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
	"strconv"
	"strings"
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
	"github.com/xxnuo/vibego/internal/service/blocktermmodel"
	"github.com/xxnuo/vibego/internal/service/sshconnection"
	"github.com/xxnuo/vibego/internal/service/terminal"
	vibegoTls "github.com/xxnuo/vibego/internal/tls"
	"github.com/xxnuo/vibego/internal/transport"
	"github.com/xxnuo/vibego/internal/version"
	"github.com/xxnuo/vibego/ui"
)

type serverOptions struct {
	Configure func(*config.Config)
	Ready     func(string)
}

func runServer(ctx context.Context) error {
	return runServerWithOptions(ctx, serverOptions{})
}

func runServerWithOptions(ctx context.Context, options serverOptions) error {
	cfg := config.GetConfig()
	if options.Configure != nil {
		options.Configure(cfg)
	}

	logger.Setup(cfg.LogLevel)
	logger.SetLogFile(cfg.LogDir, cfg.DisableLogToFile)

	scheme := "https"
	if cfg.NoTLS {
		scheme = "http"
	}
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
		&model.SSHConnectionProfile{},
		&model.SSHKnownHost{},
	)
	if err := config.MigrateBlockTerm(db); err != nil {
		return fmt.Errorf("migrate BlockTerm data: %w", err)
	}
	sshService := sshconnection.New(db)
	defer sshService.Close()
	terminalManager := terminal.NewManager(db, &terminal.ManagerConfig{
		Shell:          cfg.DefaultShell,
		RuntimeFactory: sshService,
	})
	terminalManager.CleanupOnStart()
	blockTermModelService := blocktermmodel.NewWithOptions(db, blocktermmodel.Options{
		MutationGate:     terminalManager.BlockTermMutationGate(),
		TerminalMutation: terminalManager.WithRunningTerminal,
		TerminalRunning: func(id string) bool {
			info, ok := terminalManager.Get(id)
			return ok && info.Status == model.StatusRunning && !info.Readonly
		},
	})
	if err := blockTermModelService.CleanupOnStart(); err != nil {
		return fmt.Errorf("cleanup stale BlockTerm model runs: %w", err)
	}
	defer blockTermModelService.Close()
	fileViews, err := middleware.NewFileViewAuthorizer()
	if err != nil {
		return err
	}

	api := r.Group("/api")
	authHandler := handler.NewAuthHandler(db, cfg.Key, cfg.NeedKey)
	authHandler.Register(api)
	githubHandler := handler.NewGitHubHandler(db)
	// OAuth providers redirect directly to this callback and cannot include the
	// VibeGo API key. State validation in the handler provides the callback
	// authentication boundary.
	githubHandler.RegisterPublicAuthRoutes(api)
	if cfg.NeedKey {
		api.Use(middleware.Auth(cfg.Key, fileViews))
	}

	handler.NewSettingsHandler(db).Register(api)
	handler.NewASRHandler(asrService).Register(api)
	handler.NewSessionHandler(db, terminalManager).Register(api)
	handler.NewAISessionHandler(db).Register(api)
	handler.NewCodexHandler().Register(api)
	fileHandler := handler.NewFileHandler(fileViews)
	fileHandler.SetRemoteFileProvider(sshService)
	fileHandler.Register(api)
	handler.NewTerminalHandler(terminalManager).Register(api)
	handler.NewBlockTermHandler(terminalManager).Register(api)
	handler.NewBlockTermModelHandler(blockTermModelService).Register(api)
	handler.NewSSHHandler(sshService).Register(api)
	githubHandler.RegisterProtectedRoutes(api)
	gitHandler := handler.NewGitHandler(db)
	gitHandler.Register(api)
	gitWSHandler := handler.NewGitWSHandler(gitHandler)
	gitHandler.SetWSHandler(gitWSHandler)
	gitWSHandler.Register(api)
	handler.NewProcessHandler().Register(api)
	handler.NewPortHandler().Register(api)
	handler.NewRemoteHandler().Register(api)
	handler.NewRemoteDesktopHandler().Register(api)

	distFS, distErr := ui.GetDistFS()
	if cfg.DevUI != "" {
		devTarget, err := url.Parse(cfg.DevUI)
		if err != nil {
			return fmt.Errorf("invalid dev-ui URL: %w", err)
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
	} else if distErr == nil {
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

	srv := &http.Server{
		Addr:     fmt.Sprintf("%s:%s", cfg.Host, cfg.Port),
		Handler:  r,
		ErrorLog: transport.NewServerErrorLog(os.Stderr),
	}
	listener, err := net.Listen("tcp", srv.Addr)
	if err != nil {
		return fmt.Errorf("failed to listen: %w", err)
	}
	actualPort := listener.Addr().(*net.TCPAddr).Port
	printAccessibleAddresses(cfg.Host, strconv.Itoa(actualPort), scheme)

	var (
		certFile      string
		keyFile       string
		trustCertFile string
		upgradeSrv    *http.Server
		mux           *transport.ProtocolMux
	)
	if !cfg.NoTLS {
		certFile, keyFile, trustCertFile, err = resolveTLSCert(cfg)
		if err != nil {
			_ = listener.Close()
			return err
		}
		trustCert, err := os.ReadFile(trustCertFile)
		if err != nil {
			_ = listener.Close()
			return fmt.Errorf("read TLS trust certificate: %w", err)
		}
		if distErr != nil {
			_ = listener.Close()
			return fmt.Errorf("load UI dist for HTTP upgrade page: %w", distErr)
		}
		upgradeHandler, upgradeErr := transport.NewHTTPSUpgradeHandler(transport.HTTPSUpgradeHandlerConfig{
			DistFS:          distFS,
			Fallback:        r,
			UpgradePagePath: "http-upgrade.html",
			Certificate:     trustCert,
		})
		if upgradeErr != nil {
			_ = listener.Close()
			return fmt.Errorf("setup HTTP upgrade page: %w", upgradeErr)
		}
		mux = transport.NewProtocolMux(listener)
		upgradeSrv = &http.Server{
			Handler:  upgradeHandler,
			ErrorLog: transport.NewServerErrorLog(os.Stderr),
		}
		srv.TLSConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	}

	if options.Ready != nil {
		options.Ready(fmt.Sprintf("%s://%s", scheme, net.JoinHostPort("127.0.0.1", strconv.Itoa(actualPort))))
	}

	serverErr := make(chan error, 1)
	go func() {
		if !cfg.NoTLS {
			go func() {
				if serveErr := upgradeSrv.Serve(mux.HTTP()); serveErr != nil && serveErr != http.ErrServerClosed {
					serverErr <- serveErr
				}
			}()
		}
		var serveErr error
		if cfg.NoTLS {
			serveErr = srv.Serve(listener)
		} else {
			serveErr = srv.ServeTLS(mux.TLS(), certFile, keyFile)
		}
		if serveErr != nil && serveErr != http.ErrServerClosed {
			serverErr <- serveErr
			return
		}
		serverErr <- nil
	}()

	select {
	case <-ctx.Done():
	case err := <-serverErr:
		if err != nil {
			return err
		}
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

func resolveTLSCert(cfg *config.Config) (certFile, keyFile, trustCertFile string, err error) {
	if cfg.TlsCert != "" && cfg.TlsKey != "" {
		return cfg.TlsCert, cfg.TlsKey, cfg.TlsCert, nil
	}
	tlsDir := cfg.TlsDir
	if tlsDir == "" {
		tlsDir = cfg.ConfigDir
	}
	certFile, keyFile, trustCertFile, err = vibegoTls.EnsureCert(tlsDir)
	if err != nil {
		return "", "", "", fmt.Errorf("auto-generate local TLS certificate: %w", err)
	}
	log.Info().Str("cert", certFile).Str("key", keyFile).Str("ca", trustCertFile).Msg("Using local TLS certificate")
	return
}
