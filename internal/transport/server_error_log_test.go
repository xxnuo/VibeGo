package transport

import (
	"bytes"
	"testing"
)

func TestServerErrorLogDropsUnknownCertificateHandshake(t *testing.T) {
	var out bytes.Buffer
	logger := NewServerErrorLog(&out)

	logger.Print("http: TLS handshake error from [::1]:58080: remote error: tls: unknown certificate")

	if out.Len() != 0 {
		t.Fatalf("expected unknown certificate handshake log to be dropped, got %q", out.String())
	}
}

func TestServerErrorLogKeepsOtherErrors(t *testing.T) {
	var out bytes.Buffer
	logger := NewServerErrorLog(&out)

	logger.Print("http: TLS handshake error from [::1]:58080: EOF")

	if !bytes.Contains(out.Bytes(), []byte("EOF")) {
		t.Fatalf("expected non-filtered log to be kept, got %q", out.String())
	}
}
