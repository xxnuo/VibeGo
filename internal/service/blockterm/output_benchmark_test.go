package blockterm

import (
	"bytes"
	"path/filepath"
	"testing"
	"time"
)

// Sparse block output forces the unindexed query to inspect unrelated events.
// This is an in-process SQLite read benchmark, not an HTTP/download benchmark.
func BenchmarkSparseBlockOutput(b *testing.B) {
	for _, name := range []string{"unindexed", "indexed"} {
		b.Run(name, func(b *testing.B) {
			s, err := Open(filepath.Join(b.TempDir(), "core.sqlite"), "bash")
			if err != nil {
				b.Fatal(err)
			}
			defer s.Close()
			if err := s.db.Migrator().DropIndex(&Event{}, "idx_blockterm_output"); err != nil {
				b.Fatal(err)
			}
			payload := bytes.Repeat([]byte("x"), 128)
			var events []Event
			for index := 1; index <= 50000; index++ {
				block := "other"
				if index%5000 == 0 {
					block = "target"
				}
				events = append(events, Event{SessionID: "session", Seq: uint64(index), Type: "output", BlockID: block, Data: payload})
			}
			if err := s.db.CreateInBatches(events, 500).Error; err != nil {
				b.Fatal(err)
			}
			var build time.Duration
			if name == "indexed" {
				started := time.Now()
				if err := s.db.Migrator().CreateIndex(&Event{}, "idx_blockterm_output"); err != nil {
					b.Fatal(err)
				}
				build = time.Since(started)
			}
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				output, err := s.Output("session", "target", 0)
				if err != nil {
					b.Fatal(err)
				}
				if len(output) != 10 || output[0].Seq != 5000 || output[9].Seq != 50000 {
					b.Fatal("unexpected sparse output")
				}
			}
			b.StopTimer()
			if build > 0 {
				b.ReportMetric(float64(build.Microseconds())/1000, "index-build-ms")
			}
		})
	}
}
