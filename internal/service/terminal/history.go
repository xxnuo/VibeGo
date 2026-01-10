package terminal

import (
	"time"
)

type TerminalHistory struct {
	ID        int64  `gorm:"column:id;primaryKey;autoIncrement" json:"id"`
	SessionID string `gorm:"column:session_id;index" json:"session_id"`
	Sequence  int64  `gorm:"column:sequence" json:"sequence"`
	Data      []byte `gorm:"column:data" json:"data"`
	CreatedAt int64  `gorm:"column:created_at" json:"created_at"`
}

func (TerminalHistory) TableName() string {
	return "terminal_history"
}

func (m *Manager) flushHistoryToDB(at *activeTerminal) error {
	data := at.historyBuffer.Read()
	if len(data) == 0 {
		return nil
	}

	history := &TerminalHistory{
		SessionID: at.ID,
		Data:      data,
		CreatedAt: time.Now().Unix(),
	}

	if err := m.db.Create(history).Error; err != nil {
		return err
	}

	m.db.Model(&TerminalSession{}).Where("id = ?", at.ID).Update("history_size", int64(len(data)))

	if m.historyMaxRecords > 0 {
		m.pruneOldHistoryRecords(at.ID)
	}

	return nil
}

func (m *Manager) pruneOldHistoryRecords(sessionID string) error {
	var count int64
	m.db.Model(&TerminalHistory{}).Where("session_id = ?", sessionID).Count(&count)

	if count <= int64(m.historyMaxRecords) {
		return nil
	}

	toDelete := count - int64(m.historyMaxRecords)
	return m.db.Where("session_id = ? AND id IN (SELECT id FROM terminal_history WHERE session_id = ? ORDER BY created_at ASC LIMIT ?)",
		sessionID, sessionID, toDelete).
		Delete(&TerminalHistory{}).Error
}

func (m *Manager) CleanupExpiredHistory() error {
	if m.historyMaxAge <= 0 {
		return nil
	}

	cutoff := time.Now().Add(-m.historyMaxAge).Unix()
	return m.db.Where("created_at < ?", cutoff).Delete(&TerminalHistory{}).Error
}

func (m *Manager) flushHistory(at *activeTerminal) {
	for {
		select {
		case <-at.flushTicker.C:
			at.historyMu.Lock()
			m.flushHistoryToDB(at)
			at.historyMu.Unlock()
		case <-at.Done:
			return
		}
	}
}

func (m *Manager) loadHistoryFromDB(sessionID string) ([]byte, error) {
	var histories []TerminalHistory
	if err := m.db.Where("session_id = ?", sessionID).
		Order("created_at ASC").
		Find(&histories).Error; err != nil {
		return nil, err
	}

	if len(histories) == 0 {
		return nil, nil
	}

	return histories[len(histories)-1].Data, nil
}
