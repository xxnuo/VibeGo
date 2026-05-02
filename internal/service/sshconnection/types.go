package sshconnection

import (
	"errors"
	"fmt"
)

const (
	AuthMethodAuto       = "auto"
	AuthMethodAgent      = "agent"
	AuthMethodPrivateKey = "private_key"
	AuthMethodPassword   = "password"

	defaultSSHPort           = 22
	defaultConnectTimeout    = 10
	maxConnectTimeoutSeconds = 60
	maxIdentityFileSize      = 1024 * 1024
)

var (
	ErrProfileNotFound        = errors.New("ssh profile not found")
	ErrAuthenticationRequired = errors.New("ssh authentication material is required")
	ErrAuthenticationFailed   = errors.New("ssh authentication failed")
	ErrReconnectRequired      = errors.New("ssh reconnect required")
	ErrRemoteFilesUnsupported = errors.New("remote files are unavailable for this terminal")
	ErrChallengeNotFound      = errors.New("ssh host key challenge not found")
	ErrChallengeExpired       = errors.New("ssh host key challenge expired")
	ErrServiceClosed          = errors.New("ssh connection service is closed")
	ErrKnownHostNotFound      = errors.New("ssh known host not found")
)

type ProfileInput struct {
	Name           string
	Host           string
	Port           int
	User           string
	AuthMethod     string
	IdentityFile   string
	ConnectTimeout int
}

type ProfilePatch struct {
	Name           *string
	Host           *string
	Port           *int
	User           *string
	AuthMethod     *string
	IdentityFile   *string
	ConnectTimeout *int
}

type HostKeyChallenge struct {
	ID          string `json:"id"`
	ProfileID   string `json:"profile_id"`
	Endpoint    string `json:"endpoint"`
	KeyType     string `json:"key_type"`
	Fingerprint string `json:"fingerprint"`
	ExpiresAt   int64  `json:"expires_at"`
}

type HostKeyChallengeError struct {
	Challenge HostKeyChallenge
}

func (e *HostKeyChallengeError) Error() string {
	return fmt.Sprintf("host key confirmation required for %s (%s)", e.Challenge.Endpoint, e.Challenge.Fingerprint)
}

type HostKeyChangedError struct {
	Endpoint             string `json:"endpoint"`
	ExpectedFingerprint  string `json:"expected_fingerprint"`
	PresentedFingerprint string `json:"presented_fingerprint"`
}

type KnownHostFingerprintMismatchError struct {
	Endpoint            string `json:"endpoint"`
	ExpectedFingerprint string `json:"expected_fingerprint"`
	ActualFingerprint   string `json:"actual_fingerprint"`
}

func (e *KnownHostFingerprintMismatchError) Error() string {
	return fmt.Sprintf(
		"known host fingerprint mismatch for %s: expected %s, current %s",
		e.Endpoint,
		e.ExpectedFingerprint,
		e.ActualFingerprint,
	)
}

func (e *HostKeyChangedError) Error() string {
	return fmt.Sprintf(
		"remote host identification changed for %s: expected %s, received %s",
		e.Endpoint,
		e.ExpectedFingerprint,
		e.PresentedFingerprint,
	)
}
