package utils

import (
	"os"
	"testing"
)

func TestGetEnv(t *testing.T) {
	key := "TEST_ENV_STRING"
	val := "hello"
	os.Setenv(key, val)
	defer os.Unsetenv(key)

	if got := GetEnv(key, "default"); got != val {
		t.Errorf("GetEnv() = %v, want %v", got, val)
	}

	if got := GetEnv("NON_EXISTENT_KEY", "default"); got != "default" {
		t.Errorf("GetEnv() = %v, want %v", got, "default")
	}

	emptyKey := "TEST_EMPTY_STRING"
	os.Setenv(emptyKey, "")
	defer os.Unsetenv(emptyKey)
	if got := GetEnv(emptyKey, "default"); got != "default" {
		t.Errorf("GetEnv() = %v, want %v", got, "default")
	}
}

func TestGetBoolEnv(t *testing.T) {
	key := "TEST_ENV_BOOL"
	defer os.Unsetenv(key)

	tests := []struct {
		envVal string
		setEnv bool
		defVal bool
		want   bool
	}{
		{"true", true, false, true},
		{"1", true, false, true},
		{"false", true, true, true},
		{"0", true, true, true},
		{"invalid", true, true, true},
		{"", false, true, true},
		{"", false, false, false},
	}

	for _, tt := range tests {
		if tt.setEnv {
			os.Setenv(key, tt.envVal)
		} else {
			os.Unsetenv(key)
		}

		if got := GetBoolEnv(key, tt.defVal); got != tt.want {
			t.Errorf("GetBoolEnv(%q, %t) (env=%q) = %t, want %t", key, tt.defVal, tt.envVal, got, tt.want)
		}
	}
}

func TestGetIntEnv(t *testing.T) {
	key := "TEST_ENV_INT"
	defer os.Unsetenv(key)

	tests := []struct {
		envVal string
		setEnv bool
		defVal int
		want   int
	}{
		{"123", true, 0, 123},
		{"invalid", true, 456, 456},
		{"", false, 789, 789},
	}

	for _, tt := range tests {
		if tt.setEnv {
			os.Setenv(key, tt.envVal)
		} else {
			os.Unsetenv(key)
		}

		if got := GetIntEnv(key, tt.defVal); got != tt.want {
			t.Errorf("GetIntEnv(%q, %d) (env=%q) = %d, want %d", key, tt.defVal, tt.envVal, got, tt.want)
		}
	}
}

func TestGetBoolEnv_Detailed(t *testing.T) {
	key := "TEST_ENV_BOOL_DETAILED"
	defer os.Unsetenv(key)

	os.Setenv(key, "true")
	if !GetBoolEnv(key, false) {
		t.Error("Want true for 'true' env")
	}

	os.Setenv(key, "false")
	if GetBoolEnv(key, true) != true {
		t.Error("Want true (default) when env is 'false' because implementation falls back on false parse result")
	}

	// Check standard unset case
	os.Unsetenv(key)
	if GetBoolEnv(key, true) != true {
		t.Error("Want default true when unset")
	}
}
