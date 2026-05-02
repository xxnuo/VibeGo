package config

import (
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"

	"github.com/xxnuo/vibego/internal/utils"
	"github.com/xxnuo/vibego/internal/version"
)

type Config struct {
	LogLevel  string
	HomeDir   string
	ConfigDir string
	TlsDir    string
	LogDir    string

	Host        string
	Port        string
	CORSOrigins string

	Key string

	AllowWAN         bool
	NeedKey          bool
	DisableLogToFile bool
	NoTLS            bool

	TlsCert    string
	TlsKey     string
	DevUI      string
	AsrVersion string
	AsrWasmURL string
	AsrDataURL string
	AsrSource  string
	AsrSources string

	OS           string
	DefaultShell string
}

var GlobalConfig *Config = nil

func defaultConfig() *Config {
	cfg := &Config{}
	homeDir, err := os.UserHomeDir()
	if err != nil {
		panic(err)
	}

	cfg.HomeDir = filepath.Join(homeDir, ".config", "vibego")
	cfg.ConfigDir = filepath.Join(cfg.HomeDir, "server")
	cfg.TlsDir = cfg.ConfigDir
	cfg.LogDir = filepath.Join(cfg.HomeDir, "logs")
	return cfg
}

func bindFlags(fs *flag.FlagSet, cfg *Config) (*bool, *bool) {
	fs.StringVar(&cfg.LogLevel, "log-level", utils.GetEnv("VG_LOG_LEVEL", "warn"), "Log level (debug, info, warn, error)")
	fs.StringVar(&cfg.ConfigDir, "config-dir", utils.GetEnv("VG_CONFIG_DIR", cfg.ConfigDir), "Config directory")
	fs.StringVar(&cfg.LogDir, "log-dir", utils.GetEnv("VG_LOG_DIR", cfg.LogDir), "Log directory")
	fs.StringVar(&cfg.Host, "host", utils.GetEnv("VG_HOST", "0.0.0.0"), "Server host address")
	fs.StringVar(&cfg.Port, "port", utils.GetEnv("VG_PORT", "1984"), "Server port")
	fs.StringVar(&cfg.Port, "p", utils.GetEnv("VG_PORT", "1984"), "Server port(shorthand)")
	fs.StringVar(&cfg.Key, "key", utils.GetEnv("VG_KEY", ""), "Access key, if key is empty, allow-wan will be disabled for security reasons")
	fs.StringVar(&cfg.Key, "k", utils.GetEnv("VG_KEY", ""), "Access key(shorthand)")
	fs.BoolVar(&cfg.AllowWAN, "allow-wan", utils.GetBoolEnv("VG_ALLOW_WAN", true), "Allow WAN access, if allow-wan is false, the service will only be accessible from the LAN")
	fs.BoolVar(&cfg.AllowWAN, "a", utils.GetBoolEnv("VG_ALLOW_WAN", true), "Allow WAN access(shorthand)")
	fs.StringVar(&cfg.CORSOrigins, "cors-origins", utils.GetEnv("VG_CORS_ORIGINS", "*"), "CORS origins")
	fs.BoolVar(&cfg.DisableLogToFile, "disable-log-to-file", utils.GetBoolEnv("VG_DISABLE_LOG_TO_FILE", false), "Disable log to file")
	fs.BoolVar(&cfg.NeedKey, "need-key", utils.GetBoolEnv("VG_NEED_KEY", false), "Require key authentication (auto-enabled when allow-wan and key are both set)")
	fs.StringVar(&cfg.TlsCert, "tls-cert", utils.GetEnv("VG_TLS_CERT", ""), "TLS certificate file path (uses self-signed if empty)")
	fs.StringVar(&cfg.TlsKey, "tls-key", utils.GetEnv("VG_TLS_KEY", ""), "TLS private key file path (uses self-signed if empty)")
	fs.BoolVar(&cfg.NoTLS, "no-tls", utils.GetBoolEnv("VG_NO_TLS", false), "Disable TLS and use plain HTTP")
	fs.StringVar(&cfg.DevUI, "dev-ui", utils.GetEnv("VG_DEV_UI", ""), "Dev UI proxy target (e.g. http://localhost:15173)")
	fs.StringVar(&cfg.AsrVersion, "asr-version", utils.GetEnv("VG_ASR_VERSION", ""), "ASR asset version for cache busting")
	fs.StringVar(&cfg.AsrWasmURL, "asr-wasm-url", utils.GetEnv("VG_ASR_WASM_URL", ""), "ASR wasm asset URL")
	fs.StringVar(&cfg.AsrDataURL, "asr-data-url", utils.GetEnv("VG_ASR_DATA_URL", ""), "ASR data asset URL")
	fs.StringVar(&cfg.AsrSource, "asr-source", utils.GetEnv("VG_ASR_SOURCE", "auto"), "ASR asset source (auto, official, china, or custom id)")
	fs.StringVar(&cfg.AsrSources, "asr-extra-sources", utils.GetEnv("VG_ASR_EXTRA_SOURCES", ""), "Extra ASR asset sources JSON")

	defaultShell := ""
	switch runtime.GOOS {
	case "linux":
		defaultShell = utils.GetEnv("SHELL", "/bin/bash")
	case "darwin":
		defaultShell = utils.GetEnv("SHELL", "/bin/zsh")
	case "windows":
		defaultShell = utils.GetEnv("SHELL", "powershell")
	default:
		defaultShell = utils.GetEnv("SHELL", "/bin/sh")
	}

	fs.StringVar(&cfg.DefaultShell, "shell", utils.GetEnv("VG_SHELL", defaultShell), "Default shell for terminal sessions")

	versionFlag := fs.Bool("version", false, "Show version information")
	versionShortFlag := fs.Bool("v", false, "Show version information (shorthand)")
	return versionFlag, versionShortFlag
}

func writeUsage(w io.Writer, program string, printDefaults func()) {
	fmt.Fprintf(w, "VibeGo %s - Vibe Anywhere\n\n", version.Version)
	fmt.Fprintf(w, "Usage:\n")
	fmt.Fprintf(w, "  %s [options]\n", program)
	fmt.Fprintf(w, "  %s help [command]\n", program)
	fmt.Fprintf(w, "  %s install\n", program)
	fmt.Fprintf(w, "  %s uninstall\n", program)
	fmt.Fprintf(w, "  %s service <command> [service flags]\n\n", program)
	fmt.Fprintf(w, "Commands:\n")
	fmt.Fprintf(w, "  help        Show help for CLI or a command\n")
	fmt.Fprintf(w, "  install     Install binary to ~/.local/bin\n")
	fmt.Fprintf(w, "  uninstall   Remove installed binary\n")
	fmt.Fprintf(w, "  service     Manage background service\n\n")
	fmt.Fprintf(w, "Options:\n")
	printDefaults()
	fmt.Fprintf(w, "\nAll options also accept environment variables prefixed with VG_, e.g. VG_LOG_LEVEL=debug.\n")
}

func WriteHelp(w io.Writer, program string) {
	fs := flag.NewFlagSet(program, flag.ContinueOnError)
	fs.SetOutput(w)
	cfg := defaultConfig()
	bindFlags(fs, cfg)
	writeUsage(w, program, fs.PrintDefaults)
}

func GetConfig() *Config {
	if GlobalConfig != nil {
		return GlobalConfig
	}

	cfg := defaultConfig()
	versionFlag, versionShortFlag := bindFlags(flag.CommandLine, cfg)
	flag.CommandLine.SetOutput(os.Stderr)
	flag.Usage = func() {
		writeUsage(os.Stderr, os.Args[0], flag.CommandLine.PrintDefaults)
	}
	flag.Parse()

	if *versionFlag || *versionShortFlag {
		fmt.Printf("%s\n", version.Version)
		os.Exit(0)
	}

	if cfg.Key == "" {
		cfg.AllowWAN = false
	}
	if cfg.AllowWAN && cfg.Key != "" {
		cfg.NeedKey = true
	}

	GlobalConfig = cfg
	return cfg
}
