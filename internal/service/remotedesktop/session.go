package remotedesktop

import (
	"bytes"
	"context"
	"encoding/json"
	"image/jpeg"
	"sync"
	"time"
)

type Session struct {
	capture CaptureProvider
	input   InputProvider
	clip    ClipboardProvider

	mu     sync.RWMutex
	config Config
	seq    uint64
}

func NewSession(capture CaptureProvider, input InputProvider, clip ClipboardProvider, cfg Config) *Session {
	return &Session{
		capture: capture,
		input:   input,
		clip:    clip,
		config:  NormalizeConfig(cfg),
	}
}

func (s *Session) Configure(cfg Config) Config {
	cfg = NormalizeConfig(cfg)
	s.mu.Lock()
	if cfg.DisplayID >= 0 {
		s.config.DisplayID = cfg.DisplayID
	}
	s.config.FPS = cfg.FPS
	s.config.Quality = cfg.Quality
	s.config.FitMode = cfg.FitMode
	s.config.ScalePercent = cfg.ScalePercent
	s.config.ScrollMode = cfg.ScrollMode
	s.config.QualityPreset = cfg.QualityPreset
	s.config.ControlMode = cfg.ControlMode
	s.config.KeyboardMode = cfg.KeyboardMode
	s.config.ShowLocalCursor = cfg.ShowLocalCursor
	s.config.ClipboardSync = cfg.ClipboardSync
	out := s.config
	s.mu.Unlock()
	return out
}

func (s *Session) Config() Config {
	s.mu.RLock()
	cfg := s.config
	s.mu.RUnlock()
	return cfg
}

func (s *Session) CaptureFrame(ctx context.Context) (Frame, error) {
	cfg := s.Config()
	select {
	case <-ctx.Done():
		return Frame{}, ctx.Err()
	default:
	}
	captureStarted := time.Now()
	img, display, err := s.capture.Capture(cfg.DisplayID)
	if err != nil {
		return Frame{}, err
	}
	captureMs := time.Since(captureStarted).Milliseconds()
	encodeStarted := time.Now()
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: cfg.Quality}); err != nil {
		return Frame{}, err
	}
	encodeMs := time.Since(encodeStarted).Milliseconds()
	s.mu.Lock()
	s.seq++
	seq := s.seq
	s.mu.Unlock()
	bounds := img.Bounds()
	return Frame{
		Metadata: FrameMetadata{
			Type:         "frame",
			Seq:          seq,
			DisplayID:    display.ID,
			Width:        bounds.Dx(),
			Height:       bounds.Dy(),
			Format:       "jpeg",
			Quality:      cfg.Quality,
			CapturedAt:   time.Now().UnixMilli(),
			CaptureMs:    captureMs,
			EncodeMs:     encodeMs,
			SourceWidth:  display.Width,
			SourceHeight: display.Height,
		},
		JPEG: buf.Bytes(),
	}, nil
}

func (s *Session) Pointer(displayID int, x, y float64, move bool) error {
	display, err := findDisplay(s.capture, displayID)
	if err != nil {
		return err
	}
	ax, ay := MapNormalizedPoint(display, x, y)
	if move {
		return s.input.Move(ax, ay)
	}
	return nil
}

func (s *Session) MoveRelative(displayID int, dx, dy int) error {
	display, err := findDisplay(s.capture, displayID)
	if err != nil {
		return err
	}
	x, y, err := s.input.Position()
	if err != nil {
		return err
	}
	x, y = ClampPointToDisplay(display, x+dx, y+dy)
	return s.input.Move(x, y)
}

func (s *Session) Button(button string, down *bool) error {
	if down == nil {
		return s.input.Click(button)
	}
	return s.input.Button(button, *down)
}

func (s *Session) Wheel(x, y int) error {
	return s.input.Wheel(x, y)
}

func (s *Session) Key(key string, down bool, modifiers []string) error {
	return s.input.Key(key, down, modifiers)
}

func (s *Session) Text(text string) error {
	return s.input.Text(text)
}

func (s *Session) ReadClipboard() (string, error) {
	return s.clip.ReadText()
}

func (s *Session) WriteClipboard(text string) error {
	if err := ValidateClipboardText(text); err != nil {
		return err
	}
	return s.clip.WriteText(text)
}

type ClientMessage struct {
	Type            string   `json:"type"`
	Version         int      `json:"version,omitempty"`
	DisplayID       *int     `json:"displayId,omitempty"`
	FPS             int      `json:"fps,omitempty"`
	Quality         int      `json:"quality,omitempty"`
	FitMode         string   `json:"fitMode,omitempty"`
	ScalePercent    int      `json:"scalePercent,omitempty"`
	ScrollMode      string   `json:"scrollMode,omitempty"`
	QualityPreset   string   `json:"qualityPreset,omitempty"`
	ControlMode     string   `json:"controlMode,omitempty"`
	KeyboardMode    string   `json:"keyboardMode,omitempty"`
	ShowLocalCursor *bool    `json:"showLocalCursor,omitempty"`
	ClipboardSync   *bool    `json:"clipboardSync,omitempty"`
	X               float64  `json:"x,omitempty"`
	Y               float64  `json:"y,omitempty"`
	DX              int      `json:"dx,omitempty"`
	DY              int      `json:"dy,omitempty"`
	Move            *bool    `json:"move,omitempty"`
	Relative        bool     `json:"relative,omitempty"`
	Button          string   `json:"button,omitempty"`
	Down            *bool    `json:"down,omitempty"`
	DeltaX          int      `json:"deltaX,omitempty"`
	DeltaY          int      `json:"deltaY,omitempty"`
	Key             string   `json:"key,omitempty"`
	Modifiers       []string `json:"modifiers,omitempty"`
	Text            string   `json:"text,omitempty"`
	SpecialKey      string   `json:"specialKey,omitempty"`
	Seq             uint64   `json:"seq,omitempty"`
	RenderMs        int64    `json:"renderMs,omitempty"`
	ReceivedAt      int64    `json:"receivedAt,omitempty"`
}

func ParseClientMessage(data []byte) (ClientMessage, error) {
	var msg ClientMessage
	err := json.Unmarshal(data, &msg)
	return msg, err
}

func findDisplay(capture CaptureProvider, id int) (Display, error) {
	displays, err := capture.Displays()
	if err != nil {
		return Display{}, err
	}
	for _, display := range displays {
		if display.ID == id {
			return display, nil
		}
	}
	return Display{}, ErrDisplayNotFound
}
