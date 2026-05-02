package blocktermmodel

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strings"
	"time"
)

func newHTTPClient(allowPrivate bool) *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.DialContext = safeDialContext(allowPrivate)
	return &http.Client{
		Transport: &modelHTTPTransport{base: transport, allowPrivate: allowPrivate},
		CheckRedirect: func(request *http.Request, via []*http.Request) error {
			if len(via) >= 3 {
				return errors.New("too many model upstream redirects")
			}
			if len(via) > 0 {
				if !strings.EqualFold(request.URL.Host, via[0].URL.Host) {
					return errors.New("model upstream cross-host redirect is not allowed")
				}
				previous := via[len(via)-1]
				if strings.EqualFold(previous.URL.Scheme, "https") && !strings.EqualFold(request.URL.Scheme, "https") {
					return errors.New("model upstream HTTPS downgrade is not allowed")
				}
			}
			return validateBaseURLContext(request.Context(), request.URL.String(), allowPrivate)
		},
	}
}

type modelHTTPTransport struct {
	base         http.RoundTripper
	allowPrivate bool
}

func (t *modelHTTPTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	if request != nil && request.URL != nil && strings.EqualFold(request.URL.Scheme, "http") {
		if err := validateBaseURLContext(request.Context(), request.URL.String(), t.allowPrivate); err != nil {
			return nil, err
		}
	}
	return t.base.RoundTrip(request)
}

func (t *modelHTTPTransport) CloseIdleConnections() {
	if closer, ok := t.base.(interface{ CloseIdleConnections() }); ok {
		closer.CloseIdleConnections()
	}
}

func safeDialContext(allowPrivate bool) func(context.Context, string, string) (net.Conn, error) {
	dialer := &net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}
	resolver := net.DefaultResolver
	return func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, err
		}
		if ip := net.ParseIP(host); ip != nil {
			if !allowPrivate && isPrivateOrLocalIP(ip) {
				return nil, errors.New("model upstream private or local address is not allowed")
			}
			return dialer.DialContext(ctx, network, address)
		}
		addresses, err := resolver.LookupIPAddr(ctx, host)
		if err != nil || len(addresses) == 0 {
			return nil, fmt.Errorf("resolve model upstream: %w", err)
		}
		for _, resolved := range addresses {
			if !allowPrivate && isPrivateOrLocalIP(resolved.IP) {
				return nil, errors.New("model upstream resolves to a private or local address")
			}
		}
		var dialErr error
		for _, resolved := range addresses {
			connection, err := dialer.DialContext(ctx, network, net.JoinHostPort(resolved.IP.String(), port))
			if err == nil {
				return connection, nil
			}
			dialErr = err
		}
		return nil, dialErr
	}
}
