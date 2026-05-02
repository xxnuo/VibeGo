package remotedesktop

import (
	"sync"
	"time"
)

const (
	qosGoodDelayMs = int64(120)
	qosBadDelayMs  = int64(260)
)

type QoS struct {
	mu               sync.Mutex
	targetFPS        int
	targetQuality    int
	effectiveFPS     int
	effectiveQuality int
	lastAckSeq       uint64
	lastAckAt        time.Time
	lastFrameSeq     uint64
}

type QoSSnapshot struct {
	TargetFPS        int    `json:"targetFps"`
	TargetQuality    int    `json:"targetQuality"`
	EffectiveFPS     int    `json:"effectiveFps"`
	EffectiveQuality int    `json:"effectiveQuality"`
	LastAckSeq       uint64 `json:"lastAckSeq"`
	PendingFrames    uint64 `json:"pendingFrames"`
}

func NewQoS(cfg Config) *QoS {
	cfg = NormalizeConfig(cfg)
	return &QoS{
		targetFPS:        cfg.FPS,
		targetQuality:    cfg.Quality,
		effectiveFPS:     cfg.FPS,
		effectiveQuality: cfg.Quality,
	}
}

func (q *QoS) Configure(cfg Config) Config {
	cfg = NormalizeConfig(cfg)
	q.mu.Lock()
	q.targetFPS = cfg.FPS
	q.targetQuality = cfg.Quality
	if q.effectiveFPS <= 0 || q.effectiveFPS > cfg.FPS {
		q.effectiveFPS = cfg.FPS
	}
	if q.effectiveQuality <= 0 || q.effectiveQuality > cfg.Quality {
		q.effectiveQuality = cfg.Quality
	}
	cfg.FPS = q.effectiveFPS
	cfg.Quality = q.effectiveQuality
	q.mu.Unlock()
	return cfg
}

func (q *QoS) Config(base Config) Config {
	base = NormalizeConfig(base)
	q.mu.Lock()
	base.FPS = q.effectiveFPS
	base.Quality = q.effectiveQuality
	q.mu.Unlock()
	return base
}

func (q *QoS) FrameSent(seq uint64) {
	q.mu.Lock()
	q.lastFrameSeq = seq
	q.mu.Unlock()
}

func (q *QoS) Ack(seq uint64, delayMs int64) QoSSnapshot {
	q.mu.Lock()
	defer q.mu.Unlock()
	if seq > q.lastAckSeq {
		q.lastAckSeq = seq
	}
	q.lastAckAt = time.Now()
	if delayMs >= qosBadDelayMs || q.pendingFramesLocked() > 2 {
		q.effectiveFPS = maxInt(MinFPS, q.effectiveFPS-2)
		q.effectiveQuality = maxInt(MinQuality, q.effectiveQuality-5)
	} else if delayMs > 0 && delayMs <= qosGoodDelayMs {
		if q.effectiveFPS < q.targetFPS {
			q.effectiveFPS++
		}
		if q.effectiveQuality < q.targetQuality {
			q.effectiveQuality += 2
			if q.effectiveQuality > q.targetQuality {
				q.effectiveQuality = q.targetQuality
			}
		}
	}
	return q.snapshotLocked()
}

func (q *QoS) Tick() QoSSnapshot {
	q.mu.Lock()
	defer q.mu.Unlock()
	if !q.lastAckAt.IsZero() && time.Since(q.lastAckAt) > 2*time.Second && q.lastFrameSeq > q.lastAckSeq {
		q.effectiveFPS = maxInt(MinFPS, q.effectiveFPS-1)
		q.effectiveQuality = maxInt(MinQuality, q.effectiveQuality-3)
	}
	return q.snapshotLocked()
}

func (q *QoS) Snapshot() QoSSnapshot {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.snapshotLocked()
}

func (q *QoS) snapshotLocked() QoSSnapshot {
	return QoSSnapshot{
		TargetFPS:        q.targetFPS,
		TargetQuality:    q.targetQuality,
		EffectiveFPS:     q.effectiveFPS,
		EffectiveQuality: q.effectiveQuality,
		LastAckSeq:       q.lastAckSeq,
		PendingFrames:    q.pendingFramesLocked(),
	}
}

func (q *QoS) pendingFramesLocked() uint64 {
	if q.lastFrameSeq <= q.lastAckSeq {
		return 0
	}
	return q.lastFrameSeq - q.lastAckSeq
}
