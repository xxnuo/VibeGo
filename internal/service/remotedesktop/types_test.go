package remotedesktop

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/color"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestMapNormalizedPointClampsToDisplayBounds(t *testing.T) {
	display := Display{X: 10, Y: 20, Width: 100, Height: 50}

	x, y := MapNormalizedPoint(display, -1, 2)
	require.Equal(t, 10, x)
	require.Equal(t, 69, y)

	x, y = MapNormalizedPoint(display, 0.5, 0.5)
	require.Equal(t, 60, x)
	require.Equal(t, 45, y)
}

func TestEncodeDecodeFrame(t *testing.T) {
	meta := FrameMetadata{
		Type:         "frame",
		Seq:          9,
		DisplayID:    1,
		Width:        800,
		Height:       600,
		Format:       "jpeg",
		Quality:      70,
		CapturedAt:   123,
		SentAt:       456,
		CaptureMs:    7,
		EncodeMs:     8,
		SourceWidth:  800,
		SourceHeight: 600,
	}
	jpegBytes := []byte{1, 2, 3}

	data, err := EncodeFrame(meta, jpegBytes)
	require.NoError(t, err)

	gotMeta, gotJPEG, err := DecodeFrame(data)
	require.NoError(t, err)
	require.Equal(t, meta, gotMeta)
	require.Equal(t, jpegBytes, gotJPEG)
}

func TestNormalizeConfig(t *testing.T) {
	cfg := NormalizeConfig(Config{FPS: 200, Quality: 1})
	require.Equal(t, MaxFPS, cfg.FPS)
	require.Equal(t, MinQuality, cfg.Quality)
	require.Equal(t, "contain", cfg.FitMode)
	require.Equal(t, "control", cfg.ControlMode)

	cfg = NormalizeConfig(Config{})
	require.Equal(t, DefaultFPS, cfg.FPS)
	require.Equal(t, DefaultQuality, cfg.Quality)
}

func TestSessionCaptureFrame(t *testing.T) {
	capture := &fakeCapture{
		displays: []Display{{ID: 0, Width: 2, Height: 2}},
		img:      image.NewRGBA(image.Rect(0, 0, 2, 2)),
	}
	capture.img.Set(0, 0, color.White)
	session := NewSession(capture, &fakeInput{}, &fakeClipboard{}, Config{})

	frame, err := session.CaptureFrame(context.Background())
	require.NoError(t, err)
	require.Equal(t, uint64(1), frame.Metadata.Seq)
	require.Equal(t, 2, frame.Metadata.Width)
	require.True(t, bytes.HasPrefix(frame.JPEG, []byte{0xff, 0xd8}))
}

func TestSessionClipboardError(t *testing.T) {
	session := NewSession(&fakeCapture{}, &fakeInput{}, &fakeClipboard{err: errors.New("no clipboard")}, Config{})

	_, err := session.ReadClipboard()
	require.Error(t, err)

	err = session.WriteClipboard("x")
	require.Error(t, err)
}

func TestClipboardTextLimit(t *testing.T) {
	require.NoError(t, ValidateClipboardText("ok"))
	require.Error(t, ValidateClipboardText(string(bytes.Repeat([]byte("x"), MaxClipboardTextBytes+1))))
}

func TestQoSAdjustsEffectiveConfig(t *testing.T) {
	qos := NewQoS(Config{FPS: 12, Quality: 70})
	qos.FrameSent(5)
	snapshot := qos.Ack(1, 320)
	require.Less(t, snapshot.EffectiveFPS, 12)
	require.Less(t, snapshot.EffectiveQuality, 70)

	for i := 0; i < 10; i++ {
		snapshot = qos.Ack(5, 30)
	}
	require.LessOrEqual(t, snapshot.EffectiveFPS, 12)
	require.LessOrEqual(t, snapshot.EffectiveQuality, 70)
	require.Greater(t, snapshot.EffectiveFPS, MinFPS)
}

func TestSelectDisplayFallback(t *testing.T) {
	displays := []Display{{ID: 2}, {ID: 4, Primary: true}}
	require.Equal(t, 2, SelectDisplay(displays, 2))
	require.Equal(t, 4, SelectDisplay(displays, 9))
}

type fakeCapture struct {
	displays []Display
	img      *image.RGBA
	err      error
}

func (f *fakeCapture) Displays() ([]Display, error) {
	if f.err != nil {
		return nil, f.err
	}
	return f.displays, nil
}

func (f *fakeCapture) Capture(displayID int) (image.Image, Display, error) {
	if f.err != nil {
		return nil, Display{}, f.err
	}
	for _, display := range f.displays {
		if display.ID == displayID {
			return f.img, display, nil
		}
	}
	return nil, Display{}, ErrDisplayNotFound
}

type fakeInput struct{}

func (f *fakeInput) Available() error                                    { return nil }
func (f *fakeInput) Move(x, y int) error                                 { return nil }
func (f *fakeInput) Button(button string, down bool) error               { return nil }
func (f *fakeInput) Click(button string) error                           { return nil }
func (f *fakeInput) Wheel(x, y int) error                                { return nil }
func (f *fakeInput) Key(key string, down bool, modifiers []string) error { return nil }
func (f *fakeInput) Text(text string) error                              { return nil }

type fakeClipboard struct {
	text string
	err  error
}

func (f *fakeClipboard) Available() error          { return f.err }
func (f *fakeClipboard) ReadText() (string, error) { return f.text, f.err }
func (f *fakeClipboard) WriteText(text string) error {
	if f.err != nil {
		return f.err
	}
	f.text = text
	return nil
}
