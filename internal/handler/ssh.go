package handler

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/xxnuo/vibego/internal/model"
	"github.com/xxnuo/vibego/internal/service/sshconnection"
	"github.com/xxnuo/vibego/internal/service/terminal"
)

const (
	sshProfileRequestMaxBody = 64 * 1024
	sshSecretRequestMaxBody  = 2 * 1024 * 1024
)

type SSHHandler struct {
	service *sshconnection.Service
}

func NewSSHHandler(service *sshconnection.Service) *SSHHandler {
	return &SSHHandler{service: service}
}

func (h *SSHHandler) Register(r *gin.RouterGroup) {
	g := r.Group("/ssh")
	g.GET("/profiles", h.ListProfiles)
	g.POST("/profiles", h.CreateProfile)
	g.PATCH("/profiles/:id", h.UpdateProfile)
	g.DELETE("/profiles/:id", h.DeleteProfile)
	g.DELETE("/profiles/:id/known-host", h.ResetKnownHost)
	g.POST("/profiles/:id/connect", h.Connect)
	g.POST("/profiles/:id/disconnect", h.Disconnect)
	g.POST("/host-key-challenges/:id/confirm", h.ConfirmHostKey)
}

type sshProfileRequest struct {
	Name           string `json:"name"`
	Host           string `json:"host"`
	Port           int    `json:"port"`
	User           string `json:"user"`
	AuthMethod     string `json:"auth_method"`
	IdentityFile   string `json:"identity_file"`
	ConnectTimeout int    `json:"connect_timeout"`
}

type sshProfilePatchRequest struct {
	Name           *string `json:"name"`
	Host           *string `json:"host"`
	Port           *int    `json:"port"`
	User           *string `json:"user"`
	AuthMethod     *string `json:"auth_method"`
	IdentityFile   *string `json:"identity_file"`
	ConnectTimeout *int    `json:"connect_timeout"`
}

type sshAuthRequest struct {
	Password   string `json:"password"`
	PrivateKey string `json:"private_key"`
	Passphrase string `json:"passphrase"`
}

func (r sshAuthRequest) secrets() terminal.SSHAuthSecrets {
	return terminal.SSHAuthSecrets{
		Password:   r.Password,
		PrivateKey: r.PrivateKey,
		Passphrase: r.Passphrase,
	}
}

type sshConnectRequest struct {
	Auth sshAuthRequest `json:"auth"`
}

type sshResetKnownHostRequest struct {
	ExpectedFingerprint string `json:"expected_fingerprint"`
}

type sshProfileResponse struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	Host           string `json:"host"`
	Port           int    `json:"port"`
	User           string `json:"user"`
	AuthMethod     string `json:"auth_method"`
	IdentityFile   string `json:"identity_file,omitempty"`
	ConnectTimeout int    `json:"connect_timeout"`
	Connected      bool   `json:"connected"`
	CreatedAt      int64  `json:"created_at"`
	UpdatedAt      int64  `json:"updated_at"`
}

func (h *SSHHandler) profileResponse(profile model.SSHConnectionProfile) sshProfileResponse {
	return sshProfileResponse{
		ID:             profile.ID,
		Name:           profile.Name,
		Host:           profile.Host,
		Port:           profile.Port,
		User:           profile.User,
		AuthMethod:     profile.AuthMethod,
		IdentityFile:   profile.IdentityFile,
		ConnectTimeout: profile.ConnectTimeout,
		Connected:      h.service.IsConnected(profile.ID),
		CreatedAt:      profile.CreatedAt,
		UpdatedAt:      profile.UpdatedAt,
	}
}

func (h *SSHHandler) ListProfiles(c *gin.Context) {
	profiles, err := h.service.ListProfiles()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	result := make([]sshProfileResponse, 0, len(profiles))
	for _, profile := range profiles {
		result = append(result, h.profileResponse(profile))
	}
	c.JSON(http.StatusOK, gin.H{"profiles": result})
}

func (h *SSHHandler) CreateProfile(c *gin.Context) {
	var req sshProfileRequest
	if !bindLimitedJSON(c, &req, sshProfileRequestMaxBody) {
		return
	}
	profile, err := h.service.CreateProfile(sshconnection.ProfileInput{
		Name:           req.Name,
		Host:           req.Host,
		Port:           req.Port,
		User:           req.User,
		AuthMethod:     req.AuthMethod,
		IdentityFile:   req.IdentityFile,
		ConnectTimeout: req.ConnectTimeout,
	})
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, gin.H{"profile": h.profileResponse(*profile)})
}

func (h *SSHHandler) UpdateProfile(c *gin.Context) {
	var req sshProfilePatchRequest
	if !bindLimitedJSON(c, &req, sshProfileRequestMaxBody) {
		return
	}
	profile, err := h.service.UpdateProfile(strings.TrimSpace(c.Param("id")), sshconnection.ProfilePatch{
		Name:           req.Name,
		Host:           req.Host,
		Port:           req.Port,
		User:           req.User,
		AuthMethod:     req.AuthMethod,
		IdentityFile:   req.IdentityFile,
		ConnectTimeout: req.ConnectTimeout,
	})
	if err != nil {
		if !writeSSHError(c, err) {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		}
		return
	}
	c.JSON(http.StatusOK, gin.H{"profile": h.profileResponse(*profile)})
}

func (h *SSHHandler) DeleteProfile(c *gin.Context) {
	if err := h.service.DeleteProfile(strings.TrimSpace(c.Param("id"))); err != nil {
		if !writeSSHError(c, err) {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		}
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *SSHHandler) Connect(c *gin.Context) {
	var req sshConnectRequest
	if !bindLimitedJSON(c, &req, sshSecretRequestMaxBody) {
		return
	}
	profileID := strings.TrimSpace(c.Param("id"))
	if err := h.service.Connect(c.Request.Context(), profileID, req.Auth.secrets()); err != nil {
		if !writeSSHError(c, err) {
			c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		}
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "profile_id": profileID, "connected": true})
}

func bindLimitedJSON(c *gin.Context, target any, limit int64) bool {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, limit)
	if err := c.ShouldBindJSON(target); err != nil {
		if errors.Is(err, io.EOF) {
			return true
		}
		var maxBytesErr *http.MaxBytesError
		if errors.As(err, &maxBytesErr) {
			c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "request body is too large"})
			return false
		}
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return false
	}
	return true
}

func (h *SSHHandler) Disconnect(c *gin.Context) {
	profileID := strings.TrimSpace(c.Param("id"))
	if _, err := h.service.GetProfile(profileID); err != nil {
		if !writeSSHError(c, err) {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		}
		return
	}
	h.service.Disconnect(profileID)
	c.JSON(http.StatusOK, gin.H{"ok": true, "profile_id": profileID, "connected": false})
}

func (h *SSHHandler) ResetKnownHost(c *gin.Context) {
	var req sshResetKnownHostRequest
	if !bindLimitedJSON(c, &req, sshProfileRequestMaxBody) {
		return
	}
	knownHost, err := h.service.ResetKnownHost(
		strings.TrimSpace(c.Param("id")),
		strings.TrimSpace(req.ExpectedFingerprint),
	)
	if err != nil {
		if !writeSSHError(c, err) {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		}
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"ok":          true,
		"endpoint":    knownHost.Endpoint,
		"fingerprint": knownHost.Fingerprint,
		"connected":   false,
	})
}

func (h *SSHHandler) ConfirmHostKey(c *gin.Context) {
	knownHost, err := h.service.ConfirmHostKey(strings.TrimSpace(c.Param("id")))
	if err != nil {
		if !writeSSHError(c, err) {
			c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
		}
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"ok":          true,
		"endpoint":    knownHost.Endpoint,
		"key_type":    knownHost.KeyType,
		"fingerprint": knownHost.Fingerprint,
	})
}

func writeSSHError(c *gin.Context, err error) bool {
	var challengeErr *sshconnection.HostKeyChallengeError
	if errors.As(err, &challengeErr) {
		c.JSON(http.StatusConflict, gin.H{
			"error":     "host key confirmation required",
			"code":      "host_key_confirmation_required",
			"challenge": challengeErr.Challenge,
		})
		return true
	}
	var changedErr *sshconnection.HostKeyChangedError
	if errors.As(err, &changedErr) {
		c.JSON(http.StatusConflict, gin.H{
			"error":                 "remote host identification changed",
			"code":                  "host_key_changed",
			"endpoint":              changedErr.Endpoint,
			"expected_fingerprint":  changedErr.ExpectedFingerprint,
			"presented_fingerprint": changedErr.PresentedFingerprint,
		})
		return true
	}
	var fingerprintMismatch *sshconnection.KnownHostFingerprintMismatchError
	if errors.As(err, &fingerprintMismatch) {
		c.JSON(http.StatusConflict, gin.H{
			"error":                "known host fingerprint mismatch",
			"code":                 "known_host_fingerprint_mismatch",
			"endpoint":             fingerprintMismatch.Endpoint,
			"expected_fingerprint": fingerprintMismatch.ExpectedFingerprint,
			"actual_fingerprint":   fingerprintMismatch.ActualFingerprint,
		})
		return true
	}
	switch {
	case errors.Is(err, sshconnection.ErrProfileNotFound):
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error(), "code": "ssh_profile_not_found"})
	case errors.Is(err, sshconnection.ErrAuthenticationRequired):
		c.JSON(http.StatusUnauthorized, gin.H{"error": err.Error(), "code": "ssh_authentication_required"})
	case errors.Is(err, sshconnection.ErrAuthenticationFailed):
		c.JSON(http.StatusUnauthorized, gin.H{"error": err.Error(), "code": "ssh_authentication_failed"})
	case errors.Is(err, sshconnection.ErrChallengeNotFound), errors.Is(err, sshconnection.ErrChallengeExpired):
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error(), "code": "host_key_challenge_not_found"})
	case errors.Is(err, sshconnection.ErrServiceClosed):
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": err.Error(), "code": "ssh_service_unavailable"})
	case errors.Is(err, sshconnection.ErrKnownHostNotFound):
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error(), "code": "ssh_known_host_not_found"})
	case errors.Is(err, terminal.ErrUnsupportedRuntime):
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error(), "code": "unsupported_terminal_runtime"})
	case errors.Is(err, terminal.ErrRuntimeFactoryMissing):
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": err.Error(), "code": "terminal_runtime_unavailable"})
	case errors.Is(err, context.DeadlineExceeded):
		c.JSON(http.StatusGatewayTimeout, gin.H{"error": err.Error(), "code": "ssh_connect_timeout"})
	default:
		return false
	}
	return true
}
