package terminal

const (
	MsgInput  byte = '0'
	MsgPing   byte = '2'
	MsgResize byte = '4'

	MsgOutput         byte = '1'
	MsgPong           byte = '3'
	MsgSetWindowTitle byte = '5'
	MsgSetBufferSize  byte = '6'
)

type ResizeMessage struct {
	Cols int `json:"cols"`
	Rows int `json:"rows"`
}
