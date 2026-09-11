//go:build !windows

package research

import (
	"os"
	"testing"
)

// makeUnreadable makes an existing regular file unreadable for subsequent
// opens (Unix dialect) and returns a restore function. It drops every read
// permission bit, so os.ReadFile/os.Open fail with EACCES — the
// "unreadable-but-present" state readFileStrict must abort on (a read error
// that is not os.ErrNotExist fails closed; see parser.go). Callers are
// expected to guard with requireNonRoot: uid 0 reads straight through 0o000
// modes, so the guard cannot be exercised as root.
func makeUnreadable(t *testing.T, path string) func() {
	t.Helper()

	if err := os.Chmod(path, 0o000); err != nil {
		t.Fatalf("makeUnreadable: chmod %q: %v", path, err)
	}
	restore := func() { _ = os.Chmod(path, 0o644) }
	t.Cleanup(restore)
	return restore
}
