package handler

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/xxnuo/vibego/internal/model"
	"gorm.io/gorm"
)

type AuthHandler struct {
	db    *gorm.DB
	token string
}

func NewAuthHandler(db *gorm.DB, token string) *AuthHandler {
	return &AuthHandler{db: db, token: token}
}

func (h *AuthHandler) Register(r *gin.RouterGroup) {
	g := r.Group("/auth")
	g.POST("/login", h.Login)
	g.GET("/status", h.Status)
	g.POST("/logout", h.Logout)
}

type LoginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type LoginResponse struct {
	OK        bool   `json:"ok"`
	SessionID string `json:"session_id,omitempty"`
	UserID    string `json:"user_id,omitempty"`
	Username  string `json:"username,omitempty"`
	Error     string `json:"error,omitempty"`
}

// Login godoc
// @Summary User login
// @Description Authenticate user with username and password
// @Tags Auth
// @Accept json
// @Produce json
// @Param request body LoginRequest true "Login request"
// @Success 200 {object} LoginResponse
// @Failure 401 {object} LoginResponse
// @Router /api/auth/login [post]
func (h *AuthHandler) Login(c *gin.Context) {
	var req LoginRequest
	c.ShouldBindJSON(&req)

	if h.token == "" {
		user := h.getOrCreateAnonymousUser()
		session := h.createSession(user.ID, req.Username)
		c.JSON(http.StatusOK, LoginResponse{
			OK:        true,
			SessionID: session.ID,
			UserID:    user.ID,
			Username:  user.Username,
		})
		return
	}

	expectedUsername := getExecutableName()
	if req.Username != expectedUsername || req.Password != h.token {
		c.JSON(http.StatusUnauthorized, LoginResponse{
			OK:    false,
			Error: "invalid credentials",
		})
		return
	}

	user := h.getOrCreateUser(expectedUsername, h.token)
	session := h.createSession(user.ID, req.Username)
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

// Status godoc
// @Summary Check auth status
// @Description Check if login is required and get current user info
// @Tags Auth
// @Produce json
// @Success 200 {object} StatusResponse
// @Router /api/auth/status [get]
func (h *AuthHandler) Status(c *gin.Context) {
	if h.token == "" {
		user := h.getOrCreateAnonymousUser()
		c.JSON(http.StatusOK, StatusResponse{
			NeedLogin: false,
			Username:  user.Username,
			UserID:    user.ID,
		})
		return
	}

	c.JSON(http.StatusOK, StatusResponse{
		NeedLogin: true,
		Username:  getExecutableName(),
	})
}

// Logout godoc
// @Summary User logout
// @Description End user session
// @Tags Auth
// @Produce json
// @Success 200 {object} map[string]bool
// @Router /api/auth/logout [post]
func (h *AuthHandler) Logout(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *AuthHandler) getOrCreateAnonymousUser() *model.User {
	var user model.User
	if err := h.db.First(&user, "username = ?", "anonymous").Error; err == nil {
		return &user
	}

	now := time.Now().Unix()
	user = model.User{
		ID:          uuid.New().String(),
		Username:    "anonymous",
		CreatedAt:   now,
		LastLoginAt: now,
	}
	h.db.Create(&user)
	return &user
}

func (h *AuthHandler) getOrCreateUser(username, token string) *model.User {
	var user model.User
	tokenHash := hashToken(token)

	if err := h.db.First(&user, "username = ?", username).Error; err == nil {
		h.db.Model(&user).Updates(map[string]any{
			"token_hash":    tokenHash,
			"last_login_at": time.Now().Unix(),
		})
		return &user
	}

	now := time.Now().Unix()
	user = model.User{
		ID:          uuid.New().String(),
		Username:    username,
		TokenHash:   tokenHash,
		CreatedAt:   now,
		LastLoginAt: now,
	}
	h.db.Create(&user)
	return &user
}

func (h *AuthHandler) createSession(userID, sessionName string) *model.UserSession {
	now := time.Now().Unix()
	name := sessionName
	if name == "" {
		name = "Default Session"
	}
	session := model.UserSession{
		ID:        uuid.New().String(),
		UserID:    userID,
		Name:      name,
		State:     "{}",
		CreatedAt: now,
		UpdatedAt: now,
	}
	h.db.Create(&session)
	return &session
}

func hashToken(token string) string {
	hash := sha256.Sum256([]byte(token))
	return hex.EncodeToString(hash[:])
}

func getExecutableName() string {
	exe, err := os.Executable()
	if err != nil {
		return "vibego"
	}
	return filepath.Base(exe)
}
