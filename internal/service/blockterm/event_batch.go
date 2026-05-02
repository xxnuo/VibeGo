package blockterm

import "gorm.io/gorm"

// This is a raw payload budget, not a JSON/WebSocket frame size limit.
const eventBatchBytes = 1 << 20

// Stream bytes remain ordered across events; UTF-8 and ANSI sequences may span
// boundaries and are decoded by the same continuous terminal parser.
const maxStreamEventBytes = 64 << 10

func readEventBatch(query *gorm.DB) ([]Event, bool, error) {
	var sizes []struct {
		Seq       uint64
		DataBytes int64
	}
	// One lookahead row makes has_more independent of the payload byte budget.
	if err := query.Session(&gorm.Session{}).Model(&Event{}).
		Select("seq, coalesce(length(data), 0) AS data_bytes").Order("seq").Limit(129).Scan(&sizes).Error; err != nil {
		return nil, false, err
	}
	result := []Event{}
	if len(sizes) == 0 {
		return result, false, nil
	}
	var total int64
	var last uint64
	for index, size := range sizes {
		// An indivisible oversized event must still make progress on its own.
		if index >= 128 || (index > 0 && size.DataBytes > eventBatchBytes-total) {
			break
		}
		total += size.DataBytes
		last = size.Seq
	}
	err := query.Session(&gorm.Session{}).Where("seq <= ?", last).Order("seq").Limit(128).Find(&result).Error
	return result, last < sizes[len(sizes)-1].Seq, err
}
