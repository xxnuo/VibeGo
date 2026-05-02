package terminal

import (
	"log"
	"time"

	"github.com/xxnuo/vibego/internal/model"
)

func (m *Manager) flushHistoryToDB(at *activeTerminal) error {
	at.stateMu.Lock()
	defer at.stateMu.Unlock()
	at.sessionMu.RLock()
	session := cloneTerminalSession(at.Session)
	at.sessionMu.RUnlock()
	data := at.historyBuffer.Read()
	_, cursor := at.historyBuffer.CursorRange()

	now := time.Now().Unix()
	if err := m.saveSnapshot(&TerminalSnapshot{
		SessionID:   at.ID,
		Data:        data,
		Cursor:      cursor,
		Cols:        session.Cols,
		Rows:        session.Rows,
		Status:      session.Status,
		ExitCode:    session.ExitCode,
		RuntimeType: session.RuntimeType,
		Readonly:    session.Readonly,
		UpdatedAt:   now,
	}); err != nil {
		return err
	}

	at.sessionMu.Lock()
	at.Session.HistorySize = int64(len(data))
	at.sessionMu.Unlock()

	if m.historyMaxRecords > 0 {
		m.pruneOldHistoryRecords(at.ID)
	}

	return nil
}

func (m *Manager) pruneOldHistoryRecords(sessionID string) error {
	var count int64
	m.db.Model(&model.TerminalHistory{}).Where("session_id = ?", sessionID).Count(&count)

	if count <= int64(m.historyMaxRecords) {
		return nil
	}

	toDelete := count - int64(m.historyMaxRecords)
	return m.db.Where("session_id = ? AND id IN (SELECT id FROM terminal_history WHERE session_id = ? ORDER BY created_at ASC LIMIT ?)",
		sessionID, sessionID, toDelete).
		Delete(&model.TerminalHistory{}).Error
}

func (m *Manager) CleanupExpiredHistory() error {
	if m.historyMaxAge <= 0 {
		return nil
	}

	cutoff := time.Now().Add(-m.historyMaxAge).Unix()
	return m.db.Where("created_at < ?", cutoff).Delete(&model.TerminalHistory{}).Error
}

func (m *Manager) flushHistory(at *activeTerminal) {
	if at.flushDone != nil {
		defer close(at.flushDone)
	}
	for {
		select {
		case <-at.Done:
			return
		default:
		}

		select {
		case <-at.flushTicker.C:
			at.historyMu.Lock()
			if err := m.flushHistoryToDB(at); err != nil {
				log.Printf("terminal history periodic flush failed for terminal %s: %v", at.ID, err)
			}
			at.historyMu.Unlock()
		case <-at.flushStop:
			return
		case <-at.Done:
			return
		}
	}
}

func (m *Manager) loadHistoryFromDB(sessionID string) ([]byte, error) {
	snapshot, err := m.loadSnapshot(sessionID)
	if err != nil {
		return nil, err
	}
	if snapshot == nil {
		return nil, nil
	}
	return snapshot.Data, nil
}
