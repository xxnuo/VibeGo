package handler

import (
	"context"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

var gitShellEnvCache struct {
	sync.Once
	env []string
}

func newGitCommand(args ...string) *exec.Cmd {
	env := fixedGitEnv(os.Environ())
	path := lookPathInEnv("git", env)
	cmdArgs := append([]string{"git"}, args...)
	cmd := &exec.Cmd{
		Path: path,
		Args: cmdArgs,
		Env:  env,
	}
	return cmd
}

func fixedGitEnv(base []string) []string {
	env := mergeEnv(base, gitShellEnv())
	result := make([]string, 0, len(env)+3)
	for _, item := range env {
		switch {
		case len(item) >= 7 && item[:7] == "LC_ALL=":
			continue
		case len(item) >= 5 && item[:5] == "LANG=":
			continue
		case len(item) >= 9 && item[:9] == "LANGUAGE=":
			continue
		default:
			result = append(result, item)
		}
	}
	result = append(result, "LC_ALL=C", "LANG=C", "LANGUAGE=C")
	return result
}

func gitShellEnv() []string {
	if os.Getenv("VG_GIT_SHELL_ENV") == "0" {
		return nil
	}
	gitShellEnvCache.Do(func() {
		gitShellEnvCache.env = loadGitShellEnv()
	})
	return gitShellEnvCache.env
}

func loadGitShellEnv() []string {
	shell := gitUserShell()
	if shell == "" {
		return nil
	}
	for _, args := range [][]string{{"-lc", "env -0"}, {"-c", "env -0"}} {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		cmd := exec.CommandContext(ctx, shell, args...)
		cmd.Env = os.Environ()
		output, err := cmd.Output()
		cancel()
		if err == nil && len(output) > 0 {
			return parseNullEnv(string(output))
		}
	}
	return nil
}

func gitUserShell() string {
	if shell := os.Getenv("SHELL"); shell != "" {
		return shell
	}
	if current, err := user.Current(); err == nil && current.Username != "" && runtime.GOOS != "windows" {
		passwd, err := os.ReadFile("/etc/passwd")
		if err == nil {
			for _, line := range strings.Split(string(passwd), "\n") {
				parts := strings.Split(line, ":")
				if len(parts) >= 7 && (parts[0] == current.Username || parts[2] == current.Uid) {
					return parts[6]
				}
			}
		}
	}
	switch runtime.GOOS {
	case "windows":
		return os.Getenv("ComSpec")
	case "darwin":
		return "/bin/zsh"
	default:
		for _, shell := range []string{"/bin/bash", "/bin/sh"} {
			if _, err := os.Stat(shell); err == nil {
				return shell
			}
		}
		return ""
	}
}

func parseNullEnv(output string) []string {
	items := strings.Split(output, "\x00")
	env := make([]string, 0, len(items))
	for _, item := range items {
		item = strings.TrimPrefix(item, "\ufeff")
		if idx := strings.LastIndex(item, "\n"); idx >= 0 {
			item = item[idx+1:]
		}
		if !validEnvItem(item) {
			continue
		}
		env = append(env, item)
	}
	return env
}

func validEnvItem(item string) bool {
	idx := strings.IndexByte(item, '=')
	if idx <= 0 {
		return false
	}
	key := item[:idx]
	for _, r := range key {
		if r == '_' || r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z' || r >= '0' && r <= '9' {
			continue
		}
		return false
	}
	return true
}

func mergeEnv(base, overlay []string) []string {
	result := make([]string, 0, len(base)+len(overlay))
	index := map[string]int{}
	add := func(item string) {
		key := envKey(item)
		if key == "" {
			return
		}
		if i, ok := index[key]; ok {
			result[i] = item
			return
		}
		index[key] = len(result)
		result = append(result, item)
	}
	for _, item := range base {
		add(item)
	}
	for _, item := range overlay {
		add(item)
	}
	if runtime.GOOS != "windows" {
		if home := envValue(result, "HOME"); home != "" {
			localBin := filepath.Join(home, ".local", "bin")
			path := envValue(result, "PATH")
			if path != "" && !pathContains(path, localBin) {
				add("PATH=" + localBin + string(os.PathListSeparator) + path)
			}
		}
	}
	return result
}

func envKey(item string) string {
	idx := strings.IndexByte(item, '=')
	if idx <= 0 {
		return ""
	}
	return item[:idx]
}

func envValue(env []string, key string) string {
	prefix := key + "="
	for _, item := range env {
		if strings.HasPrefix(item, prefix) {
			return strings.TrimPrefix(item, prefix)
		}
	}
	return ""
}

func pathContains(path, dir string) bool {
	for _, item := range filepath.SplitList(path) {
		if item == dir {
			return true
		}
	}
	return false
}

func lookPathInEnv(file string, env []string) string {
	path := envValue(env, "PATH")
	if path == "" {
		return file
	}
	for _, dir := range filepath.SplitList(path) {
		if dir == "" {
			dir = "."
		}
		candidate := filepath.Join(dir, file)
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() && info.Mode()&0111 != 0 {
			return candidate
		}
	}
	return file
}
