package tls

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	cryptotls "crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"slices"
	"time"
)

func EnsureCert(configDir string) (certFile, keyFile, caCertFile string, err error) {
	certFile = filepath.Join(configDir, "server-cert.pem")
	keyFile = filepath.Join(configDir, "server-key.pem")
	caCertFile = filepath.Join(configDir, "ca-cert.pem")
	caKeyFile := filepath.Join(configDir, "ca-key.pem")
	if err := migrateLegacyFile(filepath.Join(configDir, "cert.pem"), certFile); err != nil {
		return "", "", "", err
	}
	if err := migrateLegacyFile(filepath.Join(configDir, "key.pem"), keyFile); err != nil {
		return "", "", "", err
	}

	caCert, caKey, err := ensureCA(caCertFile, caKeyFile)
	if err != nil {
		return "", "", "", err
	}

	if fileExists(certFile) && fileExists(keyFile) {
		valid, certErr := isCertUsable(certFile, keyFile, caCert)
		if certErr == nil && valid {
			return
		}
	}

	err = generateCert(certFile, keyFile, caCert, caKey)
	return
}

func ensureCA(certFile, keyFile string) (*x509.Certificate, *ecdsa.PrivateKey, error) {
	if fileExists(certFile) && fileExists(keyFile) {
		cert, key, err := loadCertificateAndKey(certFile, keyFile)
		if err == nil && cert.IsCA && time.Now().Before(cert.NotAfter) {
			return cert, key, nil
		}
	}

	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, err
	}

	serialNumber, err := randomSerialNumber()
	if err != nil {
		return nil, nil, err
	}

	template := x509.Certificate{
		SerialNumber: serialNumber,
		Subject: pkix.Name{
			Organization: []string{"VibeGo"},
			CommonName:   "VibeGo Local CA",
		},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(10 * 365 * 24 * time.Hour),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		BasicConstraintsValid: true,
		IsCA:                  true,
		MaxPathLenZero:        true,
	}

	certDER, err := x509.CreateCertificate(rand.Reader, &template, &template, &key.PublicKey, key)
	if err != nil {
		return nil, nil, err
	}
	if err := writeCertificateAndKey(certFile, keyFile, certDER, key); err != nil {
		return nil, nil, err
	}

	cert, err := x509.ParseCertificate(certDER)
	return cert, key, err
}

func generateCert(certFile, keyFile string, caCert *x509.Certificate, caKey *ecdsa.PrivateKey) error {
	ips := collectLocalIPs()
	ips = append(ips, net.ParseIP("127.0.0.1"), net.ParseIP("::1"))
	return generateServerCertificate(certFile, keyFile, caCert, caKey, ips)
}

func generateServerCertificate(certFile, keyFile string, caCert *x509.Certificate, caKey *ecdsa.PrivateKey, ips []net.IP) error {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}

	serialNumber, err := randomSerialNumber()
	if err != nil {
		return err
	}

	template := x509.Certificate{
		SerialNumber: serialNumber,
		Subject: pkix.Name{
			Organization: []string{"VibeGo"},
			CommonName:   "localhost",
		},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(825 * 24 * time.Hour),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		DNSNames:              []string{"localhost"},
		IPAddresses:           ips,
	}

	if template.NotAfter.After(caCert.NotAfter) {
		template.NotAfter = caCert.NotAfter
	}

	certDER, err := x509.CreateCertificate(rand.Reader, &template, caCert, &key.PublicKey, caKey)
	if err != nil {
		return err
	}
	return writeCertificateAndKey(certFile, keyFile, certDER, key)
}

func randomSerialNumber() (*big.Int, error) {
	return rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
}

func writeCertificateAndKey(certFile, keyFile string, certDER []byte, key *ecdsa.PrivateKey) error {
	if err := os.MkdirAll(filepath.Dir(certFile), 0700); err != nil {
		return err
	}
	if err := os.WriteFile(certFile, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certDER}), 0600); err != nil {
		return err
	}

	keyBytes, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return err
	}
	return os.WriteFile(keyFile, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyBytes}), 0600)
}

func collectLocalIPs() []net.IP {
	seen := make(map[string]struct{})
	var ips []net.IP
	ifaces, err := net.Interfaces()
	if err != nil {
		return ips
	}
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 {
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
			if ip == nil {
				continue
			}
			ip = normalizeIP(ip)
			if ip == nil {
				continue
			}
			key := ip.String()
			if _, ok := seen[key]; ok {
				continue
			}
			seen[key] = struct{}{}
			ips = append(ips, ip)
		}
	}
	slices.SortFunc(ips, func(a, b net.IP) int {
		return slices.Compare([]byte(a), []byte(b))
	})
	return ips
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func migrateLegacyFile(oldPath, newPath string) error {
	if fileExists(newPath) || !fileExists(oldPath) {
		return nil
	}
	return os.Rename(oldPath, newPath)
}

func loadCertificateAndKey(certFile, keyFile string) (*x509.Certificate, *ecdsa.PrivateKey, error) {
	pair, err := cryptotls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		return nil, nil, err
	}
	if len(pair.Certificate) == 0 {
		return nil, nil, errors.New("missing certificate")
	}
	cert, err := x509.ParseCertificate(pair.Certificate[0])
	if err != nil {
		return nil, nil, err
	}
	key, ok := pair.PrivateKey.(*ecdsa.PrivateKey)
	if !ok {
		return nil, nil, errors.New("certificate key is not ECDSA")
	}
	return cert, key, nil
}

func isCertUsable(certFile, keyFile string, caCert *x509.Certificate) (bool, error) {
	cert, _, err := loadCertificateAndKey(certFile, keyFile)
	if err != nil {
		return false, err
	}
	if time.Now().After(cert.NotAfter) {
		return false, nil
	}
	if err := cert.CheckSignatureFrom(caCert); err != nil {
		return false, nil
	}
	return certCoversLocalIPs(cert), nil
}

func readCertificate(certFile string) (*x509.Certificate, error) {
	data, err := os.ReadFile(certFile)
	if err != nil {
		return nil, err
	}
	block, _ := pem.Decode(data)
	if block == nil {
		return nil, errors.New("invalid pem")
	}
	return x509.ParseCertificate(block.Bytes)
}

func certCoversLocalIPs(cert *x509.Certificate) bool {
	expected := collectLocalIPs()
	for _, ip := range []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")} {
		ip = normalizeIP(ip)
		if ip != nil {
			expected = append(expected, ip)
		}
	}

	if len(expected) == 0 {
		return true
	}

	certIPs := make(map[string]struct{}, len(cert.IPAddresses))
	for _, ip := range cert.IPAddresses {
		ip = normalizeIP(ip)
		if ip == nil {
			continue
		}
		certIPs[ip.String()] = struct{}{}
	}

	for _, ip := range expected {
		if _, ok := certIPs[ip.String()]; !ok {
			return false
		}
	}
	return true
}

func normalizeIP(ip net.IP) net.IP {
	if ip == nil {
		return nil
	}
	if v4 := ip.To4(); v4 != nil {
		return v4
	}
	return ip.To16()
}
