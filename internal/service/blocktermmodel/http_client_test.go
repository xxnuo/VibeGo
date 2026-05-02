package blocktermmodel

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestHTTPClientRejectsHTTPSDowngradeBeforeForwardingAuthorization(t *testing.T) {
	requestCount := 0
	receivedAuthorization := ""
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestCount++
		receivedAuthorization = r.Header.Get("Authorization")
		w.Header().Set("Location", "http://"+r.Host+"/downgraded")
		w.WriteHeader(http.StatusFound)
	}))
	defer server.Close()

	client := newHTTPClient(true)
	transport := client.Transport.(*modelHTTPTransport).base.(*http.Transport)
	serverTransport := server.Client().Transport.(*http.Transport)
	transport.TLSClientConfig = serverTransport.TLSClientConfig.Clone()

	request, err := http.NewRequest(http.MethodGet, server.URL+"/start", nil)
	require.NoError(t, err)
	request.Header.Set("Authorization", "Bearer secret-token")
	response, err := client.Do(request)
	if response != nil {
		response.Body.Close()
	}
	require.ErrorContains(t, err, "HTTPS downgrade is not allowed")
	require.Equal(t, 1, requestCount)
	require.Equal(t, "Bearer secret-token", receivedAuthorization)
}

func TestHTTPTransportRejectsDirectPublicHTTPBeforeSendingAuthorization(t *testing.T) {
	called := false
	transport := &modelHTTPTransport{
		allowPrivate: true,
		base: roundTripperFunc(func(*http.Request) (*http.Response, error) {
			called = true
			return &http.Response{
				StatusCode: http.StatusOK,
				Body:       io.NopCloser(strings.NewReader("ok")),
				Header:     make(http.Header),
			}, nil
		}),
	}
	request, err := http.NewRequest(http.MethodGet, "http://1.1.1.1/v1/chat/completions", nil)
	require.NoError(t, err)
	request.Header.Set("Authorization", "Bearer secret-token")

	_, err = transport.RoundTrip(request)
	require.ErrorContains(t, err, "only to private or local addresses")
	require.False(t, called)
}

func TestHTTPTransportAllowsExplicitPrivateHTTPAuthorization(t *testing.T) {
	called := false
	transport := &modelHTTPTransport{
		allowPrivate: true,
		base: roundTripperFunc(func(request *http.Request) (*http.Response, error) {
			called = true
			require.Equal(t, "Bearer local-token", request.Header.Get("Authorization"))
			return &http.Response{
				StatusCode: http.StatusOK,
				Body:       io.NopCloser(strings.NewReader("ok")),
				Header:     make(http.Header),
			}, nil
		}),
	}
	request, err := http.NewRequest(http.MethodGet, "http://127.0.0.1:11434/v1/chat/completions", nil)
	require.NoError(t, err)
	request.Header.Set("Authorization", "Bearer local-token")

	response, err := transport.RoundTrip(request)
	require.NoError(t, err)
	response.Body.Close()
	require.True(t, called)
}

func TestHTTPClientRejectsDowngradeAfterHTTPUpgrade(t *testing.T) {
	client := newHTTPClient(true)
	original, err := http.NewRequest(http.MethodGet, "http://127.0.0.1:11434/start", nil)
	require.NoError(t, err)
	secure, err := http.NewRequest(http.MethodGet, "https://127.0.0.1:11434/secure", nil)
	require.NoError(t, err)
	downgraded, err := http.NewRequest(http.MethodGet, "http://127.0.0.1:11434/downgraded", nil)
	require.NoError(t, err)

	err = client.CheckRedirect(downgraded, []*http.Request{original, secure})
	require.Error(t, err)
	require.True(t, strings.Contains(err.Error(), "HTTPS downgrade"))
}

func TestHTTPClientAllowsSameSchemeSameHostRedirects(t *testing.T) {
	privateClient := newHTTPClient(true)
	privateOrigin, err := http.NewRequest(http.MethodGet, "http://127.0.0.1:11434/start", nil)
	require.NoError(t, err)
	privateTarget, err := http.NewRequest(http.MethodGet, "http://127.0.0.1:11434/next", nil)
	require.NoError(t, err)
	require.NoError(t, privateClient.CheckRedirect(privateTarget, []*http.Request{privateOrigin}))

	publicClient := newHTTPClient(false)
	publicOrigin, err := http.NewRequest(http.MethodGet, "https://1.1.1.1/start", nil)
	require.NoError(t, err)
	publicTarget, err := http.NewRequest(http.MethodGet, "https://1.1.1.1/next", nil)
	require.NoError(t, err)
	require.NoError(t, publicClient.CheckRedirect(publicTarget, []*http.Request{publicOrigin}))
}

func TestHTTPClientRejectsCrossHostRedirect(t *testing.T) {
	client := newHTTPClient(false)
	original, err := http.NewRequest(http.MethodGet, "https://1.1.1.1/start", nil)
	require.NoError(t, err)
	target, err := http.NewRequest(http.MethodGet, "https://8.8.8.8/next", nil)
	require.NoError(t, err)

	err = client.CheckRedirect(target, []*http.Request{original})
	require.ErrorContains(t, err, "cross-host redirect")
}

func TestHTTPClientRedirectValidationHonorsCancellation(t *testing.T) {
	client := newHTTPClient(false)
	original, err := http.NewRequest(http.MethodGet, "https://provider.invalid/start", nil)
	require.NoError(t, err)
	request, err := http.NewRequest(http.MethodGet, "https://provider.invalid/next", nil)
	require.NoError(t, err)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	request = request.WithContext(ctx)

	err = client.CheckRedirect(request, []*http.Request{original})
	require.Error(t, err)
	require.ErrorIs(t, err, context.Canceled)
}

type roundTripperFunc func(*http.Request) (*http.Response, error)

func (fn roundTripperFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return fn(request)
}
