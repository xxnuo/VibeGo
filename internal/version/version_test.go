package version

import "testing"

func TestVersion(t *testing.T) {
	tests := []struct {
		name string
		want string
	}{
		{
			name: "version",
			want: "v0.0.1-dev",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := Version; got != tt.want {
				t.Errorf("GetLargestVersion() = %v, want %v", got, tt.want)
			}
		})
	}
}
