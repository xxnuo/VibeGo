package handler

import (
	"fmt"
	"strings"
	"unicode"
)

// validateGitInitCloneArgument checks arguments that are passed directly to
// git init/clone. The command uses an explicit -- separator as defense in
// depth, while rejecting option-shaped and control-containing values at the
// HTTP boundary gives callers a deterministic error instead of relying on
// Git's argument parser.
func validateGitInitCloneArgument(value, label string) error {
	if value == "" {
		return fmt.Errorf("%s is required", label)
	}
	if strings.IndexByte(value, 0) >= 0 {
		return fmt.Errorf("%s contains NUL", label)
	}
	for _, r := range value {
		if unicode.IsControl(r) {
			return fmt.Errorf("%s contains control characters", label)
		}
	}
	if strings.HasPrefix(value, "-") {
		return fmt.Errorf("%s must not begin with '-'; use an explicit relative path such as ./%s", label, strings.TrimLeft(value, "-"))
	}
	return nil
}
