package blocktermmodel

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"

	"github.com/xxnuo/vibego/internal/service/settings"
	"gorm.io/gorm"
)

const (
	SettingBaseURL       = "blockterm.model.base_url"
	SettingModel         = "blockterm.model.model"
	SettingMaxTokens     = "blockterm.model.max_tokens"
	SettingTimeout       = "blockterm.model.timeout_seconds"
	SettingAllowPrivate  = "blockterm.model.allow_private_network"
	SettingAPIToken      = "blockterm.model.api_token"
	DefaultBaseURL       = "https://api.openai.com/v1"
	DefaultModel         = "gpt-4o-mini"
	DefaultMaxTokens     = 2048
	DefaultTimeoutSecond = 120
	MaxConfigURLBytes    = 2048
	MaxModelBytes        = 256
)

var (
	ErrInvalidConfig   = errors.New("invalid model configuration")
	ErrMissingAPIToken = errors.New("model API token is not configured")
)

// PrivateSettingKeys are owned by the model service. The generic settings API
// must neither expose nor mutate them.
func PrivateSettingKeys() []string {
	keys := []string{
		SettingBaseURL,
		SettingModel,
		SettingMaxTokens,
		SettingTimeout,
		SettingAllowPrivate,
	}
	return append(keys, tokenSettingKeys()...)
}

// tokenSettingKeys returns the canonical token key followed by keys used by
// older versions. Keeping this list in one place is important: reading and
// revoking a token must agree about which persisted secrets belong to this
// service.
func tokenSettingKeys() []string {
	return []string{
		SettingAPIToken,
		"openai.api_token",
		"openai_api_token",
		"openaiToken",
		"model.api_token",
		"model_api_token",
	}
}

type Config struct {
	BaseURL             string `json:"base_url"`
	Model               string `json:"model"`
	MaxTokens           int    `json:"max_tokens"`
	TimeoutSecond       int    `json:"timeout_seconds"`
	AllowPrivateNetwork bool   `json:"allow_private_network"`
	APIToken            string `json:"-"`
}

func (c Config) APITokenSet() bool {
	return strings.TrimSpace(c.APIToken) != ""
}

type ConfigPatch struct {
	BaseURL             *string
	Model               *string
	MaxTokens           *int
	TimeoutSecond       *int
	AllowPrivateNetwork *bool
	APIToken            *string
}

func defaultConfig() Config {
	return Config{
		BaseURL:       DefaultBaseURL,
		Model:         DefaultModel,
		MaxTokens:     DefaultMaxTokens,
		TimeoutSecond: DefaultTimeoutSecond,
	}
}

func (s *Service) Config() (Config, error) {
	return loadConfig(s.settings)
}

func loadConfig(store *settings.Store) (Config, error) {
	cfg := defaultConfig()
	values, err := store.All()
	if err != nil {
		return Config{}, err
	}
	if value := strings.TrimSpace(values[SettingBaseURL]); value != "" {
		cfg.BaseURL = value
	}
	if value := strings.TrimSpace(values[SettingModel]); value != "" {
		cfg.Model = value
	}
	if value := strings.TrimSpace(values[SettingMaxTokens]); value != "" {
		if parsed, parseErr := strconv.Atoi(value); parseErr == nil {
			cfg.MaxTokens = parsed
		}
	}
	if value := strings.TrimSpace(values[SettingTimeout]); value != "" {
		if parsed, parseErr := strconv.Atoi(value); parseErr == nil {
			cfg.TimeoutSecond = parsed
		}
	}
	if value := strings.TrimSpace(values[SettingAllowPrivate]); value != "" {
		if parsed, parseErr := strconv.ParseBool(value); parseErr == nil {
			cfg.AllowPrivateNetwork = parsed
		}
	}
	for _, key := range tokenSettingKeys() {
		if value := strings.TrimSpace(values[key]); value != "" {
			cfg.APIToken = value
			break
		}
	}
	if err := validateConfigShape(cfg); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

func validateConfigShape(cfg Config) error {
	if err := validateBaseURLSyntax(cfg.BaseURL); err != nil {
		return err
	}
	if strings.TrimSpace(cfg.Model) == "" || len([]byte(cfg.Model)) > MaxModelBytes {
		return fmt.Errorf("%w: model must be between 1 and %d bytes", ErrInvalidConfig, MaxModelBytes)
	}
	if cfg.MaxTokens < 1 || cfg.MaxTokens > 1<<20 {
		return fmt.Errorf("%w: max_tokens must be between 1 and 1048576", ErrInvalidConfig)
	}
	if cfg.TimeoutSecond < 1 || cfg.TimeoutSecond > 3600 {
		return fmt.Errorf("%w: timeout_seconds must be between 1 and 3600", ErrInvalidConfig)
	}
	return nil
}

func validateBaseURLSyntax(raw string) error {
	raw = strings.TrimSpace(raw)
	if raw == "" || len(raw) > MaxConfigURLBytes {
		return fmt.Errorf("%w: base_url is required and must be at most %d bytes", ErrInvalidConfig, MaxConfigURLBytes)
	}
	u, err := url.Parse(raw)
	if err != nil || u == nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return fmt.Errorf("%w: base_url must use http or https", ErrInvalidConfig)
	}
	if u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return fmt.Errorf("%w: base_url must not contain credentials, query, or fragment", ErrInvalidConfig)
	}
	return nil
}

func ValidateBaseURL(raw string, allowPrivate bool) error {
	return validateBaseURLContext(context.Background(), raw, allowPrivate)
}

func validateBaseURLContext(ctx context.Context, raw string, allowPrivate bool) error {
	if err := validateBaseURLSyntax(raw); err != nil {
		return err
	}
	u, _ := url.Parse(strings.TrimSpace(raw))
	host := u.Hostname()
	var ips []net.IP
	if ip := net.ParseIP(host); ip != nil {
		ips = []net.IP{ip}
	} else {
		resolved, err := net.DefaultResolver.LookupIPAddr(ctx, host)
		if err != nil {
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				return err
			}
			return fmt.Errorf("%w: base_url host cannot be resolved", ErrInvalidConfig)
		}
		if len(resolved) == 0 {
			return fmt.Errorf("%w: base_url host cannot be resolved", ErrInvalidConfig)
		}
		ips = make([]net.IP, 0, len(resolved))
		for _, address := range resolved {
			ips = append(ips, address.IP)
		}
	}
	for _, ip := range ips {
		if !allowPrivate && isPrivateOrLocalIP(ip) {
			return fmt.Errorf("%w: base_url resolves to a private or local address", ErrInvalidConfig)
		}
	}
	if strings.EqualFold(u.Scheme, "http") {
		if !allowPrivate {
			return fmt.Errorf("%w: public base_url must use https", ErrInvalidConfig)
		}
		for _, ip := range ips {
			if !isPrivateOrLocalIP(ip) {
				return fmt.Errorf("%w: http base_url must resolve only to private or local addresses", ErrInvalidConfig)
			}
		}
	}
	return nil
}

func isPrivateOrLocalIP(ip net.IP) bool {
	return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() || ip.IsUnspecified() || ip.IsMulticast()
}

func (s *Service) SetConfig(patch ConfigPatch) (Config, error) {
	cfg, err := s.Config()
	if err != nil {
		cfg = defaultConfig()
	}
	if patch.BaseURL != nil {
		cfg.BaseURL = strings.TrimSpace(*patch.BaseURL)
	}
	if patch.Model != nil {
		cfg.Model = strings.TrimSpace(*patch.Model)
	}
	if patch.MaxTokens != nil {
		cfg.MaxTokens = *patch.MaxTokens
	}
	if patch.TimeoutSecond != nil {
		cfg.TimeoutSecond = *patch.TimeoutSecond
	}
	if patch.AllowPrivateNetwork != nil {
		cfg.AllowPrivateNetwork = *patch.AllowPrivateNetwork
	}
	if patch.APIToken != nil {
		cfg.APIToken = strings.TrimSpace(*patch.APIToken)
	}
	if err := validateConfigShape(cfg); err != nil {
		return Config{}, err
	}
	// An unrelated setting update must remain available when the provider's
	// DNS is temporarily unavailable. Re-check the endpoint when its URL or
	// private-network policy changes, before accepting a potentially unsafe
	// combination.
	if patch.BaseURL != nil || patch.AllowPrivateNetwork != nil {
		if err := ValidateBaseURL(cfg.BaseURL, cfg.AllowPrivateNetwork || s.allowPrivateNetwork); err != nil {
			return Config{}, err
		}
	}
	err = s.db.Transaction(func(tx *gorm.DB) error {
		store := settings.New(tx)
		if patch.BaseURL != nil {
			if err := store.Set(SettingBaseURL, cfg.BaseURL); err != nil {
				return err
			}
		}
		if patch.Model != nil {
			if err := store.Set(SettingModel, cfg.Model); err != nil {
				return err
			}
		}
		if patch.MaxTokens != nil {
			if err := store.Set(SettingMaxTokens, strconv.Itoa(cfg.MaxTokens)); err != nil {
				return err
			}
		}
		if patch.TimeoutSecond != nil {
			if err := store.Set(SettingTimeout, strconv.Itoa(cfg.TimeoutSecond)); err != nil {
				return err
			}
		}
		if patch.AllowPrivateNetwork != nil {
			if err := store.Set(SettingAllowPrivate, strconv.FormatBool(cfg.AllowPrivateNetwork)); err != nil {
				return err
			}
		}
		if patch.APIToken != nil {
			for _, key := range tokenSettingKeys() {
				if err := store.Delete(key); err != nil {
					return err
				}
			}
			if cfg.APIToken == "" {
				return nil
			}
			return store.Set(SettingAPIToken, cfg.APIToken)
		}
		return nil
	})
	if err != nil {
		return Config{}, err
	}
	return cfg, nil
}

func (s *Service) DeleteConfig() (Config, error) {
	err := s.db.Transaction(func(tx *gorm.DB) error {
		store := settings.New(tx)
		for _, key := range PrivateSettingKeys() {
			if err := store.Delete(key); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return Config{}, err
	}
	return s.Config()
}
