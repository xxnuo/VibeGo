package transport

import (
	"encoding/pem"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

func TestHTTPSUpgradeHandlerServesCertificate(t *testing.T) {
	t.Parallel()

	certificate := []byte("certificate-der")
	handler, err := NewHTTPSUpgradeHandler(HTTPSUpgradeHandlerConfig{
		DistFS: fstest.MapFS{
			"http-upgrade.html": {Data: []byte("<!doctype html>")},
		},
		Certificate: pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certificate}),
	})
	if err != nil {
		t.Fatalf("NewHTTPSUpgradeHandler: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "http://example.com:1984"+CertificateDownloadPath, nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	res := rec.Result()
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want %d", res.StatusCode, http.StatusOK)
	}
	if contentType := res.Header.Get("Content-Type"); contentType != "application/x-x509-ca-cert" {
		t.Fatalf("Content-Type = %q", contentType)
	}
	if disposition := res.Header.Get("Content-Disposition"); disposition != `attachment; filename="vibego.crt"` {
		t.Fatalf("Content-Disposition = %q", disposition)
	}
	body, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	if string(body) != string(certificate) {
		t.Fatalf("body = %q, want certificate DER", body)
	}
}

func TestHTTPSUpgradeHandlerServesUpgradePageForHTMLRequests(t *testing.T) {
	t.Parallel()

	handler, err := NewHTTPSUpgradeHandler(HTTPSUpgradeHandlerConfig{
		DistFS: fstest.MapFS{
			"http-upgrade.html": {Data: []byte("<!doctype html><title>upgrade</title>")},
			"assets/app.js":     {Data: []byte("console.log('ok')")},
		},
	})
	if err != nil {
		t.Fatalf("NewHTTPSUpgradeHandler: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "http://example.com:1984/tools/keyboard?tab=voice", nil)
	req.Header.Set("Accept", "text/html")

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	res := rec.Result()
	defer res.Body.Close()

	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want %d", res.StatusCode, http.StatusOK)
	}
	if cacheControl := res.Header.Get("Cache-Control"); cacheControl != "no-store" {
		t.Fatalf("Cache-Control = %q, want %q", cacheControl, "no-store")
	}

	body, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	if !strings.Contains(string(body), "<title>upgrade</title>") {
		t.Fatalf("body does not contain upgrade page: %s", string(body))
	}
}

func TestHTTPSUpgradeHandlerServesStaticAssets(t *testing.T) {
	t.Parallel()

	handler, err := NewHTTPSUpgradeHandler(HTTPSUpgradeHandlerConfig{
		DistFS: fstest.MapFS{
			"http-upgrade.html":   {Data: []byte("<!doctype html>")},
			"assets/upgrade.js":   {Data: []byte("console.log('asset')")},
			"icons/icon@32px.png": {Data: []byte("png")},
		},
	})
	if err != nil {
		t.Fatalf("NewHTTPSUpgradeHandler: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "http://example.com:1984/assets/upgrade.js", nil)

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	res := rec.Result()
	defer res.Body.Close()

	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want %d", res.StatusCode, http.StatusOK)
	}

	body, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	if string(body) != "console.log('asset')" {
		t.Fatalf("body = %q, want %q", string(body), "console.log('asset')")
	}
}

func TestHTTPSUpgradeHandlerRedirectsNonHTMLRequests(t *testing.T) {
	t.Parallel()

	handler, err := NewHTTPSUpgradeHandler(HTTPSUpgradeHandlerConfig{
		DistFS: fstest.MapFS{
			"http-upgrade.html": {Data: []byte("<!doctype html>")},
		},
	})
	if err != nil {
		t.Fatalf("NewHTTPSUpgradeHandler: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:1984/api/settings", nil)
	req.Header.Set("Accept", "application/json")

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	res := rec.Result()
	defer res.Body.Close()

	if res.StatusCode != http.StatusTemporaryRedirect {
		t.Fatalf("status = %d, want %d", res.StatusCode, http.StatusTemporaryRedirect)
	}
	if location := res.Header.Get("Location"); location != "https://127.0.0.1:1984/api/settings" {
		t.Fatalf("location = %q, want %q", location, "https://127.0.0.1:1984/api/settings")
	}
}

func TestHTTPSUpgradeHandlerServesFallbackForTrustedProxyHTTPS(t *testing.T) {
	t.Parallel()

	fallbackHit := false
	handler, err := NewHTTPSUpgradeHandler(HTTPSUpgradeHandlerConfig{
		DistFS: fstest.MapFS{
			"http-upgrade.html": {Data: []byte("<!doctype html><title>upgrade</title>")},
		},
		Fallback: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			fallbackHit = true
			w.WriteHeader(http.StatusNoContent)
		}),
	})
	if err != nil {
		t.Fatalf("NewHTTPSUpgradeHandler: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "http://xxx.com/api/settings", nil)
	req.RemoteAddr = "127.0.0.1:54321"
	req.Header.Set("X-Forwarded-Proto", "https")

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	res := rec.Result()
	defer res.Body.Close()

	if !fallbackHit {
		t.Fatal("fallback handler was not called")
	}
	if res.StatusCode != http.StatusNoContent {
		t.Fatalf("status = %d, want %d", res.StatusCode, http.StatusNoContent)
	}
}

func TestHTTPSUpgradeHandlerServesFallbackForTrustedProxyForwardedHTTPS(t *testing.T) {
	t.Parallel()

	fallbackHit := false
	handler, err := NewHTTPSUpgradeHandler(HTTPSUpgradeHandlerConfig{
		DistFS: fstest.MapFS{
			"http-upgrade.html": {Data: []byte("<!doctype html><title>upgrade</title>")},
		},
		Fallback: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			fallbackHit = true
			w.WriteHeader(http.StatusNoContent)
		}),
	})
	if err != nil {
		t.Fatalf("NewHTTPSUpgradeHandler: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "http://xxx.com/api/settings", nil)
	req.RemoteAddr = "192.168.1.10:54321"
	req.Header.Set("Forwarded", "for=203.0.113.10;proto=https;host=xxx.com")

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	res := rec.Result()
	defer res.Body.Close()

	if !fallbackHit {
		t.Fatal("fallback handler was not called")
	}
	if res.StatusCode != http.StatusNoContent {
		t.Fatalf("status = %d, want %d", res.StatusCode, http.StatusNoContent)
	}
}

func TestHTTPSUpgradeHandlerDoesNotTrustForwardedProtoFromPublicClient(t *testing.T) {
	t.Parallel()

	fallbackHit := false
	handler, err := NewHTTPSUpgradeHandler(HTTPSUpgradeHandlerConfig{
		DistFS: fstest.MapFS{
			"http-upgrade.html": {Data: []byte("<!doctype html>")},
		},
		Fallback: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			fallbackHit = true
			w.WriteHeader(http.StatusNoContent)
		}),
	})
	if err != nil {
		t.Fatalf("NewHTTPSUpgradeHandler: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "http://xxx.com/api/settings", nil)
	req.RemoteAddr = "8.8.8.8:54321"
	req.Header.Set("X-Forwarded-Proto", "https")
	req.Header.Set("Accept", "application/json")

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	res := rec.Result()
	defer res.Body.Close()

	if fallbackHit {
		t.Fatal("fallback handler should not be called")
	}
	if res.StatusCode != http.StatusTemporaryRedirect {
		t.Fatalf("status = %d, want %d", res.StatusCode, http.StatusTemporaryRedirect)
	}
	if location := res.Header.Get("Location"); location != "https://xxx.com/api/settings" {
		t.Fatalf("location = %q, want %q", location, "https://xxx.com/api/settings")
	}
}
