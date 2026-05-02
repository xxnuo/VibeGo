package blockterm

import (
	"bytes"
	"encoding/json"
	"path/filepath"
	"testing"
)

func TestSessionExitCodeMigrationPreservesUnknownAndKnownResults(t *testing.T) {
	path := filepath.Join(t.TempDir(), "exit-code.sqlite")
	s, err := Open(path, "bash")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.db.Migrator().DropColumn(&Session{}, "ExitCode"); err != nil {
		s.Close()
		t.Fatal(err)
	}
	if err := s.db.Migrator().DropColumn(&Session{}, "ExitSignal"); err != nil {
		s.Close()
		t.Fatal(err)
	}
	if err := s.db.Exec("INSERT INTO sessions (id,group_id,phase,seq) VALUES (?,?,?,?)", "legacy", "group", "exited", 1).Error; err != nil {
		s.Close()
		t.Fatal(err)
	}
	raw := []byte(`{"id":"legacy","group_id":"group","phase":"exited","seq":1}`)
	if err := s.db.Create(&Event{SessionID: "legacy", Seq: 1, Type: "state", Data: raw}).Error; err != nil {
		s.Close()
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	for attempt := 0; attempt < 2; attempt++ {
		s, err = Open(path, "bash")
		if err != nil {
			t.Fatal(err)
		}
		func() {
			defer s.Close()
			legacy, err := s.Get("legacy")
			if err != nil || legacy.ExitCode != nil || legacy.ExitSignal != "" || legacy.Phase != "exited" || legacy.Seq != 1 {
				t.Fatalf("legacy result changed: %+v %v", legacy, err)
			}
			encoded, err := json.Marshal(legacy)
			if err != nil || bytes.Contains(encoded, []byte(`"exit_code"`)) || bytes.Contains(encoded, []byte(`"exit_signal"`)) {
				t.Fatalf("unknown code serialized: %s %v", encoded, err)
			}
			events, err := s.Events("legacy", 0)
			if err != nil || len(events) != 1 || !bytes.Equal(events[0].Data, raw) {
				t.Fatalf("legacy events changed: %+v %v", events, err)
			}
			if attempt == 0 {
				if err := s.db.Create(&Session{ID: "signal", Phase: "exited", ExitSignal: "killed"}).Error; err != nil {
					t.Fatal(err)
				}
				for id, code := range map[string]int{"zero": 0, "nonzero": 23} {
					code := code
					if err := s.db.Create(&Session{ID: id, Phase: "exited", ExitCode: &code}).Error; err != nil {
						t.Fatal(err)
					}
				}
			} else {
				signal, err := s.Get("signal")
				if err != nil || signal.ExitSignal != "killed" || signal.ExitCode != nil {
					t.Fatalf("signal result lost: %+v %v", signal, err)
				}
				for id, code := range map[string]int{"zero": 0, "nonzero": 23} {
					stored, err := s.Get(id)
					if err != nil || stored.ExitCode == nil || *stored.ExitCode != code || stored.ExitSignal != "" {
						t.Fatalf("known result lost: %+v %v", stored, err)
					}
				}
			}
		}()
	}
}

func TestExecutionTimestampMigrationPreservesLegacyHistory(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy.sqlite")
	s, err := Open(path, "bash")
	if err != nil {
		t.Fatal(err)
	}
	// Build the previous schema in a disposable database, never a user database.
	if err := s.db.Migrator().DropColumn(&Block{}, "StartedAt"); err != nil {
		s.Close()
		t.Fatal(err)
	}
	if s.db.Migrator().HasColumn(&Block{}, "StartedAt") {
		s.Close()
		t.Fatal("legacy fixture still has started_at")
	}
	if err := s.db.Create(&Session{ID: "legacy", GroupID: "group", Phase: "exited", Seq: 1}).Error; err != nil {
		s.Close()
		t.Fatal(err)
	}
	if err := s.db.Exec("INSERT INTO blocks (id,session_id,command,kind,status,exit_code,created_at,finished_at) VALUES (?,?,?,?,?,?,?,?)", "old", "legacy", "echo original", "command", "done", 0, 1000, 1500).Error; err != nil {
		s.Close()
		t.Fatal(err)
	}
	raw := []byte(`{"id":"old","session_id":"legacy","command":"echo original","kind":"command","status":"done","exit_code":0,"created_at":1000,"finished_at":1500}`)
	if err := s.db.Create(&Event{SessionID: "legacy", Seq: 1, Type: "block", BlockID: "old", Data: raw}).Error; err != nil {
		s.Close()
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	for attempt := 0; attempt < 2; attempt++ {
		s, err = Open(path, "bash")
		if err != nil {
			t.Fatal(err)
		}
		func() {
			defer s.Close()
			if !s.db.Migrator().HasColumn(&Block{}, "StartedAt") {
				t.Fatal("execution timestamp column missing")
			}
			var block Block
			if err := s.db.First(&block, "id = ?", "old").Error; err != nil {
				t.Fatal(err)
			}
			if block.Command != "echo original" || block.StartedAt != 0 || block.CreatedAt != 1000 || block.FinishedAt != 1500 || block.ExitCode == nil || *block.ExitCode != 0 {
				t.Fatalf("legacy block changed: %+v", block)
			}
			events, err := s.Events("legacy", 0)
			if err != nil {
				t.Fatal(err)
			}
			if len(events) != 1 || !bytes.Equal(events[0].Data, raw) {
				t.Fatalf("legacy replay changed: %+v", events)
			}
		}()
	}
}
