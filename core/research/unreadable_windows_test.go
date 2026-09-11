//go:build windows

package research

import (
	"sync"
	"testing"

	"golang.org/x/sys/windows"
)

// makeUnreadable makes an existing regular file unreadable for subsequent
// opens on Windows and returns a restore function (idempotent, also wired
// into t.Cleanup). Windows is not a POSIX-permission system: os.Chmod maps
// only the write bit to the read-only attribute, which guards writes but
// never READS — so the Unix dialect of this helper (permission bits) cannot
// exercise the fail-closed read guard here. Instead the helper holds an
// exclusive handle with no sharing mode: every later CreateFile — Go's
// os.ReadFile/os.Open included — fails with a sharing violation, which is
// exactly the "unreadable-but-present" state readFileStrict must abort on
// (see parser.go: a read error that is not os.ErrNotExist fails closed).
func makeUnreadable(t *testing.T, path string) func() {
	t.Helper()

	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		t.Fatalf("makeUnreadable: UTF16PtrFromString(%q): %v", path, err)
	}
	h, err := windows.CreateFile(p, windows.GENERIC_READ, 0, nil,
		windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		t.Fatalf("makeUnreadable: opening %q with no sharing: %v", path, err)
	}

	var once sync.Once
	restore := func() {
		once.Do(func() { _ = windows.CloseHandle(h) })
	}
	t.Cleanup(restore)
	return restore
}
