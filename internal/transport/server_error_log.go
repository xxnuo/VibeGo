package transport

import (
	"io"
	"log"
	"strings"
)

type serverErrorLogFilter struct {
	output io.Writer
}

func NewServerErrorLog(output io.Writer) *log.Logger {
	return log.New(serverErrorLogFilter{output: output}, "", log.LstdFlags)
}

func (f serverErrorLogFilter) Write(p []byte) (int, error) {
	if shouldDropServerErrorLog(string(p)) {
		return len(p), nil
	}
	_, err := f.output.Write(p)
	if err != nil {
		return 0, err
	}
	return len(p), nil
}

func shouldDropServerErrorLog(message string) bool {
	return strings.Contains(message, "http: TLS handshake error") &&
		strings.Contains(message, "remote error: tls: unknown certificate")
}
