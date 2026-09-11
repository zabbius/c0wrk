package backend

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/v0lka/c0wrk/backend/config"
)

// ListThemes returns descriptors for all user themes installed in the global
// themes directory (~/.c0wrk/themes/*.css), sorted by display name. A missing
// directory yields an empty (non-nil) slice — a fresh install has no themes
// yet and the frontend selector must render an empty list, not an error.
func (f *FrontendAPI) ListThemes() []ThemeDTO {
	themesDir := config.ThemesDir(f.agentDir)
	entries, err := os.ReadDir(themesDir)
	if err != nil {
		return []ThemeDTO{}
	}

	themes := make([]ThemeDTO, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.EqualFold(filepath.Ext(entry.Name()), ".css") {
			continue
		}
		content, err := os.ReadFile(filepath.Join(themesDir, entry.Name()))
		if err != nil {
			f.log().Warn("failed to read theme file", "file", entry.Name(), "error", err)
			continue
		}
		name, typ := ParseThemeCSS(entry.Name(), string(content))
		id, err := themeSlug(entry.Name())
		if err != nil {
			// Unreadable slugs should not happen for files that are already
			// installed, but a hand-dropped file with an unusable name must
			// not break the whole listing — skip it.
			f.log().Warn("skipping theme with invalid file name", "file", entry.Name(), "error", err)
			continue
		}
		themes = append(themes, ThemeDTO{ID: id, Name: name, Type: typ, CSS: string(content)})
	}
	sort.Slice(themes, func(i, j int) bool { return themes[i].Name < themes[j].Name })
	return themes
}

// ImportThemeFromPath reads a CSS file from an arbitrary user-chosen path,
// validates it as a theme, and installs it into the global themes directory
// under the slug derived from its file name. Importing a file whose slug
// already exists overwrites the installed copy — this is the update path for
// a user theme, and the theme id stays stable across updates. The returned
// DTO describes the installed theme.
func (f *FrontendAPI) ImportThemeFromPath(path string) (ThemeDTO, error) {
	if strings.TrimSpace(path) == "" {
		return ThemeDTO{}, errors.New("theme path is empty")
	}
	content, err := os.ReadFile(path)
	if err != nil {
		return ThemeDTO{}, fmt.Errorf("failed to read theme file: %w", err)
	}
	if err := ValidateThemeCSS(string(content)); err != nil {
		return ThemeDTO{}, fmt.Errorf("invalid theme CSS: %w", err)
	}
	id, err := themeSlug(filepath.Base(path))
	if err != nil {
		return ThemeDTO{}, err
	}

	themesDir := config.ThemesDir(f.agentDir)
	if err := os.MkdirAll(themesDir, 0o755); err != nil {
		return ThemeDTO{}, fmt.Errorf("failed to create themes directory: %w", err)
	}
	dest := filepath.Join(themesDir, id+".css")
	// Write via a temp file + rename so a failed write never leaves a
	// half-written theme behind (the previous copy, if any, stays intact).
	tmp := dest + ".tmp"
	if err := os.WriteFile(tmp, content, 0o644); err != nil {
		_ = os.Remove(tmp)
		return ThemeDTO{}, fmt.Errorf("failed to write theme file: %w", err)
	}
	if err := os.Rename(tmp, dest); err != nil {
		_ = os.Remove(tmp)
		return ThemeDTO{}, fmt.Errorf("failed to install theme file: %w", err)
	}

	name, typ := ParseThemeCSS(filepath.Base(path), string(content))
	f.log().Info("theme imported", "id", id, "name", name, "type", typ, "source", path)
	return ThemeDTO{ID: id, Name: name, Type: typ, CSS: string(content)}, nil
}

// DeleteTheme removes an installed user theme by its id (the slug stem of
// its CSS file). It fails when the theme does not exist.
func (f *FrontendAPI) DeleteTheme(id string) error {
	slug, err := themeSlug(id)
	if err != nil {
		return err
	}
	themePath := filepath.Join(config.ThemesDir(f.agentDir), slug+".css")
	if _, err := os.Stat(themePath); err != nil {
		return fmt.Errorf("theme %q does not exist", id)
	}
	if err := os.Remove(themePath); err != nil {
		return fmt.Errorf("failed to delete theme: %w", err)
	}
	f.log().Info("theme deleted", "id", slug)
	return nil
}
