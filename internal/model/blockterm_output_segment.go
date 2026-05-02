package model

const BlockTermMaxPTYSize = 16 << 20

// BlockTermOutputSegment stores one contiguous range of raw PTY bytes that
// belongs to a command block. The shell integration OSC frames are used only
// as boundaries and are not included in Data.
type BlockTermOutputSegment struct {
	ID          string `gorm:"column:id;primaryKey;not null" json:"id"`
	TerminalID  string `gorm:"column:terminal_id;not null;index:idx_blockterm_output_segment_terminal;uniqueIndex:idx_blockterm_output_segment_range,priority:1" json:"terminal_id"`
	BlockID     string `gorm:"column:block_id;not null;index:idx_blockterm_output_segment_block;uniqueIndex:idx_blockterm_output_segment_range,priority:2" json:"block_id"`
	StartCursor uint64 `gorm:"column:start_cursor;not null;uniqueIndex:idx_blockterm_output_segment_range,priority:3" json:"start_cursor"`
	EndCursor   uint64 `gorm:"column:end_cursor;not null" json:"end_cursor"`
	Data        []byte `gorm:"column:data;type:blob;not null" json:"data"`
	CreatedAt   int64  `gorm:"column:created_at;not null;index" json:"created_at"`
}

func (BlockTermOutputSegment) TableName() string {
	return "blockterm_output_segments"
}
