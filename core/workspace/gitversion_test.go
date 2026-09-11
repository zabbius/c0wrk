package workspace

import (
	"context"
	"errors"
	"testing"
	"time"
)

// TestParseGitVersion pins the `git --version` output parser: the canonical
// "git version X.Y.Z" spelling, a bare version token, the Apple-suffixed
// variant, and the fail-closed refusals (garbage, empty, missing pair).
func TestParseGitVersion(t *testing.T) {
	cases := []struct {
		name    string
		in      string
		want    gitVersion
		wantErr bool
	}{
		{"canonical", "git version 2.44.9\n", gitVersion{major: 2, minor: 44}, false},
		{"canonical no newline", "git version 2.45.0", gitVersion{major: 2, minor: 45}, false},
		{"bare token", "2.45.0", gitVersion{major: 2, minor: 45}, false},
		{"apple suffix", "git version 2.50.1 (Apple Git-157)", gitVersion{major: 2, minor: 50}, false},
		{"bare with suffix", "2.50.1 (Apple Git-157)\n", gitVersion{major: 2, minor: 50}, false},
		{"whitespace padded", "  git version 2.45.0  \n", gitVersion{major: 2, minor: 45}, false},
		{"garbage", "garbage", gitVersion{}, true},
		{"empty", "", gitVersion{}, true},
		{"prefix only", "git version", gitVersion{}, true},
		{"prefix only with space", "git version ", gitVersion{}, true},
		{"non numeric", "git version two.fifty", gitVersion{}, true},
		{"major only", "git version 2", gitVersion{}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseGitVersion(tc.in)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("parseGitVersion(%q) = %+v, want error", tc.in, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("parseGitVersion(%q): %v", tc.in, err)
			}
			if got != tc.want {
				t.Fatalf("parseGitVersion(%q) = %+v, want %+v", tc.in, got, tc.want)
			}
		})
	}
}

// TestGitVersionLessThan pins the tuple ordering the attr.tree gate
// compares with: minor-aware within a major, major-aware across.
func TestGitVersionLessThan(t *testing.T) {
	pairs := []struct {
		v, o gitVersion
		want bool
	}{
		{gitVersion{major: 2, minor: 44}, gitVersion{major: 2, minor: 45}, true},
		{gitVersion{major: 2, minor: 45}, gitVersion{major: 2, minor: 45}, false},
		{gitVersion{major: 2, minor: 50}, gitVersion{major: 2, minor: 45}, false},
		{gitVersion{major: 1, minor: 99}, gitVersion{major: 2, minor: 45}, true},
		{gitVersion{major: 3, minor: 0}, gitVersion{major: 2, minor: 45}, false},
	}
	for _, p := range pairs {
		if got := p.v.lessThan(p.o); got != p.want {
			t.Errorf("%+v.lessThan(%+v) = %v, want %v", p.v, p.o, got, p.want)
		}
	}
}

// TestRequireAttrTreeCapableGitRetriesTransientProbeFailure pins the retry
// semantics that replaced the process-lifetime sync.Once: a first probe
// failure returns the fail-closed error WITHOUT freezing it; the next call
// re-probes, and once a version parses the verdict is cached — further
// calls neither re-probe nor regress.
func TestRequireAttrTreeCapableGitRetriesTransientProbeFailure(t *testing.T) {
	probes := 0
	swapGitVersionProbe(t, func(context.Context) (string, error) {
		probes++
		if probes == 1 {
			return "", errors.New("transient: git not yet on PATH")
		}
		return "git version 2.50.1\n", nil
	})

	if err := requireAttrTreeCapableGit(); err == nil {
		t.Fatal("first call (probe fails transiently) must return the fail-closed error")
	}
	if err := requireAttrTreeCapableGit(); err != nil {
		t.Fatalf("second call (probe succeeds) must resolve: %v", err)
	}
	if err := requireAttrTreeCapableGit(); err != nil {
		t.Fatalf("third call must return the cached success: %v", err)
	}
	if probes != 2 {
		t.Fatalf("probe invocations = %d, want 2 (failure retried once, success cached)", probes)
	}
}

// TestRequireAttrTreeCapableGitRetriesUnparsableOutput pins that an
// unparsable probe result is transient-shaped too: it fails closed once but
// is not frozen — a later well-formed probe resolves the capability.
func TestRequireAttrTreeCapableGitRetriesUnparsableOutput(t *testing.T) {
	probes := 0
	swapGitVersionProbe(t, func(context.Context) (string, error) {
		probes++
		if probes == 1 {
			return "garbage", nil
		}
		return "git version 2.45.0\n", nil
	})

	if err := requireAttrTreeCapableGit(); err == nil {
		t.Fatal("unparsable output must fail closed")
	}
	if err := requireAttrTreeCapableGit(); err != nil {
		t.Fatalf("retry after unparsable output must resolve: %v", err)
	}
	if probes != 2 {
		t.Fatalf("probe invocations = %d, want 2", probes)
	}
}

// TestRequireAttrTreeCapableGitCachesVerdicts pins that a COMPLETED
// resolution is final for the process lifetime, in both directions: a
// too-old git keeps failing without re-probing, and a capable git keeps
// passing even after the probe itself would fail again.
func TestRequireAttrTreeCapableGitCachesVerdicts(t *testing.T) {
	t.Run("too old stays cached", func(t *testing.T) {
		probes := 0
		swapGitVersionProbe(t, func(context.Context) (string, error) {
			probes++
			return "git version 2.44.9\n", nil
		})
		if err := requireAttrTreeCapableGit(); err == nil {
			t.Fatal("git 2.44.9 predates attr.tree; must fail closed")
		}
		if err := requireAttrTreeCapableGit(); err == nil {
			t.Fatal("too-old verdict must stay cached")
		}
		if probes != 1 {
			t.Fatalf("probe invocations = %d, want 1 (verdict cached)", probes)
		}
	})
	t.Run("capable stays cached", func(t *testing.T) {
		probes := 0
		swapGitVersionProbe(t, func(context.Context) (string, error) {
			probes++
			if probes > 1 {
				return "", errors.New("probe broken after success")
			}
			return "git version 2.50.1\n", nil
		})
		if err := requireAttrTreeCapableGit(); err != nil {
			t.Fatalf("capable git must pass: %v", err)
		}
		if err := requireAttrTreeCapableGit(); err != nil {
			t.Fatalf("successful resolution must stay cached (no re-probe): %v", err)
		}
		if probes != 1 {
			t.Fatalf("probe invocations = %d, want 1 (success cached)", probes)
		}
	})
}

// TestRequireAttrTreeCapableGitBoundsProbe pins that the probe context
// carries a deadline within gitVersionProbeTimeout, so a hung `git
// --version` (wedged AV scan, unresponsive filesystem) cannot block callers
// indefinitely — exec.CommandContext kills the probe at the deadline.
func TestRequireAttrTreeCapableGitBoundsProbe(t *testing.T) {
	var probeCtx context.Context
	swapGitVersionProbe(t, func(ctx context.Context) (string, error) {
		probeCtx = ctx
		return "git version 2.50.1\n", nil
	})
	if err := requireAttrTreeCapableGit(); err != nil {
		t.Fatalf("requireAttrTreeCapableGit: %v", err)
	}
	if probeCtx == nil {
		t.Fatal("probe seam was not invoked")
	}
	deadline, ok := probeCtx.Deadline()
	if !ok {
		t.Fatal("probe context must carry a deadline, got none")
	}
	if remaining := time.Until(deadline); remaining <= 0 || remaining > gitVersionProbeTimeout {
		t.Fatalf("probe deadline remaining = %v, want within (0, %v]", remaining, gitVersionProbeTimeout)
	}
}
