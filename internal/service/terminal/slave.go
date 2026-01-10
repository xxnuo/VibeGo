package terminal

type slave interface {
	Read(p []byte) (n int, err error)
	Write(p []byte) (n int, err error)
	ResizeTerminal(cols, rows int) error
	WindowTitleVariables() map[string]interface{}
	Close() error
}
