package blockterm

import (
	"io"
	"os"
)

// Called with the session lock held. Small speculative output stays in memory;
// larger output is private, temporary, and never exposed as replay until flush.
func (a *activeSession) bufferPending(data []byte) error {
	if a.pendingFile == nil && len(a.pendingOutput)+len(data) <= maxStreamEventBytes {
		a.pendingOutput = append(a.pendingOutput, data...)
		return nil
	}
	if a.pendingFile == nil {
		f, err := os.CreateTemp(a.temp, "pending-output-*")
		if err != nil {
			return err
		}
		a.pendingFile = f
		if _, err := f.Write(a.pendingOutput); err != nil {
			return err
		}
		a.pendingOutput = nil
	}
	_, err := a.pendingFile.Write(data)
	return err
}

func (a *activeSession) clearPending() {
	a.pendingOutput = nil
	if a.pendingFile != nil {
		name := a.pendingFile.Name()
		_ = a.pendingFile.Close()
		_ = os.Remove(name)
		a.pendingFile = nil
	}
}

func (s *Service) flushPending(a *activeSession) error {
	defer a.clearPending()
	if a.current == nil {
		return nil
	}
	if a.pendingFile == nil {
		if len(a.pendingOutput) == 0 {
			return nil
		}
		return s.append(a, "output", a.current.ID, a.pendingOutput)
	}
	if _, err := a.pendingFile.Seek(0, io.SeekStart); err != nil {
		return err
	}
	buffer := make([]byte, maxStreamEventBytes)
	for {
		n, err := a.pendingFile.Read(buffer)
		if n > 0 {
			if saveErr := s.append(a, "output", a.current.ID, buffer[:n]); saveErr != nil {
				return saveErr
			}
		}
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
	}
}
