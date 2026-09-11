package backend

import (
	"os"
	"path/filepath"
	"testing"
)

// newThemesTestAPI builds a FrontendAPI whose agentDir points at a temporary
// directory, so theme installs land in <tmp>/themes/.
func newThemesTestAPI(t *testing.T) (api *FrontendAPI, agentDir string) {
	t.Helper()
	agentDir = t.TempDir()
	return &FrontendAPI{agentDir: agentDir}, agentDir
}

// writeThemeFile writes content to a source file outside the themes dir.
func writeThemeFile(t *testing.T, dir, name, content string) string {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("MkdirAll %s: %v", dir, err)
	}
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("WriteFile %s: %v", path, err)
	}
	return path
}

func TestFrontendAPI_Themes_ImportListDeleteLifecycle(t *testing.T) {
	f, agentDir := newThemesTestAPI(t)

	// No themes directory yet — ListThemes must return an empty, non-nil slice.
	if got := f.ListThemes(); got == nil || len(got) != 0 {
		t.Fatalf("expected empty non-nil list for missing dir, got %#v", got)
	}

	// Import a valid theme.
	src := writeThemeFile(t, filepath.Join(agentDir, "downloads"), "nord.css",
		"/* c0wrk-theme: Nord | dark */\n:root { --color-background: #2e3440; --color-foreground: #d8dee9; }\n")
	dto, err := f.ImportThemeFromPath(src)
	if err != nil {
		t.Fatalf("import: %v", err)
	}
	if dto.ID != "nord" || dto.Name != "Nord" || dto.Type != "dark" {
		t.Fatalf("unexpected DTO: %+v", dto)
	}
	// The import result must carry the theme body — the frontend activates
	// the freshly imported theme immediately via themeStore.setTheme(id, css).
	if dto.CSS == "" {
		t.Fatalf("import result must carry the theme CSS body, got %q", dto.CSS)
	}

	// File must land at <agentDir>/themes/nord.css (ThemesDir contract).
	installed := filepath.Join(agentDir, "themes", "nord.css")
	if _, err := os.Stat(installed); err != nil {
		t.Fatalf("installed theme file missing: %v", err)
	}

	list := f.ListThemes()
	if len(list) != 1 {
		t.Fatalf("expected 1 theme, got %+v", list)
	}
	// List entries carry the theme body too (ListThemes reads every file
	// anyway) — selecting a custom theme from the list can activate it
	// without a second round-trip.
	if list[0].ID != dto.ID || list[0].Name != dto.Name || list[0].Type != dto.Type {
		t.Fatalf("expected [%+v], got %+v", dto, list)
	}
	if list[0].CSS != dto.CSS {
		t.Fatalf("list entry must carry the same CSS body as the import, got %q", list[0].CSS)
	}

	// Delete, then the list is empty again.
	if err := f.DeleteTheme("nord"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if got := f.ListThemes(); len(got) != 0 {
		t.Fatalf("expected empty list after delete, got %+v", got)
	}
	if _, err := os.Stat(installed); !os.IsNotExist(err) {
		t.Fatalf("expected theme file removed, stat err=%v", err)
	}
}

func TestFrontendAPI_Themes_ReimportOverwritesNoDuplicate(t *testing.T) {
	f, agentDir := newThemesTestAPI(t)
	srcDir := filepath.Join(agentDir, "src")

	v1 := writeThemeFile(t, srcDir, "nord.css",
		"/* c0wrk-theme: Nord | dark */\n:root { --color-background: #111; --color-foreground: #eee; }\n")
	if _, err := f.ImportThemeFromPath(v1); err != nil {
		t.Fatalf("first import: %v", err)
	}
	// Simulate a v2 download (same file name, new content) in the same dir.
	v2 := writeThemeFile(t, srcDir, "nord.css",
		"/* c0wrk-theme: Nord v2 | dark */\n:root { --color-background: #222; --color-foreground: #ddd; }\n")
	dto, err := f.ImportThemeFromPath(v2)
	if err != nil {
		t.Fatalf("second import: %v", err)
	}
	if dto.ID != "nord" {
		t.Fatalf("id must stay stable across updates, got %q", dto.ID)
	}

	list := f.ListThemes()
	if len(list) != 1 {
		t.Fatalf("re-import must not duplicate: got %+v", list)
	}
	if list[0].Name != "Nord v2" {
		t.Fatalf("expected updated metadata, got %+v", list[0])
	}

	// No temp leftovers from the atomic write.
	entries, err := os.ReadDir(filepath.Join(agentDir, "themes"))
	if err != nil {
		t.Fatalf("read themes dir: %v", err)
	}
	if len(entries) != 1 || entries[0].Name() != "nord.css" {
		t.Fatalf("expected exactly nord.css, got %d entries", len(entries))
	}
}

func TestFrontendAPI_Themes_ImportValidationErrors(t *testing.T) {
	f, agentDir := newThemesTestAPI(t)
	srcDir := filepath.Join(agentDir, "src")

	cases := map[string]string{
		"import-rule":    "@import url('https://evil.example/x.css');\n:root { --color-background: #fff; --color-foreground: #000; }",
		"external-url":   ":root { --color-background: url(https://evil.example/bg.png); --color-foreground: #000; }",
		"missing-tokens": ":root { --accent: #528bff; }",
	}
	for name, css := range cases {
		src := writeThemeFile(t, srcDir, name+".css", css)
		if _, err := f.ImportThemeFromPath(src); err == nil {
			t.Errorf("%s: expected import rejection, got nil", name)
		}
	}
	// Nothing may have been installed.
	if got := f.ListThemes(); len(got) != 0 {
		t.Fatalf("rejected themes must not install, got %+v", got)
	}
	// Reserved slug needs a valid CSS body to prove rejection comes from the
	// slug rule, not the CSS validation.
	reserved := writeThemeFile(t, srcDir, "Default-Dark.css", validThemeCSS)
	if _, err := f.ImportThemeFromPath(reserved); err == nil {
		t.Fatal("expected reserved-id rejection")
	}

	if _, err := f.ImportThemeFromPath(filepath.Join(srcDir, "does-not-exist.css")); err == nil {
		t.Fatal("expected error for missing source file")
	}
	if _, err := f.ImportThemeFromPath("   "); err == nil {
		t.Fatal("expected error for empty path")
	}
}

func TestFrontendAPI_Themes_DeleteMissing(t *testing.T) {
	f, _ := newThemesTestAPI(t)
	if err := f.DeleteTheme("never-installed"); err == nil {
		t.Fatal("expected error for missing theme")
	}
	if err := f.DeleteTheme("default-light"); err == nil {
		t.Fatal("expected error for reserved id (never installable)")
	}
}

func TestFrontendAPI_Themes_ListSortsByNameAndSkipsNonCSS(t *testing.T) {
	f, agentDir := newThemesTestAPI(t)
	themesDir := filepath.Join(agentDir, "themes")

	mustWrite := func(name, content string) {
		t.Helper()
		writeThemeFile(t, themesDir, name, content)
	}
	mustWrite("zeta.css", "/* c0wrk-theme: Zeta | dark */\n:root { --color-background: #000; --color-foreground: #fff; }")
	mustWrite("alpha.css", "/* c0wrk-theme: Alpha | light */\n:root { --color-background: #fff; --color-foreground: #000; }")
	mustWrite("notes.txt", "not a theme")
	if err := os.MkdirAll(filepath.Join(themesDir, "sub"), 0o755); err != nil {
		t.Fatalf("MkdirAll sub: %v", err)
	}

	list := f.ListThemes()
	if len(list) != 2 {
		t.Fatalf("expected 2 themes (txt skipped), got %+v", list)
	}
	if list[0].Name != "Alpha" || list[1].Name != "Zeta" {
		t.Fatalf("expected sort by name, got %+v", list)
	}
}

func TestFrontendAPI_Themes_ListSkipsInvalidSlug(t *testing.T) {
	f, agentDir := newThemesTestAPI(t)
	themesDir := filepath.Join(agentDir, "themes")

	// Hand-dropped reserved id — listed never, but must not break the scan.
	writeThemeFile(t, themesDir, "default-dark.css",
		":root { --color-background: #282c34; --color-foreground: #abb2bf; }")
	writeThemeFile(t, themesDir, "ok.css",
		":root { --color-background: #282c34; --color-foreground: #abb2bf; }")

	list := f.ListThemes()
	if len(list) != 1 || list[0].ID != "ok" {
		t.Fatalf("expected only ok.css, got %+v", list)
	}
}
