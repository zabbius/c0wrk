package backend

import (
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

// User theme type constants as exposed in ThemeDTO.Type.
const (
	themeTypeDark  = "dark"
	themeTypeLight = "light"
)

// maxThemeCSSSize is the maximum accepted theme CSS size: 512 KiB. Themes are
// plain variable-definition stylesheets; anything larger is either malformed
// or embedding heavy assets (which the url() validation already rejects).
const maxThemeCSSSize = 512 * 1024

// reservedThemeIDs are theme identifiers owned by the built-in themes. An
// imported theme can never take one of these slugs, so a user theme can
// neither shadow nor alias the defaults.
var reservedThemeIDs = map[string]struct{}{
	"default-dark":  {},
	"default-light": {},
}

// ThemeDTO is a lightweight user-theme descriptor exposed to the frontend.
// ID is the stable slug (the CSS file name stem inside the themes directory);
// Type is one of "dark" or "light". CSS carries the theme body and is
// populated by both ImportThemeFromPath and ListThemes — the frontend
// activates a custom theme from either the import result or a list entry
// without a second RPC, and keeps its own persisted cache for the pre-paint
// apply.
type ThemeDTO struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Type string `json:"type"`
	CSS  string `json:"css"`
}

// themeHeaderRe matches the metadata header comment that must open a theme
// file: `/* c0wrk-theme: <name> | <dark|light> */`. The keyword and the type
// keyword are matched case-insensitively; the name is free text. The regex is
// anchored to the start of the file (leading whitespace allowed) — a marker
// elsewhere in the body is not a header and is ignored.
var themeHeaderRe = regexp.MustCompile(`(?is)^\s*/\*\s*c0wrk-theme\s*:\s*(.+?)\s*\|\s*(dark|light)\s*\*/`)

// colorSchemeRe matches a `color-scheme: dark|light` declaration in the CSS
// body. The character preceding `color-scheme` must not be a word character
// or a hyphen so the `prefers-color-scheme` media feature does not
// false-positive as a type declaration.
var colorSchemeRe = regexp.MustCompile(`(?i)(?:^|[^-\w])color-scheme\s*:\s*["']?(dark|light)\b`)

// themeImportRe matches any @import at-rule, case-insensitive.
var themeImportRe = regexp.MustCompile(`(?i)@import\b`)

// themeURLRe matches url(...) references with single-quoted, double-quoted or
// unquoted payloads.
var themeURLRe = regexp.MustCompile(`(?is)url\(\s*(?:'([^']*)'|"([^"]*)"|([^)'"]*))\s*\)`)

// Slug normalization helpers: disallowed character runs and repeated hyphens
// both collapse to a single hyphen.
var (
	slugDisallowedRe = regexp.MustCompile(`[^a-z0-9-]+`)
	slugDashesRe     = regexp.MustCompile(`-{2,}`)
)

// ParseThemeCSS extracts a theme's display name and type from its CSS source
// using the fallback chain:
//
//  1. name/type from the `/* c0wrk-theme: <name> | <dark|light> */` header;
//  2. name falls back to a prettified file name (nord.css → "Nord");
//  3. type falls back to a `color-scheme: dark|light` declaration in the body;
//  4. type finally falls back to "dark".
//
// It never fails — a theme without recognizable metadata still lists under a
// derived name and defaults to the dark type.
func ParseThemeCSS(filename, content string) (name, typ string) {
	name, typ = "", ""
	if m := themeHeaderRe.FindStringSubmatch(content); m != nil {
		name = strings.TrimSpace(m[1])
		typ = strings.ToLower(m[2])
	}
	if name == "" {
		name = prettyThemeName(filename)
	}
	if typ == "" {
		if m := colorSchemeRe.FindStringSubmatch(content); m != nil {
			typ = strings.ToLower(m[1])
		} else {
			typ = themeTypeDark
		}
	}
	return name, typ
}

// ValidateThemeCSS checks that a CSS document is safe to install as a user
// theme. It rejects:
//   - any @import at-rule (case-insensitive) — themes must be self-contained;
//   - url(...) references that are not data: URLs (external http(s)://, //,
//     file:, and relative references all pull in remote or filesystem data);
//   - payloads larger than 512 KiB;
//   - documents that do not declare both --color-background and
//     --color-foreground (the minimal contract the frontend relies on).
func ValidateThemeCSS(content string) error {
	if len(content) > maxThemeCSSSize {
		return fmt.Errorf("theme CSS is too large: %d bytes (limit %d)", len(content), maxThemeCSSSize)
	}
	if themeImportRe.MatchString(content) {
		return errors.New("theme CSS must not contain @import statements")
	}
	for _, m := range themeURLRe.FindAllStringSubmatch(content, -1) {
		ref := firstNonEmpty(m[1], m[2], m[3])
		if !strings.HasPrefix(strings.ToLower(ref), "data:") {
			return fmt.Errorf("theme CSS must not reference external resources: url(%s) is not a data: URL", ref)
		}
	}
	if !strings.Contains(content, "--color-background") {
		return errors.New("theme CSS must declare the --color-background custom property")
	}
	if !strings.Contains(content, "--color-foreground") {
		return errors.New("theme CSS must declare the --color-foreground custom property")
	}
	return nil
}

// themeSlug derives the stable theme identifier from a CSS file name: the
// base name without extension, lowercased, restricted to [a-z0-9-] with runs
// of disallowed characters collapsed to single hyphens and edge hyphens
// trimmed. It returns an error when the result is empty or collides with a
// reserved built-in theme id.
func themeSlug(filename string) (string, error) {
	base := strings.ToLower(filepath.Base(filename))
	base = strings.TrimSuffix(base, ".css")
	base = slugDisallowedRe.ReplaceAllString(base, "-")
	base = slugDashesRe.ReplaceAllString(base, "-")
	base = strings.Trim(base, "-")
	if base == "" {
		return "", fmt.Errorf("theme file name %q does not produce a valid theme id", filepath.Base(filename))
	}
	if _, reserved := reservedThemeIDs[base]; reserved {
		return "", fmt.Errorf("theme id %q is reserved for built-in themes", base)
	}
	return base, nil
}

// prettyThemeName turns a theme file name into a human-friendly display name:
// the extension is dropped, `-`/`_` become spaces, and every word is
// capitalized (nord.css → "Nord", solarized-light.css → "Solarized Light").
// Names that normalize to nothing fall back to "Theme".
func prettyThemeName(filename string) string {
	base := filepath.Base(filename)
	if ext := filepath.Ext(base); ext != "" {
		base = strings.TrimSuffix(base, ext)
	}
	base = strings.NewReplacer("-", " ", "_", " ").Replace(base)
	words := strings.Fields(base)
	if len(words) == 0 {
		return "Theme"
	}
	var b strings.Builder
	for i, w := range words {
		if i > 0 {
			b.WriteByte(' ')
		}
		r, size := utf8.DecodeRuneInString(w)
		b.WriteRune(unicode.ToUpper(r))
		b.WriteString(w[size:])
	}
	return b.String()
}

// firstNonEmpty returns the first argument that is not empty, or "" when all
// are empty.
func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}
