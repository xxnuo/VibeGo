package remotedesktop

import "reflect"

type DisplaySnapshot struct {
	Displays []Display `json:"displays"`
	Changed  bool      `json:"changed"`
}

type DisplayManager struct {
	capture CaptureProvider
	last    []Display
}

func NewDisplayManager(capture CaptureProvider) *DisplayManager {
	return &DisplayManager{capture: capture}
}

func (m *DisplayManager) Refresh() (DisplaySnapshot, error) {
	displays, err := m.capture.Displays()
	if err != nil {
		return DisplaySnapshot{}, err
	}
	changed := !reflect.DeepEqual(m.last, displays)
	m.last = append([]Display(nil), displays...)
	return DisplaySnapshot{Displays: displays, Changed: changed}, nil
}

func SelectDisplay(displays []Display, current int) int {
	for _, display := range displays {
		if display.ID == current {
			return current
		}
	}
	for _, display := range displays {
		if display.Primary {
			return display.ID
		}
	}
	if len(displays) > 0 {
		return displays[0].ID
	}
	return current
}
