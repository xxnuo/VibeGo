package tls

import (
	"net"
	"os"
	"path/filepath"
	"testing"
)

func TestEnsureCertCreatesStableCAAndSignedServerCertificate(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	certFile, _, caCertFile, err := EnsureCert(dir)
	if err != nil {
		t.Fatalf("EnsureCert: %v", err)
	}

	cert, err := readCertificate(certFile)
	if err != nil {
		t.Fatalf("read server certificate: %v", err)
	}
	caCert, err := readCertificate(caCertFile)
	if err != nil {
		t.Fatalf("read CA certificate: %v", err)
	}
	if !caCert.IsCA {
		t.Fatal("expected trust certificate to be a CA")
	}
	if err := cert.CheckSignatureFrom(caCert); err != nil {
		t.Fatalf("server certificate is not signed by CA: %v", err)
	}
	if !certCoversLocalIPs(cert) {
		t.Fatal("expected server certificate to cover local IP addresses")
	}

	caBefore, err := os.ReadFile(caCertFile)
	if err != nil {
		t.Fatalf("read CA before regeneration: %v", err)
	}
	if err := os.Remove(certFile); err != nil {
		t.Fatalf("remove server certificate: %v", err)
	}
	if _, _, _, err := EnsureCert(dir); err != nil {
		t.Fatalf("EnsureCert after server certificate removal: %v", err)
	}
	caAfter, err := os.ReadFile(caCertFile)
	if err != nil {
		t.Fatalf("read CA after regeneration: %v", err)
	}
	if string(caAfter) != string(caBefore) {
		t.Fatal("CA certificate changed while regenerating server certificate")
	}
}

func TestEnsureCertRegeneratesServerCertificateWithoutReplacingCA(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	caCertFile := filepath.Join(dir, "ca-cert.pem")
	caKeyFile := filepath.Join(dir, "ca-key.pem")
	certFile := filepath.Join(dir, "server-cert.pem")
	keyFile := filepath.Join(dir, "server-key.pem")
	caCert, caKey, err := ensureCA(caCertFile, caKeyFile)
	if err != nil {
		t.Fatalf("ensureCA: %v", err)
	}
	if err := generateServerCertificate(certFile, keyFile, caCert, caKey, []net.IP{net.ParseIP("127.0.0.1")}); err != nil {
		t.Fatalf("generateServerCertificate: %v", err)
	}
	before, err := readCertificate(certFile)
	if err != nil {
		t.Fatalf("read certificate before regeneration: %v", err)
	}
	caBefore, err := os.ReadFile(caCertFile)
	if err != nil {
		t.Fatalf("read CA before regeneration: %v", err)
	}

	if _, _, _, err := EnsureCert(dir); err != nil {
		t.Fatalf("EnsureCert: %v", err)
	}
	after, err := readCertificate(certFile)
	if err != nil {
		t.Fatalf("read certificate after regeneration: %v", err)
	}
	if before.SerialNumber.Cmp(after.SerialNumber) == 0 {
		t.Fatal("expected server certificate to be regenerated when an IP is missing")
	}
	if !certCoversLocalIPs(after) {
		t.Fatal("expected regenerated certificate to cover local IP addresses")
	}
	caAfter, err := os.ReadFile(caCertFile)
	if err != nil {
		t.Fatalf("read CA after regeneration: %v", err)
	}
	if string(caAfter) != string(caBefore) {
		t.Fatal("CA certificate changed while rotating server certificate")
	}
}

func TestEnsureCertMigratesLegacyServerFiles(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	certFile, keyFile, _, err := EnsureCert(dir)
	if err != nil {
		t.Fatalf("EnsureCert: %v", err)
	}
	legacyCert := filepath.Join(dir, "cert.pem")
	legacyKey := filepath.Join(dir, "key.pem")
	if err := os.Rename(certFile, legacyCert); err != nil {
		t.Fatalf("rename legacy certificate: %v", err)
	}
	if err := os.Rename(keyFile, legacyKey); err != nil {
		t.Fatalf("rename legacy key: %v", err)
	}

	newCert, newKey, _, err := EnsureCert(dir)
	if err != nil {
		t.Fatalf("EnsureCert after migration: %v", err)
	}
	if newCert != certFile || newKey != keyFile {
		t.Fatalf("paths = %q, %q; want %q, %q", newCert, newKey, certFile, keyFile)
	}
	if !fileExists(certFile) || !fileExists(keyFile) {
		t.Fatal("expected server certificate files after migration")
	}
	if fileExists(legacyCert) || fileExists(legacyKey) {
		t.Fatal("legacy server certificate files were not moved")
	}
}
