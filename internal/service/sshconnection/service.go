package sshconnection

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/user"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/google/uuid"
	"github.com/xxnuo/vibego/internal/model"
	"github.com/xxnuo/vibego/internal/service/terminal"
	"golang.org/x/crypto/ssh"
	"gorm.io/gorm"
)

const hostKeyChallengeTTL = 5 * time.Minute

type pendingHostKeyChallenge struct {
	challenge  HostKeyChallenge
	publicKey  []byte
	confirming bool
}

type Service struct {
	db *gorm.DB

	mu                sync.Mutex
	connections       map[string]*ssh.Client
	connectLocks      map[string]*sync.Mutex
	endpointLocks     map[string]*sync.Mutex
	runtimeSetupSlots map[*ssh.Client]chan struct{}
	challenges        map[string]pendingHostKeyChallenge
	now               func() time.Time
	closeCtx          context.Context
	closeCancel       context.CancelFunc
	closed            bool
	closeOnce         sync.Once
	connectWG         sync.WaitGroup
	runtimeSetupWG    sync.WaitGroup
}

func New(db *gorm.DB) *Service {
	closeCtx, closeCancel := context.WithCancel(context.Background())
	return &Service{
		db:                db,
		connections:       make(map[string]*ssh.Client),
		connectLocks:      make(map[string]*sync.Mutex),
		endpointLocks:     make(map[string]*sync.Mutex),
		runtimeSetupSlots: make(map[*ssh.Client]chan struct{}),
		challenges:        make(map[string]pendingHostKeyChallenge),
		now:               time.Now,
		closeCtx:          closeCtx,
		closeCancel:       closeCancel,
	}
}

func (s *Service) CreateProfile(input ProfileInput) (*model.SSHConnectionProfile, error) {
	profile, err := normalizeProfile(input)
	if err != nil {
		return nil, err
	}
	now := s.now().Unix()
	profile.ID = uuid.NewString()
	profile.CreatedAt = now
	profile.UpdatedAt = now
	if err := s.db.Create(profile).Error; err != nil {
		return nil, err
	}
	return profile, nil
}

func (s *Service) ListProfiles() ([]model.SSHConnectionProfile, error) {
	profiles := make([]model.SSHConnectionProfile, 0)
	if err := s.db.Order("name ASC").Order("id ASC").Find(&profiles).Error; err != nil {
		return nil, err
	}
	return profiles, nil
}

func (s *Service) GetProfile(id string) (*model.SSHConnectionProfile, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return nil, ErrProfileNotFound
	}
	var profile model.SSHConnectionProfile
	if err := s.db.First(&profile, "id = ?", id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrProfileNotFound
		}
		return nil, err
	}
	return &profile, nil
}

func (s *Service) UpdateProfile(id string, patch ProfilePatch) (*model.SSHConnectionProfile, error) {
	id = strings.TrimSpace(id)
	connectLock := s.profileConnectLock(id)
	connectLock.Lock()
	defer connectLock.Unlock()

	current, err := s.GetProfile(id)
	if err != nil {
		return nil, err
	}
	input := ProfileInput{
		Name:           current.Name,
		Host:           current.Host,
		Port:           current.Port,
		User:           current.User,
		AuthMethod:     current.AuthMethod,
		IdentityFile:   current.IdentityFile,
		ConnectTimeout: current.ConnectTimeout,
	}
	if patch.Name != nil {
		input.Name = *patch.Name
	}
	if patch.Host != nil {
		input.Host = *patch.Host
	}
	if patch.Port != nil {
		input.Port = *patch.Port
	}
	if patch.User != nil {
		input.User = *patch.User
	}
	if patch.AuthMethod != nil {
		input.AuthMethod = *patch.AuthMethod
	}
	if patch.IdentityFile != nil {
		input.IdentityFile = *patch.IdentityFile
	}
	if patch.ConnectTimeout != nil {
		input.ConnectTimeout = *patch.ConnectTimeout
	}

	normalized, err := normalizeProfile(input)
	if err != nil {
		return nil, err
	}
	normalized.ID = current.ID
	normalized.CreatedAt = current.CreatedAt
	normalized.UpdatedAt = s.now().Unix()
	connectionChanged := normalized.Host != current.Host ||
		normalized.Port != current.Port ||
		normalized.User != current.User ||
		normalized.AuthMethod != current.AuthMethod ||
		normalized.IdentityFile != current.IdentityFile
	if err := s.db.Model(&model.SSHConnectionProfile{}).Where("id = ?", id).Updates(map[string]any{
		"name":            normalized.Name,
		"host":            normalized.Host,
		"port":            normalized.Port,
		"user":            normalized.User,
		"auth_method":     normalized.AuthMethod,
		"identity_file":   normalized.IdentityFile,
		"connect_timeout": normalized.ConnectTimeout,
		"updated_at":      normalized.UpdatedAt,
	}).Error; err != nil {
		return nil, err
	}
	if connectionChanged {
		s.disconnectLocked(id)
		s.deleteProfileChallenges(id)
	}
	return normalized, nil
}

func (s *Service) DeleteProfile(id string) error {
	id = strings.TrimSpace(id)
	connectLock := s.profileConnectLock(id)
	connectLock.Lock()
	defer connectLock.Unlock()

	if _, err := s.GetProfile(id); err != nil {
		return err
	}
	if err := s.db.Delete(&model.SSHConnectionProfile{}, "id = ?", id).Error; err != nil {
		return err
	}
	s.disconnectLocked(id)
	s.deleteProfileChallenges(id)
	return nil
}

func (s *Service) IsConnected(profileID string) bool {
	profileID = strings.TrimSpace(profileID)
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.connections[profileID] != nil
}

func (s *Service) Connect(ctx context.Context, profileID string, auth terminal.SSHAuthSecrets) error {
	profileID = strings.TrimSpace(profileID)
	connectLock := s.profileConnectLock(profileID)
	connectLock.Lock()
	defer connectLock.Unlock()
	if ctx == nil {
		ctx = context.Background()
	}

	profile, err := s.GetProfile(profileID)
	if err != nil {
		return err
	}
	endpointLock := s.endpointConnectLock(profileEndpoint(profile))
	endpointLock.Lock()
	defer endpointLock.Unlock()

	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return ErrServiceClosed
	}
	closeCtx := s.closeCtx
	s.connectWG.Add(1)
	s.mu.Unlock()
	defer s.connectWG.Done()

	connectCtx, cancel := context.WithCancel(ctx)
	stopCloseCancel := context.AfterFunc(closeCtx, cancel)
	defer func() {
		stopCloseCancel()
		cancel()
	}()
	if s.IsConnected(profileID) {
		return nil
	}
	client, err := s.dial(connectCtx, profile, auth)
	if err != nil {
		if s.isClosed() {
			return ErrServiceClosed
		}
		return err
	}

	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		_ = client.Close()
		return ErrServiceClosed
	}
	s.connections[profileID] = client
	s.mu.Unlock()
	go func() {
		_ = client.Wait()
		s.removeConnection(profileID, client)
	}()
	return nil
}

func (s *Service) Disconnect(profileID string) {
	profileID = strings.TrimSpace(profileID)
	connectLock := s.profileConnectLock(profileID)
	connectLock.Lock()
	defer connectLock.Unlock()
	s.disconnectLocked(profileID)
}

func (s *Service) disconnectLocked(profileID string) {
	s.mu.Lock()
	client := s.connections[profileID]
	delete(s.connections, profileID)
	delete(s.runtimeSetupSlots, client)
	s.mu.Unlock()
	if client != nil {
		_ = client.Close()
	}
}

func (s *Service) Close() {
	s.closeOnce.Do(func() {
		s.mu.Lock()
		s.closed = true
		s.closeCancel()
		connections := s.connections
		s.connections = make(map[string]*ssh.Client)
		s.runtimeSetupSlots = make(map[*ssh.Client]chan struct{})
		s.mu.Unlock()
		for _, client := range connections {
			_ = client.Close()
		}
		s.connectWG.Wait()
		s.runtimeSetupWG.Wait()
	})
}

func (s *Service) isClosed() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.closed
}

func (s *Service) profileConnectLock(profileID string) *sync.Mutex {
	s.mu.Lock()
	defer s.mu.Unlock()
	lock := s.connectLocks[profileID]
	if lock == nil {
		lock = &sync.Mutex{}
		s.connectLocks[profileID] = lock
	}
	return lock
}

func (s *Service) endpointConnectLock(endpoint string) *sync.Mutex {
	s.mu.Lock()
	defer s.mu.Unlock()
	lock := s.endpointLocks[endpoint]
	if lock == nil {
		lock = &sync.Mutex{}
		s.endpointLocks[endpoint] = lock
	}
	return lock
}

func (s *Service) CreateRuntime(ctx context.Context, request terminal.RuntimeCreateRequest) (terminal.TerminalRuntime, error) {
	if request.Type != terminal.RuntimeTypeSSH {
		return nil, fmt.Errorf("%w: %s", terminal.ErrUnsupportedRuntime, request.Type)
	}
	profile, err := s.GetProfile(request.ProfileID)
	if err != nil {
		return nil, err
	}

	client := s.getConnection(profile.ID)
	if client == nil {
		if err := s.Connect(ctx, profile.ID, request.SSHAuth); err != nil {
			return nil, err
		}
		client = s.getConnection(profile.ID)
	}
	if client == nil {
		return nil, errors.New("ssh connection was not established")
	}

	releaseSetup, err := s.acquireRuntimeSetup(ctx, profile.ID, client)
	if err != nil {
		return nil, err
	}
	closeTransport := func() {
		s.removeConnection(profile.ID, client)
		_ = client.Close()
	}
	runtime, err := newRuntime(ctx, client, request.Cwd, request.Cols, request.Rows, releaseSetup, closeTransport, request.Command)
	if err == nil {
		return runtime, nil
	}
	return nil, fmt.Errorf("create ssh terminal session: %w", err)
}

// CompleteProfile runs a bounded completion query through an already
// authenticated profile connection. It deliberately constructs a
// completion-only Runtime: no interactive PTY/session is created and the
// shared transport remains owned by the SSH service.
func (s *Service) CompleteProfile(
	ctx context.Context,
	profileID string,
	request terminal.CompletionRequest,
) (terminal.CompletionResult, error) {
	if s == nil {
		return terminal.CompletionResult{}, ErrServiceClosed
	}
	if ctx == nil {
		ctx = context.Background()
	}
	profile, err := s.GetProfile(profileID)
	if err != nil {
		return terminal.CompletionResult{}, err
	}
	s.mu.Lock()
	closed := s.closed
	closeCtx := s.closeCtx
	client := s.connections[profile.ID]
	s.mu.Unlock()
	if closed {
		return terminal.CompletionResult{}, ErrServiceClosed
	}
	if client == nil {
		return terminal.CompletionResult{}, ErrReconnectRequired
	}

	completionCtx, cancel := context.WithCancel(ctx)
	stopCloseCancel := context.AfterFunc(closeCtx, cancel)
	defer func() {
		stopCloseCancel()
		cancel()
	}()

	runtime := &Runtime{
		client:           client,
		closed:           make(chan struct{}),
		completionSlot:   make(chan struct{}, sshCompletionMaxConcurrent),
		completionTimeout: sshCompletionTimeout,
	}
	return runtime.Complete(completionCtx, request)
}

func (s *Service) acquireRuntimeSetup(ctx context.Context, profileID string, client *ssh.Client) (func(), error) {
	if ctx == nil {
		ctx = context.Background()
	}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil, ErrServiceClosed
	}
	if s.connections[profileID] != client {
		s.mu.Unlock()
		return nil, errors.New("ssh connection was not established")
	}
	slot := s.runtimeSetupSlots[client]
	if slot == nil {
		slot = make(chan struct{}, 1)
		s.runtimeSetupSlots[client] = slot
	}
	s.mu.Unlock()

	select {
	case slot <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	}

	s.mu.Lock()
	if s.closed || s.connections[profileID] != client || ctx.Err() != nil {
		s.mu.Unlock()
		<-slot
		if ctxErr := ctx.Err(); ctxErr != nil {
			return nil, ctxErr
		}
		if s.isClosed() {
			return nil, ErrServiceClosed
		}
		return nil, errors.New("ssh connection was not established")
	}
	s.runtimeSetupWG.Add(1)
	s.mu.Unlock()

	var once sync.Once
	return func() {
		once.Do(func() {
			<-slot
			s.runtimeSetupWG.Done()
		})
	}, nil
}

func (s *Service) ConfirmHostKey(challengeID string) (*model.SSHKnownHost, error) {
	challengeID = strings.TrimSpace(challengeID)
	now := s.now()
	s.mu.Lock()
	pending, ok := s.challenges[challengeID]
	if ok && now.Unix() >= pending.challenge.ExpiresAt {
		delete(s.challenges, challengeID)
		ok = false
	}
	if ok && pending.confirming {
		ok = false
	}
	if ok {
		pending.confirming = true
		s.challenges[challengeID] = pending
	}
	s.cleanupChallengesLocked(now)
	s.mu.Unlock()
	if !ok {
		if pending.challenge.ID != "" && now.Unix() >= pending.challenge.ExpiresAt {
			return nil, ErrChallengeExpired
		}
		return nil, ErrChallengeNotFound
	}

	connectLock := s.profileConnectLock(pending.challenge.ProfileID)
	connectLock.Lock()
	defer connectLock.Unlock()
	profile, err := s.GetProfile(pending.challenge.ProfileID)
	if err != nil {
		s.deleteHostKeyChallenge(challengeID)
		return nil, err
	}
	endpoint := profileEndpoint(profile)
	if endpoint != pending.challenge.Endpoint {
		s.deleteHostKeyChallenge(challengeID)
		return nil, errors.New("ssh profile endpoint changed after the host key challenge")
	}
	endpointLock := s.endpointConnectLock(endpoint)
	endpointLock.Lock()
	defer endpointLock.Unlock()

	now = s.now()
	s.mu.Lock()
	current, ok := s.challenges[challengeID]
	if !ok || current.challenge.ProfileID != pending.challenge.ProfileID ||
		current.challenge.Endpoint != pending.challenge.Endpoint ||
		current.challenge.Fingerprint != pending.challenge.Fingerprint || !current.confirming {
		s.cleanupChallengesLocked(now)
		s.mu.Unlock()
		return nil, ErrChallengeNotFound
	}
	if now.Unix() >= current.challenge.ExpiresAt {
		delete(s.challenges, challengeID)
		s.cleanupChallengesLocked(now)
		s.mu.Unlock()
		return nil, ErrChallengeExpired
	}
	s.cleanupChallengesLocked(now)
	s.mu.Unlock()
	pending = current

	knownHost := &model.SSHKnownHost{
		Endpoint:    endpoint,
		Host:        profile.Host,
		Port:        profile.Port,
		KeyType:     pending.challenge.KeyType,
		PublicKey:   base64.StdEncoding.EncodeToString(pending.publicKey),
		Fingerprint: pending.challenge.Fingerprint,
		CreatedAt:   now.Unix(),
		UpdatedAt:   now.Unix(),
	}
	err = s.db.Transaction(func(tx *gorm.DB) error {
		var existing model.SSHKnownHost
		if err := tx.First(&existing, "endpoint = ?", endpoint).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return tx.Create(knownHost).Error
			}
			return err
		}
		if existing.PublicKey != knownHost.PublicKey || existing.KeyType != knownHost.KeyType {
			return &HostKeyChangedError{
				Endpoint:             endpoint,
				ExpectedFingerprint:  existing.Fingerprint,
				PresentedFingerprint: knownHost.Fingerprint,
			}
		}
		knownHost.CreatedAt = existing.CreatedAt
		return nil
	})
	if err != nil {
		s.finishHostKeyConfirmation(challengeID, pending, false)
		return nil, err
	}
	s.finishHostKeyConfirmation(challengeID, pending, true)
	return knownHost, nil
}

func (s *Service) ResetKnownHost(profileID, expectedFingerprint string) (*model.SSHKnownHost, error) {
	profileID = strings.TrimSpace(profileID)
	expectedFingerprint = strings.TrimSpace(expectedFingerprint)
	if expectedFingerprint == "" {
		return nil, errors.New("expected host key fingerprint is required")
	}
	connectLock := s.profileConnectLock(profileID)
	connectLock.Lock()
	defer connectLock.Unlock()
	profile, err := s.GetProfile(profileID)
	if err != nil {
		return nil, err
	}
	endpoint := profileEndpoint(profile)
	endpointLock := s.endpointConnectLock(endpoint)
	endpointLock.Lock()
	defer endpointLock.Unlock()

	var knownHost model.SSHKnownHost
	var profileIDs []string
	if err := s.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.First(&knownHost, "endpoint = ?", endpoint).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrKnownHostNotFound
			}
			return err
		}
		if knownHost.Fingerprint != expectedFingerprint {
			return &KnownHostFingerprintMismatchError{
				Endpoint:            endpoint,
				ExpectedFingerprint: expectedFingerprint,
				ActualFingerprint:   knownHost.Fingerprint,
			}
		}
		if err := tx.Model(&model.SSHConnectionProfile{}).
			Where("host = ? AND port = ?", profile.Host, profile.Port).
			Pluck("id", &profileIDs).Error; err != nil {
			return err
		}
		result := tx.Delete(&model.SSHKnownHost{}, "endpoint = ? AND fingerprint = ?", endpoint, expectedFingerprint)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected == 0 {
			return ErrKnownHostNotFound
		}
		return nil
	}); err != nil {
		return nil, err
	}
	clients := make([]*ssh.Client, 0, len(profileIDs))
	s.mu.Lock()
	for _, id := range profileIDs {
		if client := s.connections[id]; client != nil {
			clients = append(clients, client)
			delete(s.connections, id)
			delete(s.runtimeSetupSlots, client)
		}
	}
	for id, challenge := range s.challenges {
		if challenge.challenge.Endpoint == endpoint {
			delete(s.challenges, id)
		}
	}
	s.mu.Unlock()
	for _, client := range clients {
		_ = client.Close()
	}
	return &knownHost, nil
}

func (s *Service) getConnection(profileID string) *ssh.Client {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.connections[profileID]
}

func (s *Service) removeConnection(profileID string, client *ssh.Client) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.connections[profileID] != client {
		return false
	}
	delete(s.connections, profileID)
	delete(s.runtimeSetupSlots, client)
	return true
}

func (s *Service) deleteProfileChallenges(profileID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, challenge := range s.challenges {
		if challenge.challenge.ProfileID == profileID {
			delete(s.challenges, id)
		}
	}
}

func (s *Service) deleteHostKeyChallenge(challengeID string) {
	s.mu.Lock()
	delete(s.challenges, challengeID)
	s.mu.Unlock()
}

func (s *Service) finishHostKeyConfirmation(challengeID string, pending pendingHostKeyChallenge, consume bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	current, ok := s.challenges[challengeID]
	if !ok || current.challenge != pending.challenge || !current.confirming {
		return
	}
	if consume {
		delete(s.challenges, challengeID)
		return
	}
	current.confirming = false
	s.challenges[challengeID] = current
}

func (s *Service) dial(ctx context.Context, profile *model.SSHConnectionProfile, auth terminal.SSHAuthSecrets) (*ssh.Client, error) {
	timeout := time.Duration(profile.ConnectTimeout) * time.Second
	if timeout <= 0 {
		timeout = defaultConnectTimeout * time.Second
	}
	dialCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	authMethods, cleanup, err := buildAuthMethods(dialCtx, profile, auth)
	if err != nil {
		return nil, err
	}
	defer cleanup()

	callback, err := s.hostKeyCallback(profile)
	if err != nil {
		return nil, err
	}
	var hostKeyErr error
	trackedCallback := func(hostname string, remote net.Addr, key ssh.PublicKey) error {
		hostKeyErr = callback(hostname, remote, key)
		return hostKeyErr
	}
	sshUser := profile.User
	if sshUser == "" {
		current, userErr := user.Current()
		if userErr != nil {
			return nil, fmt.Errorf("resolve current user: %w", userErr)
		}
		sshUser = current.Username
	}
	algorithms := ssh.SupportedAlgorithms()
	config := &ssh.ClientConfig{
		Config: ssh.Config{
			KeyExchanges: algorithms.KeyExchanges,
			Ciphers:      algorithms.Ciphers,
			MACs:         algorithms.MACs,
		},
		User:              sshUser,
		Auth:              authMethods,
		HostKeyCallback:   trackedCallback,
		HostKeyAlgorithms: algorithms.HostKeys,
	}

	address := profileEndpoint(profile)
	netConn, err := (&net.Dialer{}).DialContext(dialCtx, "tcp", address)
	if err != nil {
		return nil, fmt.Errorf("dial ssh endpoint %s: %w", address, err)
	}
	_ = netConn.SetDeadline(time.Now().Add(timeout))
	stopContextDeadline := context.AfterFunc(dialCtx, func() {
		_ = netConn.SetDeadline(time.Now())
	})
	conn, chans, requests, err := ssh.NewClientConn(netConn, address, config)
	if err != nil {
		stopContextDeadline()
		_ = netConn.Close()
		if ctxErr := dialCtx.Err(); ctxErr != nil {
			return nil, ctxErr
		}
		if hostKeyErr != nil {
			return nil, hostKeyErr
		}
		var challengeErr *HostKeyChallengeError
		var changedErr *HostKeyChangedError
		if errors.As(err, &challengeErr) || errors.As(err, &changedErr) {
			return nil, err
		}
		return nil, fmt.Errorf("%w: %v", ErrAuthenticationFailed, err)
	}
	if !stopContextDeadline() {
		_ = conn.Close()
		return nil, dialCtx.Err()
	}
	if ctxErr := dialCtx.Err(); ctxErr != nil {
		_ = conn.Close()
		return nil, ctxErr
	}
	_ = netConn.SetDeadline(time.Time{})
	return ssh.NewClient(conn, chans, requests), nil
}

func (s *Service) hostKeyCallback(profile *model.SSHConnectionProfile) (ssh.HostKeyCallback, error) {
	endpoint := profileEndpoint(profile)
	var known model.SSHKnownHost
	err := s.db.First(&known, "endpoint = ?", endpoint).Error
	if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, err
	}
	if err == nil {
		stored, decodeErr := base64.StdEncoding.DecodeString(known.PublicKey)
		if decodeErr != nil {
			return nil, fmt.Errorf("decode stored host key for %s: %w", endpoint, decodeErr)
		}
		return func(_ string, _ net.Addr, key ssh.PublicKey) error {
			if key.Type() == known.KeyType && bytes.Equal(key.Marshal(), stored) {
				return nil
			}
			return &HostKeyChangedError{
				Endpoint:             endpoint,
				ExpectedFingerprint:  known.Fingerprint,
				PresentedFingerprint: ssh.FingerprintSHA256(key),
			}
		}, nil
	}

	return func(_ string, _ net.Addr, key ssh.PublicKey) error {
		challenge := s.issueHostKeyChallenge(profile.ID, endpoint, key)
		return &HostKeyChallengeError{Challenge: challenge}
	}, nil
}

func (s *Service) issueHostKeyChallenge(profileID, endpoint string, key ssh.PublicKey) HostKeyChallenge {
	now := s.now()
	fingerprint := ssh.FingerprintSHA256(key)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cleanupChallengesLocked(now)
	for _, pending := range s.challenges {
		if pending.challenge.ProfileID == profileID && pending.challenge.Endpoint == endpoint &&
			pending.challenge.Fingerprint == fingerprint {
			return pending.challenge
		}
	}
	challenge := HostKeyChallenge{
		ID:          uuid.NewString(),
		ProfileID:   profileID,
		Endpoint:    endpoint,
		KeyType:     key.Type(),
		Fingerprint: fingerprint,
		ExpiresAt:   now.Add(hostKeyChallengeTTL).Unix(),
	}
	s.challenges[challenge.ID] = pendingHostKeyChallenge{
		challenge: challenge,
		publicKey: append([]byte(nil), key.Marshal()...),
	}
	return challenge
}

func (s *Service) cleanupChallengesLocked(now time.Time) {
	for id, pending := range s.challenges {
		if now.Unix() >= pending.challenge.ExpiresAt {
			delete(s.challenges, id)
		}
	}
}

func buildAuthMethods(ctx context.Context, profile *model.SSHConnectionProfile, auth terminal.SSHAuthSecrets) ([]ssh.AuthMethod, func(), error) {
	methods := make([]ssh.AuthMethod, 0, 4)
	publicKeySigners := make([]ssh.Signer, 0, 4)
	cleanups := make([]func(), 0, 1)
	cleanup := func() {
		for _, closeFn := range cleanups {
			closeFn()
		}
	}

	addAgent := func(required bool) error {
		signers, closeFn, err := loadAgentSigners(ctx)
		if closeFn != nil {
			cleanups = append(cleanups, closeFn)
		}
		if err != nil {
			if required {
				return err
			}
			return nil
		}
		if len(signers) == 0 {
			if required {
				return ErrAuthenticationRequired
			}
			return nil
		}
		publicKeySigners = append(publicKeySigners, signers...)
		return nil
	}
	addKey := func(required bool) error {
		keyData := []byte(auth.PrivateKey)
		if len(keyData) == 0 && profile.IdentityFile != "" {
			var err error
			keyData, err = readIdentityFile(ctx, profile.IdentityFile)
			if err != nil {
				return err
			}
		}
		if len(keyData) == 0 {
			if required {
				return ErrAuthenticationRequired
			}
			return nil
		}
		signer, err := parsePrivateKey(keyData, auth.Passphrase)
		if err != nil {
			return err
		}
		publicKeySigners = append([]ssh.Signer{signer}, publicKeySigners...)
		return nil
	}
	addPassword := func(required bool) error {
		if auth.Password == "" {
			if required {
				return ErrAuthenticationRequired
			}
			return nil
		}
		methods = append(methods, ssh.Password(auth.Password))
		methods = append(methods, ssh.KeyboardInteractive(func(_ string, _ string, questions []string, echos []bool) ([]string, error) {
			answers := make([]string, len(questions))
			for index := range questions {
				if index < len(echos) && !echos[index] {
					answers[index] = auth.Password
				}
			}
			return answers, nil
		}))
		return nil
	}

	var err error
	switch profile.AuthMethod {
	case AuthMethodAgent:
		err = addAgent(true)
	case AuthMethodPrivateKey:
		err = addKey(true)
	case AuthMethodPassword:
		err = addPassword(true)
	default:
		if err = addAgent(false); err == nil {
			err = addKey(false)
		}
		if err == nil {
			err = addPassword(false)
		}
	}
	if err != nil {
		cleanup()
		return nil, func() {}, err
	}
	if len(publicKeySigners) > 0 {
		methods = append([]ssh.AuthMethod{ssh.PublicKeys(publicKeySigners...)}, methods...)
	}
	if len(methods) == 0 {
		cleanup()
		return nil, func() {}, ErrAuthenticationRequired
	}
	return methods, cleanup, nil
}

func readIdentityFile(ctx context.Context, path string) ([]byte, error) {
	path = strings.TrimSpace(path)
	if strings.HasPrefix(path, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil, err
		}
		path = filepath.Join(home, path[2:])
	}
	file, err := openIdentityFile(path)
	if err != nil {
		return nil, fmt.Errorf("open ssh identity file: %w", err)
	}
	defer file.Close()
	stopContextClose := context.AfterFunc(ctx, func() {
		_ = file.Close()
	})
	data, err := io.ReadAll(io.LimitReader(file, maxIdentityFileSize+1))
	if !stopContextClose() {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return nil, ctxErr
		}
	}
	if err != nil {
		return nil, fmt.Errorf("read ssh identity file: %w", err)
	}
	if len(data) > maxIdentityFileSize {
		return nil, errors.New("ssh identity file is too large")
	}
	return data, nil
}

func parsePrivateKey(data []byte, passphrase string) (ssh.Signer, error) {
	if passphrase != "" {
		signer, err := ssh.ParsePrivateKeyWithPassphrase(data, []byte(passphrase))
		if err != nil {
			return nil, fmt.Errorf("parse ssh private key: %w", err)
		}
		return signer, nil
	}
	signer, err := ssh.ParsePrivateKey(data)
	if err != nil {
		var missing *ssh.PassphraseMissingError
		if errors.As(err, &missing) {
			return nil, ErrAuthenticationRequired
		}
		return nil, fmt.Errorf("parse ssh private key: %w", err)
	}
	return signer, nil
}

func normalizeProfile(input ProfileInput) (*model.SSHConnectionProfile, error) {
	host, err := normalizeHost(input.Host)
	if err != nil {
		return nil, err
	}
	port := input.Port
	if port == 0 {
		port = defaultSSHPort
	}
	if port < 1 || port > 65535 {
		return nil, errors.New("ssh port must be between 1 and 65535")
	}
	sshUser := strings.TrimSpace(input.User)
	if len(sshUser) > 255 || strings.IndexFunc(sshUser, unicode.IsControl) >= 0 {
		return nil, errors.New("invalid ssh user")
	}
	authMethod := strings.TrimSpace(input.AuthMethod)
	if authMethod == "" {
		authMethod = AuthMethodAuto
	}
	switch authMethod {
	case AuthMethodAuto, AuthMethodAgent, AuthMethodPrivateKey, AuthMethodPassword:
	default:
		return nil, fmt.Errorf("unsupported ssh auth method %q", authMethod)
	}
	identityFile := strings.TrimSpace(input.IdentityFile)
	if len(identityFile) > 4096 || strings.IndexFunc(identityFile, unicode.IsControl) >= 0 {
		return nil, errors.New("invalid ssh identity file")
	}
	connectTimeout := input.ConnectTimeout
	if connectTimeout == 0 {
		connectTimeout = defaultConnectTimeout
	}
	if connectTimeout < 1 || connectTimeout > maxConnectTimeoutSeconds {
		return nil, fmt.Errorf("ssh connect timeout must be between 1 and %d seconds", maxConnectTimeoutSeconds)
	}
	name := strings.TrimSpace(input.Name)
	if name == "" {
		name = host
		if sshUser != "" {
			name = sshUser + "@" + host
		}
		if port != defaultSSHPort {
			name += fmt.Sprintf(":%d", port)
		}
	}
	if len(name) > 128 || strings.IndexFunc(name, unicode.IsControl) >= 0 {
		return nil, errors.New("invalid ssh profile name")
	}
	return &model.SSHConnectionProfile{
		Name:           name,
		Host:           host,
		Port:           port,
		User:           sshUser,
		AuthMethod:     authMethod,
		IdentityFile:   identityFile,
		ConnectTimeout: connectTimeout,
	}, nil
}

func normalizeHost(value string) (string, error) {
	host := strings.TrimSpace(value)
	if host == "" || len(host) > 255 || strings.IndexFunc(host, unicode.IsControl) >= 0 ||
		strings.ContainsAny(host, " /\\@") {
		return "", errors.New("invalid ssh host")
	}
	if strings.HasPrefix(host, "[") && strings.HasSuffix(host, "]") {
		host = host[1 : len(host)-1]
	}
	if host == "" {
		return "", errors.New("invalid ssh host")
	}
	if parsed := net.ParseIP(host); parsed != nil {
		return parsed.String(), nil
	}
	if strings.Contains(host, ":") || strings.ContainsAny(host, "[]") {
		return "", errors.New("invalid ssh host")
	}
	return strings.ToLower(host), nil
}

func profileEndpoint(profile *model.SSHConnectionProfile) string {
	return net.JoinHostPort(profile.Host, fmt.Sprintf("%d", profile.Port))
}
