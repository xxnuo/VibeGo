package github

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

// Remote identifies a GitHub repository from a git remote URL.
// Host is kept separately so callers can distinguish github.com from an
// Enterprise host while still using the same owner/repository contract.
type Remote struct {
	URL        string `json:"url"`
	Host       string `json:"host"`
	Owner      string `json:"owner"`
	Repository string `json:"repository"`
	Repo       string `json:"repo"`
	HTMLURL    string `json:"html_url"`
	APIURL     string `json:"api_url"`
}

var remotePartPattern = regexp.MustCompile(`^[A-Za-z0-9_.-]+$`)

// ParseRemote parses the HTTPS, SSH and SCP-like forms emitted by git for a
// GitHub remote. It deliberately accepts a host other than github.com so the
// API base can be configured for GitHub Enterprise, while rejecting malformed
// paths and local filesystem remotes.
func ParseRemote(raw string) (Remote, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return Remote{}, errors.New("remote URL is required")
	}

	host, path, err := splitRemote(raw)
	if err != nil {
		return Remote{}, err
	}
	host = strings.ToLower(strings.TrimSpace(host))
	host = strings.TrimSuffix(host, ".")
	if !validHost(host) {
		return Remote{}, errors.New("remote host is invalid")
	}

	path = strings.TrimSpace(path)
	path = strings.TrimPrefix(path, "/")
	path = strings.TrimSuffix(path, "/")
	if path == "" {
		return Remote{}, errors.New("remote repository path is required")
	}
	parts := strings.Split(path, "/")
	if len(parts) != 2 {
		return Remote{}, errors.New("remote must identify exactly one owner and repository")
	}
	owner, repo := parts[0], parts[1]
	if strings.HasSuffix(repo, ".git") {
		repo = strings.TrimSuffix(repo, ".git")
	}
	if !validRemotePart(owner) || !validRemotePart(repo) {
		return Remote{}, errors.New("remote owner or repository is invalid")
	}
	if owner == "." || owner == ".." || repo == "." || repo == ".." {
		return Remote{}, errors.New("remote owner or repository is invalid")
	}

	htmlURL := "https://" + host + "/" + owner + "/" + repo
	apiURL := "https://api." + host + "/repos/" + owner + "/" + repo
	if host == "github.com" {
		apiURL = "https://api.github.com/repos/" + owner + "/" + repo
	}
	return Remote{
		URL:        sanitizedRemoteURL(raw),
		Host:       host,
		Owner:      owner,
		Repository: repo,
		Repo:       repo,
		HTMLURL:    htmlURL,
		APIURL:     apiURL,
	}, nil
}

// ParseGitHubRemote is an explicit alias for callers that want to document
// the expected provider in their code. Enterprise hosts remain parseable;
// callers can enforce a host policy after inspecting Remote.Host.
func ParseGitHubRemote(raw string) (Remote, error) {
	return ParseRemote(raw)
}

func validRemotePart(value string) bool {
	if value == "" || len(value) > 255 {
		return false
	}
	return remotePartPattern.MatchString(value) && !strings.Contains(value, "..")
}

func splitRemote(raw string) (host, path string, err error) {
	// SCP-like syntax: git@github.com:owner/repo.git. A colon in a local
	// Windows path is intentionally not accepted because it has no host.
	if !strings.Contains(raw, "://") {
		at := strings.LastIndexByte(raw, '@')
		colon := strings.IndexByte(raw, ':')
		if colon > 0 && at >= 0 && at < colon {
			user := raw[:at]
			if user == "" || strings.ContainsAny(user, "/\\\r\n\x00") {
				return "", "", errors.New("remote user is invalid")
			}
			return raw[at+1 : colon], raw[colon+1:], nil
		}
		return "", "", errors.New("remote URL scheme is unsupported")
	}

	u, parseErr := url.Parse(raw)
	if parseErr != nil {
		return "", "", fmt.Errorf("invalid remote URL: %w", parseErr)
	}
	if u.User == nil || u.User.Username() == "" {
		// HTTPS remotes commonly omit user info; SSH URLs generally include it,
		// but accepting both keeps parsing compatible with git's output.
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "https" && scheme != "http" && scheme != "ssh" && scheme != "git" {
		return "", "", errors.New("remote URL scheme is unsupported")
	}
	if u.Hostname() == "" {
		return "", "", errors.New("remote host is required")
	}
	if !validHost(u.Hostname()) {
		return "", "", errors.New("remote host is invalid")
	}
	if u.RawQuery != "" || u.Fragment != "" {
		return "", "", errors.New("remote URL must not contain query or fragment")
	}
	if port := u.Port(); port != "" {
		parsedPort, portErr := strconv.Atoi(port)
		if portErr != nil || parsedPort < 1 || parsedPort > 65535 {
			return "", "", errors.New("remote port is invalid")
		}
	}
	return u.Hostname(), u.EscapedPath(), nil
}

func validHost(host string) bool {
	host = strings.TrimSpace(host)
	if host == "" || len(host) > 253 || strings.ContainsAny(host, "/\\\r\n\x00@") {
		return false
	}
	if net.ParseIP(host) != nil {
		return true
	}
	for _, label := range strings.Split(host, ".") {
		if label == "" || len(label) > 63 || strings.HasPrefix(label, "-") || strings.HasSuffix(label, "-") {
			return false
		}
		for _, r := range label {
			if (r < 'a' || r > 'z') && (r < 'A' || r > 'Z') && (r < '0' || r > '9') && r != '-' {
				return false
			}
		}
	}
	return true
}

func sanitizedRemoteURL(raw string) string {
	if strings.Contains(raw, "://") {
		if parsed, err := url.Parse(raw); err == nil {
			parsed.User = nil
			return parsed.String()
		}
	}
	// SCP-like remotes have no standard password field, but avoid echoing a
	// potentially embedded user:password prefix if one was supplied.
	if at := strings.LastIndexByte(raw, '@'); at >= 0 {
		prefix := raw[:at]
		if strings.Contains(prefix, ":") {
			return raw[at+1:]
		}
	}
	return raw
}
