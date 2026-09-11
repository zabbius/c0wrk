package workspace

import (
	"bytes"
	"context"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/v0lka/c0wrk/internal/sysproc"
)

// Git version probing ──────────────────────────────────────────────────────
//
// attr.tree — the blanket attribute-routing kill the neutralizing set leans
// on for include-bearing configs (an included file can hide driver names
// per-name pins cannot cover) — exists only since git 2.45 (Ubuntu 22.04
// ships 2.34, RHEL 9 ships 2.43). Older git SILENTLY IGNORES the key: the
// -c attr.tree=<empty tree> pin parses, matches nothing, and the
// in-tree .gitattributes keeps routing to drivers the scan never saw. The
// command-execution chokepoint therefore fails closed for include-bearing
// configs unless the resolved git version is known to be >= 2.45
// (protocol.git.allow, the core.gitProxy kill, needs no version support and
// is unaffected by this gate).

// attrTreeMinGitVersion is the oldest git that honors attr.tree.
var attrTreeMinGitVersion = gitVersion{major: 2, minor: 45}

// gitVersion is a parsed (major, minor) git version; the patch level is
// irrelevant to every gate consulted here and is deliberately dropped.
type gitVersion struct {
	major int
	minor int
}

// lessThan reports lexicographic (major, minor) ordering.
func (v gitVersion) lessThan(o gitVersion) bool {
	return v.major < o.major || (v.major == o.major && v.minor < o.minor)
}

// parseGitVersion extracts (major, minor) from `git --version` output. It
// accepts both the canonical "git version 2.50.1 (Apple Git-157)" spelling
// and a bare "2.45.0" token, and refuses anything without a leading
// major.minor pair — an unparsable version must fail closed, never guess.
func parseGitVersion(output string) (gitVersion, error) {
	s := strings.TrimSpace(output)
	if rest, ok := strings.CutPrefix(s, "git version "); ok {
		s = rest
	}
	fields := strings.Fields(s)
	if len(fields) == 0 {
		return gitVersion{}, fmt.Errorf("no version token in %q", output)
	}
	parts := strings.Split(fields[0], ".")
	if len(parts) < 2 {
		return gitVersion{}, fmt.Errorf("no major.minor pair in %q", output)
	}
	major, err := strconv.Atoi(parts[0])
	if err != nil {
		return gitVersion{}, fmt.Errorf("major in %q: %w", output, err)
	}
	minor, err := strconv.Atoi(parts[1])
	if err != nil {
		return gitVersion{}, fmt.Errorf("minor in %q: %w", output, err)
	}
	return gitVersion{major: major, minor: minor}, nil
}

var (
	// gitVersionMu guards the lazy resolution of the git version below. It
	// replaces the sync.Once this gate used to carry: a Once freezes the
	// FIRST probe outcome whatever it is, so a transient failure (git not
	// yet on PATH in a freshly launched Finder app before shell-env
	// expansion completes, an AV lock on Windows) would fail every
	// include-bearing-repo git operation for the rest of the process
	// lifetime. The mutex plus resolvedGitVersion retries failures and
	// caches only completed resolutions.
	gitVersionMu sync.Mutex

	// resolvedGitVersion reports that a version was parsed — the verdict in
	// resolvedGitVersionErr (nil when attr.tree-capable) is then final for
	// the process lifetime, since the machine's git version does not
	// change. It stays false on probe or parse failure, so the next call
	// retries.
	resolvedGitVersion bool

	resolvedGitVersionErr error
)

// gitVersionProbeTimeout bounds each `git --version` probe. The probe
// normally completes in single-digit milliseconds; the bound exists so a
// hung git binary (wedged AV scan, unresponsive filesystem) fails the gate
// instead of blocking callers indefinitely — exec.CommandContext kills the
// probe once the deadline passes, and the next call retries.
const gitVersionProbeTimeout = 5 * time.Second

// gitVersionOutputFn is the seam unit tests use to inject `git --version`
// output (mirroring scanGitConfigFn). Production resolves the real binary
// once, through the same hardened sysproc.GitCmd chokepoint every other git
// spawn uses — `git --version` reads no repository config and executes no
// config-driven program, so it needs no repo-scoped neutralization.
var gitVersionOutputFn = func(ctx context.Context) (string, error) {
	cmd, err := sysproc.GitCmd(ctx, "--version")
	if err != nil {
		return "", err
	}
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = nil
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("running git --version: %w", err)
	}
	return out.String(), nil
}

// requireAttrTreeCapableGit returns nil when the resolved git version is
// known to honor attr.tree (>= 2.45), and a fail-closed error otherwise —
// including when the version cannot be resolved at all (git missing from
// PATH, unparsable output). A completed resolution (any verdict) is cached
// for the process lifetime; probe and parse failures are treated as
// transient and retried on the next call. Callers invoke this only on the
// include-bearing path where the attr.tree pin is load-bearing.
func requireAttrTreeCapableGit() error {
	gitVersionMu.Lock()
	defer gitVersionMu.Unlock()

	if resolvedGitVersion {
		return resolvedGitVersionErr
	}

	ctx, cancel := context.WithTimeout(context.Background(), gitVersionProbeTimeout)
	defer cancel()

	out, err := gitVersionOutputFn(ctx)
	if err != nil {
		// Not cached: probe failures are routinely transient.
		return fmt.Errorf(
			"cannot resolve the git version (fail closed: an include-bearing repository config needs the attr.tree neutralization, which requires git >= %d.%d): %w",
			attrTreeMinGitVersion.major, attrTreeMinGitVersion.minor, err)
	}
	v, parseErr := parseGitVersion(out)
	if parseErr != nil {
		// Not cached either: unparsable output is retried, not frozen.
		return fmt.Errorf(
			"cannot parse git version %q (fail closed: an include-bearing repository config needs the attr.tree neutralization, which requires git >= %d.%d): %w",
			strings.TrimSpace(out), attrTreeMinGitVersion.major, attrTreeMinGitVersion.minor, parseErr)
	}
	if v.lessThan(attrTreeMinGitVersion) {
		resolvedGitVersionErr = fmt.Errorf(
			"git %d.%d predates attr.tree support (fail closed: the repository config contains include directives whose hidden keys are only covered by the attr.tree neutralization, which requires git >= %d.%d); refusing to run git in this repository",
			v.major, v.minor, attrTreeMinGitVersion.major, attrTreeMinGitVersion.minor)
	}
	// Resolution succeeded: freeze the verdict (nil when capable) for the
	// process lifetime.
	resolvedGitVersion = true
	return resolvedGitVersionErr
}
