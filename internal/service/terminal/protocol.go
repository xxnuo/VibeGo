package terminal

const (
	MsgTypeCmd       = "cmd"
	MsgTypeResize    = "resize"
	MsgTypeHeartbeat = "heartbeat"
)

type WSMessage struct {
	Type      string `json:"type"`
	Data      string `json:"data,omitempty"`
	Cols      int    `json:"cols,omitempty"`
	Rows      int    `json:"rows,omitempty"`
	Timestamp int64  `json:"timestamp,omitempty"`
}

type ResizeMessage struct {
	Cols int `json:"cols"`
	Rows int `json:"rows"`
}
