package handler

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/rs/zerolog/log"
	"github.com/xxnuo/vibego/internal/model"
	"gorm.io/gorm"
)

const (
	maxLoginAttempts    = 5
	baseBanDuration     = 15 * time.Minute
	banDurationMultiply = 2
)

type loginAttempt struct {
	failures    int
	bannedUntil time.Time
	banCount    int
}

type fail2ban struct {
	mu       sync.Mutex
	attempts map[string]*loginAttempt
}

func newFail2Ban() *fail2ban {
	f := &fail2ban{attempts: make(map[string]*loginAttempt)}
	go f.cleanup()
	return f
}

func (f *fail2ban) cleanup() {
	ticker := time.NewTicker(5 * time.Minute)
	for range ticker.C {
		f.mu.Lock()
		now := time.Now()
		for ip, a := range f.attempts {
			if a.failures == 0 && now.After(a.bannedUntil) {
				delete(f.attempts, ip)
			}
		}
		f.mu.Unlock()
	}
}

func (f *fail2ban) check(ip string) (blocked bool, retryAfter time.Duration, remaining int) {
	f.mu.Lock()
	defer f.mu.Unlock()

	a, exists := f.attempts[ip]
	if !exists {
		return false, 0, maxLoginAttempts
	}

	now := time.Now()
	if !a.bannedUntil.IsZero() && now.Before(a.bannedUntil) {
		return true, a.bannedUntil.Sub(now), 0
	}

	if !a.bannedUntil.IsZero() && now.After(a.bannedUntil) {
		a.failures = 0
		a.bannedUntil = time.Time{}
	}

	return false, 0, maxLoginAttempts - a.failures
}

func (f *fail2ban) recordFailure(ip string) (banned bool, banDuration time.Duration) {
	f.mu.Lock()
	defer f.mu.Unlock()

	a, exists := f.attempts[ip]
	if !exists {
		a = &loginAttempt{}
		f.attempts[ip] = a
	}

	a.failures++
	if a.failures >= maxLoginAttempts {
		dur := baseBanDuration
		for i := 0; i < a.banCount; i++ {
			dur *= banDurationMultiply
		}
		a.bannedUntil = time.Now().Add(dur)
		a.banCount++
		log.Warn().Str("ip", ip).Dur("duration", dur).Msg("IP banned due to too many failed login attempts")
		return true, dur
	}
	return false, 0
}

func (f *fail2ban) recordSuccess(ip string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.attempts, ip)
}

type AuthHandler struct {
	db      *gorm.DB
	key     string
	needKey bool
	ban     *fail2ban
}

func NewAuthHandler(db *gorm.DB, key string, needKey bool) *AuthHandler {
	return &AuthHandler{db: db, key: key, needKey: needKey, ban: newFail2Ban()}
}

func (h *AuthHandler) Register(r *gin.RouterGroup) {
	g := r.Group("/auth")
	g.POST("/login", h.Login)
	g.GET("/status", h.Status)
	g.POST("/logout", h.Logout)
}

type LoginRequest struct {
	Key string `json:"key"`
}

type LoginResponse struct {
	OK         bool    `json:"ok"`
	SessionID  string  `json:"session_id,omitempty"`
	UserID     string  `json:"user_id,omitempty"`
	Username   string  `json:"username,omitempty"`
	Error      string  `json:"error,omitempty"`
	Remaining  int     `json:"remaining,omitempty"`
	RetryAfter float64 `json:"retry_after,omitempty"`
}

func (h *AuthHandler) Login(c *gin.Context) {
	var req LoginRequest
	c.ShouldBindJSON(&req)

	if !h.needKey {
		user := h.getOrCreateAnonymousUser()
		if user == nil {
			c.JSON(http.StatusForbidden, LoginResponse{
				OK:    false,
				Error: "account disabled",
			})
			return
		}
		session, err := h.createSession(user.ID, "")
		if err != nil {
			log.Error().Err(err).Msg("Failed to create login session")
			c.JSON(http.StatusInternalServerError, LoginResponse{
				OK:    false,
				Error: "failed to create session",
			})
			return
		}
		c.JSON(http.StatusOK, LoginResponse{
			OK:        true,
			SessionID: session.ID,
			UserID:    user.ID,
			Username:  user.Username,
		})
		return
	}

	ip := c.ClientIP()

	blocked, retryAfter, _ := h.ban.check(ip)
	if blocked {
		log.Warn().Str("ip", ip).Msg("Login attempt from banned IP")
		c.JSON(http.StatusTooManyRequests, LoginResponse{
			OK:         false,
			Error:      "too many failed attempts, try again later",
			RetryAfter: retryAfter.Seconds(),
			Remaining:  0,
		})
		return
	}

	if subtle.ConstantTimeCompare([]byte(req.Key), []byte(h.key)) != 1 {
		banned, banDur := h.ban.recordFailure(ip)
		resp := LoginResponse{
			OK:    false,
			Error: "invalid key",
		}
		if banned {
			resp.RetryAfter = banDur.Seconds()
			resp.Remaining = 0
			c.JSON(http.StatusTooManyRequests, resp)
		} else {
			_, _, remaining := h.ban.check(ip)
			resp.Remaining = remaining
			c.JSON(http.StatusUnauthorized, resp)
		}
		return
	}

	h.ban.recordSuccess(ip)

	user := h.getOrCreateUser("vibego", h.key)
	if user == nil {
		c.JSON(http.StatusForbidden, LoginResponse{
			OK:    false,
			Error: "account disabled",
		})
		return
	}
	session, err := h.createSession(user.ID, "")
	if err != nil {
		log.Error().Err(err).Msg("Failed to create login session")
		c.JSON(http.StatusInternalServerError, LoginResponse{
			OK:    false,
			Error: "failed to create session",
		})
		return
	}
	c.JSON(http.StatusOK, LoginResponse{
		OK:        true,
		SessionID: session.ID,
		UserID:    user.ID,
		Username:  user.Username,
	})
}

type StatusResponse struct {
	NeedLogin bool   `json:"need_login"`
	Username  string `json:"username,omitempty"`
	UserID    string `json:"user_id,omitempty"`
	SessionID string `json:"session_id,omitempty"`
}

func (h *AuthHandler) Status(c *gin.Context) {
	if !h.needKey {
		user := h.getOrCreateAnonymousUser()
		if user == nil {
			c.JSON(http.StatusForbidden, gin.H{"error": "account disabled"})
			return
		}
		c.JSON(http.StatusOK, StatusResponse{
			NeedLogin: false,
			Username:  user.Username,
			UserID:    user.ID,
		})
		return
	}

	c.JSON(http.StatusOK, StatusResponse{
		NeedLogin: true,
		Username:  "vibego",
	})
}

func (h *AuthHandler) Logout(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *AuthHandler) getOrCreateAnonymousUser() *model.User {
	var user model.User
	if err := h.db.First(&user, "username = ? AND deleted_at IS NULL", "anonymous").Error; err == nil {
		if user.Status != "active" {
			return nil
		}
		return &user
	}

	now := time.Now().Unix()
	user = model.User{
		ID:          uuid.New().String(),
		Username:    "anonymous",
		Status:      "active",
		CreatedAt:   now,
		LastLoginAt: now,
	}
	h.db.Create(&user)
	return &user
}

func (h *AuthHandler) getOrCreateUser(username, key string) *model.User {
	var user model.User
	keyHash := hashKey(key)

	if err := h.db.First(&user, "username = ? AND deleted_at IS NULL", username).Error; err == nil {
		if user.Status != "active" {
			return nil
		}
		h.db.Model(&user).Updates(map[string]any{
			"token_hash":    keyHash,
			"last_login_at": time.Now().Unix(),
		})
		return &user
	}

	now := time.Now().Unix()
	user = model.User{
		ID:          uuid.New().String(),
		Username:    username,
		TokenHash:   keyHash,
		Status:      "active",
		CreatedAt:   now,
		LastLoginAt: now,
	}
	h.db.Create(&user)
	return &user
}

func (h *AuthHandler) createSession(userID, sessionName string) (*model.UserSession, error) {
	now := time.Now().Unix()
	expiredAt := now + 7*24*60*60
	name := sessionName
	if name == "" {
		name = "Default Session"
	}
	session := model.UserSession{
		ID:           uuid.New().String(),
		UserID:       userID,
		Name:         name,
		State:        "{}",
		LastActiveAt: now,
		ExpiredAt:    expiredAt,
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	if err := h.db.Transaction(func(tx *gorm.DB) error {
		position, err := nextSessionPosition(tx)
		if err != nil {
			return err
		}
		session.Position = position
		return tx.Create(&session).Error
	}); err != nil {
		return nil, err
	}
	return &session, nil
}

func hashKey(key string) string {
	hash := sha256.Sum256([]byte(key))
	return hex.EncodeToString(hash[:])
}
