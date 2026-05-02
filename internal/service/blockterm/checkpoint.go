package blockterm

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"reflect"
	"time"

	"github.com/charmbracelet/x/vt"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// ReplayCheckpointState identifies the committed event prefix represented by
// the terminal checkpoint. This does not contain or recreate a live PTY.
type ReplayCheckpointState struct {
	Version    int     `json:"version"`
	Session    Session `json:"session"`
	GridBlock  string  `json:"grid_block"`
	Current    *Block  `json:"current,omitempty"`
	Background *Block  `json:"background,omitempty"`
}

type storedCheckpoint struct {
	SessionID  string `gorm:"primaryKey"`
	Seq        uint64
	Metadata   []byte
	Terminal   []byte
	Digest     string
	CapturedAt int64
}

func (storedCheckpoint) TableName() string { return "terminal_checkpoints" }

var errCheckpointCorrupt = errors.New("stored terminal checkpoint is invalid")

func checkpointDigest(record *storedCheckpoint) string {
	h := sha256.New()
	var n [8]byte
	binary.LittleEndian.PutUint64(n[:], record.Seq)
	_, _ = h.Write(n[:])
	binary.LittleEndian.PutUint64(n[:], uint64(record.CapturedAt))
	_, _ = h.Write(n[:])
	for _, data := range [][]byte{[]byte(record.SessionID), record.Metadata, record.Terminal} {
		binary.LittleEndian.PutUint64(n[:], uint64(len(data)))
		_, _ = h.Write(n[:])
		_, _ = h.Write(data)
	}
	return hex.EncodeToString(h.Sum(nil))
}

// SaveReplayCheckpoint stores one recoverable backend checkpoint per session.
// It does not prune events or change any client replay cursor. Automatic capture
// must remain disabled until the browser checkpoint protocol is implemented.
func (s *Service) SaveReplayCheckpoint(id, owner string) error {
	a, err := s.active(id)
	if err != nil {
		return err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if !controls(a, owner) || a.recordingStopped || a.accepted || a.cancelRequested || a.uncertainSubmit != "" || len(a.pendingOutput) != 0 || a.pendingFile != nil || a.vt == nil {
		return ErrConflict
	}
	if a.info.Cols != a.vt.Width() || a.info.Rows != a.vt.Height() {
		return ErrConflict
	}
	checkpoint, err := a.vt.Checkpoint()
	if err != nil {
		return err
	}
	terminal, err := checkpoint.MarshalBinary()
	if err != nil {
		return err
	}
	state := ReplayCheckpointState{Version: 1, Session: a.info, GridBlock: a.gridBlock, Current: a.current, Background: a.background}
	for _, block := range []*Block{state.Current, state.Background} {
		if block != nil && (block.ID == "" || block.SessionID != id) {
			return ErrConflict
		}
	}
	metadata, err := json.Marshal(state)
	if err != nil {
		return err
	}
	if len(metadata) > 8*MaxCommandBytes {
		return errCheckpointCorrupt
	}
	var roundTrip ReplayCheckpointState
	if err := json.Unmarshal(metadata, &roundTrip); err != nil || !reflect.DeepEqual(state, roundTrip) {
		return errCheckpointCorrupt
	}
	record := storedCheckpoint{SessionID: id, Seq: a.info.Seq, Metadata: metadata, Terminal: terminal, CapturedAt: time.Now().UnixMilli()}
	record.Digest = checkpointDigest(&record)
	return s.db.Transaction(func(tx *gorm.DB) error {
		var committed Session
		if err := tx.First(&committed, "id = ?", id).Error; err != nil {
			return err
		}
		if !reflect.DeepEqual(committed, a.info) {
			return ErrConflict
		}
		for _, block := range []*Block{a.current, a.background} {
			if block == nil {
				continue
			}
			var stored Block
			if err := tx.First(&stored, "id = ? AND session_id = ?", block.ID, id).Error; err != nil {
				if errors.Is(err, gorm.ErrRecordNotFound) {
					return ErrConflict
				}
				return err
			}
			if !reflect.DeepEqual(stored, *block) {
				return ErrConflict
			}
			var event Event
			if err := tx.Where("session_id = ? AND block_id = ? AND type = ? AND seq <= ?", id, block.ID, "block", record.Seq).Order("seq DESC").First(&event).Error; err != nil {
				if errors.Is(err, gorm.ErrRecordNotFound) {
					return ErrConflict
				}
				return err
			}
			var replayed Block
			if err := json.Unmarshal(event.Data, &replayed); err != nil || !reflect.DeepEqual(replayed, *block) {
				return ErrConflict
			}
		}
		if a.gridBlock != "" {
			var grid Block
			if err := tx.First(&grid, "id = ? AND session_id = ?", a.gridBlock, id).Error; err != nil {
				if errors.Is(err, gorm.ErrRecordNotFound) {
					return ErrConflict
				}
				return err
			}
		}
		var old storedCheckpoint
		if err := tx.First(&old, "session_id = ?", id).Error; err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		if old.Seq > record.Seq {
			return ErrConflict
		}
		return tx.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "session_id"}}, UpdateAll: true}).Create(&record).Error
	})
}

// ReplayCheckpoint verifies the stored prefix and returns isolated state. A
// checksum detects accidental corruption; it is not an authentication boundary.
func (s *Service) ReplayCheckpoint(id string) (ReplayCheckpointState, *vt.Checkpoint, error) {
	var record storedCheckpoint
	var committed Session
	err := s.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.First(&committed, "id = ?", id).Error; err != nil {
			return err
		}
		return tx.First(&record, "session_id = ?", id).Error
	})
	if err != nil {
		return ReplayCheckpointState{}, nil, err
	}
	if record.SessionID != id || record.Seq > committed.Seq || len(record.Metadata) > 8*MaxCommandBytes || len(record.Terminal) > 8<<20 || record.Digest != checkpointDigest(&record) {
		return ReplayCheckpointState{}, nil, errCheckpointCorrupt
	}
	var state ReplayCheckpointState
	if err := json.Unmarshal(record.Metadata, &state); err != nil || state.Version != 1 || state.Session.ID != id || state.Session.Seq != record.Seq {
		return ReplayCheckpointState{}, nil, errCheckpointCorrupt
	}
	for _, block := range []*Block{state.Current, state.Background} {
		if block != nil && (block.ID == "" || block.SessionID != id) {
			return ReplayCheckpointState{}, nil, errCheckpointCorrupt
		}
	}
	checkpoint, err := vt.DecodeCheckpoint(record.Terminal)
	if err != nil {
		return ReplayCheckpointState{}, nil, err
	}
	cols, rows := checkpoint.Dimensions()
	if cols != state.Session.Cols || rows != state.Session.Rows {
		return ReplayCheckpointState{}, nil, errCheckpointCorrupt
	}
	return state, checkpoint, nil
}
