package utils

import "testing"

func TestGetLargestVersion(t *testing.T) {
	tests := []struct {
		name     string
		versions []string
		want     string
	}{
		{"empty versions", []string{}, ""},
		{"single version", []string{"1.0.0"}, "1.0.0"},
		{"short versions", []string{"1.0", "1.1", "1.2"}, "1.2"},
		{"mixed short versions", []string{"1", "1.1.0", "1.2", "2"}, "2"},
		{"basic versions", []string{"1.0.0", "1.0.1", "1.1.0"}, "1.1.0"},
		{"prerelease versions", []string{"1.0.0-alpha.1", "1.0.0-alpha.2", "1.0.0-alpha.3"}, "1.0.0-alpha.3"},
		{"mixed versions", []string{"1.0.0-alpha.1", "1.0.0", "1.0.1"}, "1.0.1"},
		{"release vs prerelease", []string{"1.0.0-beta.1", "1.0.0"}, "1.0.0"},
		{"complex versions", []string{"2.0.0", "1.9.9", "1.10.0", "1.9.10"}, "2.0.0"},
		{"different prerelease identifiers", []string{"1.0.0-alpha.1", "1.0.0-beta.1", "1.0.0-rc.1"}, "1.0.0-rc.1"},
		{"prerelease with numbers", []string{"1.0.0-1", "1.0.0-2", "1.0.0-10"}, "1.0.0-10"},
		{"prerelease longer wins", []string{"1.0.0-alpha", "1.0.0-alpha.1"}, "1.0.0-alpha.1"},
		{"prerelease shorter loses", []string{"1.0.0-alpha.1", "1.0.0-alpha"}, "1.0.0-alpha.1"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := GetLargestVersion(tt.versions); got != tt.want {
				t.Errorf("GetLargestVersion() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestCompareVersions(t *testing.T) {
	tests := []struct {
		v1, v2 string
		want   int
	}{
		{"1.0.0", "1.0.0", 0},
		{"1.0.1", "1.0.0", 1},
		{"1.0.0", "1.0.1", -1},
		{"2.0.0", "1.9.9", 1},
		{"1.0.0", "1.0.0-alpha", 1},
		{"1.0.0-alpha", "1.0.0", -1},
		{"1.0.0-beta", "1.0.0-alpha", 1},
		{"1.0.0-alpha.2", "1.0.0-alpha.1", 1},
		{"1.0.0-alpha.1", "1.0.0-alpha.2", -1},
		{"1.0.0-alpha.10", "1.0.0-alpha.2", 1},
	}

	for _, tt := range tests {
		t.Run(tt.v1+"_vs_"+tt.v2, func(t *testing.T) {
			if got := compareVersions(tt.v1, tt.v2); got != tt.want {
				t.Errorf("compareVersions(%s, %s) = %v, want %v", tt.v1, tt.v2, got, tt.want)
			}
		})
	}
}

func TestComparePrerelease(t *testing.T) {
	tests := []struct {
		p1, p2 string
		want   int
	}{
		{"alpha", "alpha", 0},
		{"beta", "alpha", 1},
		{"alpha", "beta", -1},
		{"alpha.1", "alpha.2", -1},
		{"alpha.2", "alpha.1", 1},
		{"1", "2", -1},
		{"10", "2", 1},
		{"alpha.1", "alpha", 1},
		{"alpha", "alpha.1", -1},
	}

	for _, tt := range tests {
		t.Run(tt.p1+"_vs_"+tt.p2, func(t *testing.T) {
			if got := comparePrerelease(tt.p1, tt.p2); got != tt.want {
				t.Errorf("comparePrerelease(%s, %s) = %v, want %v", tt.p1, tt.p2, got, tt.want)
			}
		})
	}
}
