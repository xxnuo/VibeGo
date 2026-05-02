package remotedesktop

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"image"
	"math"
	"time"
)

const (
	DefaultFPS            = 12
	DefaultQuality        = 70
	MinFPS                = 1
	MaxFPS                = 20
	MinQuality            = 40
	MaxQuality            = 90
	MaxClipboardTextBytes = 256 * 1024
	ProtocolVersion       = 2
)

var ErrDisplayNotFound = errors.New("display not found")

type Display struct {
	ID      int  `json:"id"`
	X       int  `json:"x"`
	Y       int  `json:"y"`
	Width   int  `json:"width"`
	Height  int  `json:"height"`
	Scale   int  `json:"scale"`
	Primary bool `json:"primary"`
}

type Status struct {
	OS                 string       `json:"os"`
	Platform           string       `json:"platform"`
	SessionType        string       `json:"sessionType"`
	Available          bool         `json:"available"`
	CaptureAvailable   bool         `json:"captureAvailable"`
	InputAvailable     bool         `json:"inputAvailable"`
	ClipboardAvailable bool         `json:"clipboardAvailable"`
	Capabilities       Capabilities `json:"capabilities"`
	Wayland            bool         `json:"wayland"`
	Warnings           []string     `json:"warnings"`
	DefaultFPS         int          `json:"defaultFps"`
	DefaultQuality     int          `json:"defaultQuality"`
	MinFPS             int          `json:"minFps"`
	MaxFPS             int          `json:"maxFps"`
	MinQuality         int          `json:"minQuality"`
	MaxQuality         int          `json:"maxQuality"`
}

type Capabilities struct {
	Capture       bool `json:"capture"`
	Input         bool `json:"input"`
	Clipboard     bool `json:"clipboard"`
	DisplayWatch  bool `json:"displayWatch"`
	QoS           bool `json:"qos"`
	ClipboardSync bool `json:"clipboardSync"`
}

type CaptureProvider interface {
	Displays() ([]Display, error)
	Capture(displayID int) (image.Image, Display, error)
}

type InputProvider interface {
	Available() error
	Move(x, y int) error
	Button(button string, down bool) error
	Click(button string) error
	Wheel(x, y int) error
	Key(key string, down bool, modifiers []string) error
	Text(text string) error
}

type ClipboardProvider interface {
	Available() error
	ReadText() (string, error)
	WriteText(text string) error
}

type Config struct {
	DisplayID       int    `json:"displayId"`
	FPS             int    `json:"fps"`
	Quality         int    `json:"quality"`
	FitMode         string `json:"fitMode"`
	ScalePercent    int    `json:"scalePercent"`
	ScrollMode      string `json:"scrollMode"`
	QualityPreset   string `json:"qualityPreset"`
	ControlMode     string `json:"controlMode"`
	KeyboardMode    string `json:"keyboardMode"`
	ShowLocalCursor bool   `json:"showLocalCursor"`
	ClipboardSync   bool   `json:"clipboardSync"`
}

type FrameMetadata struct {
	Type         string `json:"type"`
	Seq          uint64 `json:"seq"`
	DisplayID    int    `json:"displayId"`
	Width        int    `json:"width"`
	Height       int    `json:"height"`
	Format       string `json:"format"`
	Quality      int    `json:"quality"`
	CapturedAt   int64  `json:"capturedAt"`
	SentAt       int64  `json:"sentAt"`
	CaptureMs    int64  `json:"captureMs"`
	EncodeMs     int64  `json:"encodeMs"`
	SourceWidth  int    `json:"sourceWidth"`
	SourceHeight int    `json:"sourceHeight"`
}

type Frame struct {
	Metadata FrameMetadata
	JPEG     []byte
}

func NormalizeConfig(cfg Config) Config {
	if cfg.FPS <= 0 {
		cfg.FPS = DefaultFPS
	}
	cfg.FPS = clampInt(cfg.FPS, MinFPS, MaxFPS)
	if cfg.Quality <= 0 {
		cfg.Quality = DefaultQuality
	}
	cfg.Quality = clampInt(cfg.Quality, MinQuality, MaxQuality)
	if cfg.FitMode == "" {
		cfg.FitMode = "contain"
	}
	if cfg.FitMode != "contain" && cfg.FitMode != "original" && cfg.FitMode != "custom" {
		cfg.FitMode = "contain"
	}
	if cfg.ScalePercent <= 0 {
		cfg.ScalePercent = 100
	}
	cfg.ScalePercent = clampInt(cfg.ScalePercent, 25, 300)
	if cfg.ScrollMode == "" {
		cfg.ScrollMode = "auto"
	}
	if cfg.ScrollMode != "auto" && cfg.ScrollMode != "scrollbar" && cfg.ScrollMode != "edge" {
		cfg.ScrollMode = "auto"
	}
	if cfg.QualityPreset == "" {
		cfg.QualityPreset = "balanced"
	}
	if cfg.QualityPreset != "smooth" && cfg.QualityPreset != "balanced" && cfg.QualityPreset != "sharp" && cfg.QualityPreset != "custom" {
		cfg.QualityPreset = "balanced"
	}
	if cfg.ControlMode == "" {
		cfg.ControlMode = "control"
	}
	if cfg.ControlMode != "control" && cfg.ControlMode != "view" {
		cfg.ControlMode = "control"
	}
	if cfg.KeyboardMode == "" {
		cfg.KeyboardMode = "legacy"
	}
	if cfg.KeyboardMode != "legacy" && cfg.KeyboardMode != "text" {
		cfg.KeyboardMode = "legacy"
	}
	return cfg
}

func ValidateClipboardText(text string) error {
	if len([]byte(text)) > MaxClipboardTextBytes {
		return errors.New("clipboard text too large")
	}
	return nil
}

func MapNormalizedPoint(display Display, nx, ny float64) (int, int) {
	if math.IsNaN(nx) || math.IsInf(nx, 0) {
		nx = 0
	}
	if math.IsNaN(ny) || math.IsInf(ny, 0) {
		ny = 0
	}
	nx = math.Max(0, math.Min(1, nx))
	ny = math.Max(0, math.Min(1, ny))
	x := display.X + int(math.Round(nx*float64(maxInt(display.Width-1, 0))))
	y := display.Y + int(math.Round(ny*float64(maxInt(display.Height-1, 0))))
	return x, y
}

func EncodeFrame(metadata FrameMetadata, jpegBytes []byte) ([]byte, error) {
	meta, err := json.Marshal(metadata)
	if err != nil {
		return nil, err
	}
	out := make([]byte, 4+len(meta)+len(jpegBytes))
	binary.BigEndian.PutUint32(out[:4], uint32(len(meta)))
	copy(out[4:], meta)
	copy(out[4+len(meta):], jpegBytes)
	return out, nil
}

func DecodeFrame(data []byte) (FrameMetadata, []byte, error) {
	var metadata FrameMetadata
	if len(data) < 4 {
		return metadata, nil, errors.New("frame too short")
	}
	metaLen := int(binary.BigEndian.Uint32(data[:4]))
	if metaLen <= 0 || 4+metaLen > len(data) {
		return metadata, nil, errors.New("invalid frame metadata length")
	}
	if err := json.Unmarshal(data[4:4+metaLen], &metadata); err != nil {
		return metadata, nil, err
	}
	return metadata, data[4+metaLen:], nil
}

func FrameInterval(fps int) time.Duration {
	fps = NormalizeConfig(Config{FPS: fps, Quality: DefaultQuality}).FPS
	return time.Second / time.Duration(fps)
}

func clampInt(v, minV, maxV int) int {
	if v < minV {
		return minV
	}
	if v > maxV {
		return maxV
	}
	return v
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
