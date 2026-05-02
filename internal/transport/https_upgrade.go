package transport

import (
	"encoding/pem"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"path"
	"strings"
)

const CertificateDownloadPath = "/vibego.crt"

type HTTPSUpgradeHandlerConfig struct {
	DistFS          fs.FS
	Fallback        http.Handler
	UpgradePagePath string
	Certificate     []byte
}

type httpsUpgradeHandler struct {
	distFS          fs.FS
	fallback        http.Handler
	fileServer      http.Handler
	upgradePagePath string
	certificate     []byte
}

func NewHTTPSUpgradeHandler(cfg HTTPSUpgradeHandlerConfig) (http.Handler, error) {
	upgradePagePath := strings.TrimPrefix(strings.TrimSpace(cfg.UpgradePagePath), "/")
	if upgradePagePath == "" {
		upgradePagePath = "http-upgrade.html"
	}

	if _, err := fs.Stat(cfg.DistFS, upgradePagePath); err != nil {
		return nil, err
	}

	certificate := cfg.Certificate
	if block, _ := pem.Decode(certificate); block != nil && block.Type == "CERTIFICATE" {
		certificate = block.Bytes
	}

	return &httpsUpgradeHandler{
		distFS:          cfg.DistFS,
		fallback:        cfg.Fallback,
		fileServer:      http.FileServer(http.FS(cfg.DistFS)),
		upgradePagePath: upgradePagePath,
		certificate:     certificate,
	}, nil
}

func (h *httpsUpgradeHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h.shouldServeFallback(r) {
		h.fallback.ServeHTTP(w, r)
		return
	}
	if r.URL.Path == CertificateDownloadPath {
		h.serveCertificate(w, r)
		return
	}

	if shouldServeStaticFile(h.distFS, r.URL.Path) {
		h.fileServer.ServeHTTP(w, r)
		return
	}

	target := buildHTTPSRedirectURL(r)
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Redirect(w, r, target, http.StatusTemporaryRedirect)
		return
	}
	if !wantsHTML(r) {
		http.Redirect(w, r, target, http.StatusTemporaryRedirect)
		return
	}

	req := cloneRequestWithPath(r, "/"+h.upgradePagePath)
	w.Header().Set("Cache-Control", "no-store")
	h.fileServer.ServeHTTP(w, req)
}

func (h *httpsUpgradeHandler) serveCertificate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, http.StatusText(http.StatusMethodNotAllowed), http.StatusMethodNotAllowed)
		return
	}
	if len(h.certificate) == 0 {
		http.NotFound(w, r)
		return
	}

	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Disposition", `attachment; filename="vibego.crt"`)
	w.Header().Set("Content-Type", "application/x-x509-ca-cert")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Length", fmt.Sprint(len(h.certificate)))
	w.WriteHeader(http.StatusOK)
	if r.Method == http.MethodGet {
		_, _ = w.Write(h.certificate)
	}
}

func (h *httpsUpgradeHandler) shouldServeFallback(r *http.Request) bool {
	if h.fallback == nil {
		return false
	}
	if forwardedProto(r) != "https" {
		return false
	}
	return isTrustedProxyAddr(r.RemoteAddr)
}

func shouldServeStaticFile(distFS fs.FS, requestPath string) bool {
	cleanPath := path.Clean("/" + requestPath)
	if cleanPath == "/" {
		return false
	}

	filePath := strings.TrimPrefix(cleanPath, "/")
	info, err := fs.Stat(distFS, filePath)
	if err != nil {
		return false
	}

	return !info.IsDir()
}

func cloneRequestWithPath(r *http.Request, requestPath string) *http.Request {
	req := r.Clone(r.Context())
	clonedURL := *r.URL
	clonedURL.Path = requestPath
	clonedURL.RawPath = ""
	req.URL = &clonedURL
	req.RequestURI = req.URL.RequestURI()
	return req
}

func buildHTTPSRedirectURL(r *http.Request) string {
	target := &url.URL{
		Scheme:   "https",
		Host:     r.Host,
		Path:     r.URL.Path,
		RawPath:  r.URL.RawPath,
		RawQuery: r.URL.RawQuery,
	}
	return target.String()
}

func wantsHTML(r *http.Request) bool {
	accept := strings.ToLower(r.Header.Get("Accept"))
	return accept == "" || strings.Contains(accept, "text/html")
}

func forwardedProto(r *http.Request) string {
	if proto := forwardedHeaderProto(r.Header.Values("Forwarded")); proto != "" {
		return proto
	}

	for _, value := range r.Header.Values("X-Forwarded-Proto") {
		if proto := firstForwardedListValue(value); proto != "" {
			return proto
		}
	}

	return ""
}

func forwardedHeaderProto(values []string) string {
	for _, value := range values {
		for _, segment := range strings.Split(value, ",") {
			parts := strings.Split(segment, ";")
			for _, part := range parts {
				part = strings.TrimSpace(part)
				if len(part) < 6 || !strings.EqualFold(part[:6], "proto=") {
					continue
				}
				proto := strings.TrimSpace(part[6:])
				proto = strings.Trim(proto, "\"")
				proto = strings.ToLower(proto)
				if proto != "" {
					return proto
				}
			}
		}
	}

	return ""
}

func firstForwardedListValue(value string) string {
	for _, part := range strings.Split(value, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		return strings.ToLower(part)
	}
	return ""
}

func isTrustedProxyAddr(remoteAddr string) bool {
	ip := parseRemoteIP(remoteAddr)
	if ip == nil {
		return false
	}
	return isPrivateIP(ip)
}

func parseRemoteIP(remoteAddr string) net.IP {
	host := strings.TrimSpace(remoteAddr)
	if host == "" {
		return nil
	}
	if parsedHost, _, err := net.SplitHostPort(host); err == nil {
		host = parsedHost
	}
	return net.ParseIP(host)
}

var privateIPBlocks = mustParseCIDRs(
	"10.0.0.0/8",
	"172.16.0.0/12",
	"192.168.0.0/16",
	"fc00::/7",
	"fe80::/10",
)

func mustParseCIDRs(cidrs ...string) []*net.IPNet {
	blocks := make([]*net.IPNet, 0, len(cidrs))
	for _, cidr := range cidrs {
		_, block, err := net.ParseCIDR(cidr)
		if err == nil {
			blocks = append(blocks, block)
		}
	}
	return blocks
}

func isPrivateIP(ip net.IP) bool {
	if ip.IsLoopback() {
		return true
	}
	for _, block := range privateIPBlocks {
		if block.Contains(ip) {
			return true
		}
	}
	return false
}
