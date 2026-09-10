package backend

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/v0lka/c0wrk/backend/project"
	"github.com/v0lka/c0wrk/core/vectorindex"
)

// newStartupVectorAPI builds a FrontendAPI whose vector manager is backed by a
// stub embedding function (no ONNX), mirroring newStuckVectorAPI. The manager
// is intentionally left unwired so callers can reproduce the startup race where
// the frontend's first SwitchProject arrives before SetVectorManager.
func newStartupVectorAPI(t *testing.T) (*FrontendAPI, *vectorindex.Manager) {
	t.Helper()
	mgr, err := vectorindex.NewManager(vectorindex.ManagerConfig{
		EmbeddingFunc: func(ctx context.Context, text string) ([]float32, error) {
			return make([]float32, 4), nil
		},
	})
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}
	t.Cleanup(func() { mgr.Shutdown() })

	f := &FrontendAPI{
		appCtx:    context.Background,
		agentDir:  t.TempDir(),
		emitEvent: func(string, ...any) {},
	}
	return f, mgr
}

// publishVectorManager simulates the background ONNX goroutine finishing its
// construction and wiring the manager into the FrontendAPI.
func publishVectorManager(f *FrontendAPI, mgr *vectorindex.Manager) {
	f.vectorManagerMu.Lock()
	f.vectorManager = mgr
	f.vectorManagerMu.Unlock()
}

// setActiveProject simulates SwitchProject committing the activation.
func setActiveProject(f *FrontendAPI, id string) {
	f.activeProjectMu.Lock()
	f.activeProjectID = id
	f.activeProjectMu.Unlock()
}

// waitForVectorReady blocks until the manager's per-project init has fully
// settled (branch detected, collection opened, indexing done) or fails after a
// deadline. It observes readiness through the lock-protected accessors —
// Service.GetCollection is intentionally lock-free for the Indexer and must not
// be polled concurrently with init.
func waitForVectorReady(t *testing.T, mgr *vectorindex.Manager) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := mgr.Service().WaitReady(ctx); err != nil {
		t.Fatalf("vector service never became ready: %v", err)
	}
	if branch := mgr.GetIndexStatus().Branch; branch == "" {
		t.Fatal("expected the manager to have detected a branch for the active project")
	}
}

// seedDeferred records a deferred setup by driving switchProjectSetupVector
// while the manager is still nil — reproducing the startup race in which the
// frontend's first SwitchProject arrives before the background ONNX init.
func seedDeferred(t *testing.T, f *FrontendAPI, p *project.ProjectInfo) {
	t.Helper()
	if f.getVectorManager() != nil {
		t.Fatal("precondition: manager must be nil to reproduce the startup race")
	}
	if err := f.switchProjectSetupVector(p); err != nil {
		t.Fatalf("switchProjectSetupVector (deferral): %v", err)
	}
	if f.deferredVectorProject != p {
		t.Fatalf("expected setup to be deferred, got %+v", f.deferredVectorProject)
	}
}

// TestSwitchProjectSetupVector_DefersWhenManagerUnavailable pins the core of
// the startup bug: when the background vector manager is not yet ready,
// switchProjectSetupVector must NOT silently drop the setup — it records the
// project so InitVectorIndexForActiveProject can apply it later.
func TestSwitchProjectSetupVector_DefersWhenManagerUnavailable(t *testing.T) {
	f, _ := newStartupVectorAPI(t)
	p := &project.ProjectInfo{ID: "proj-a", WorkspacePath: t.TempDir()}

	seedDeferred(t, f, p)
}

// TestSwitchProjectSetupVector_NoProjectDropsDeferred pins that a No Project
// (CHAT mode) switch clears any pending setup: CHAT mode never indexes.
func TestSwitchProjectSetupVector_NoProjectDropsDeferred(t *testing.T) {
	f, _ := newStartupVectorAPI(t)
	f.deferredVectorProject = &project.ProjectInfo{ID: "proj-a"}

	np := &project.ProjectInfo{ID: project.NoProjectID, IsNoProject: true}
	if err := f.switchProjectSetupVector(np); err != nil {
		t.Fatalf("switchProjectSetupVector(No Project): %v", err)
	}
	if f.deferredVectorProject != nil {
		t.Fatalf("No Project switch must drop the deferred setup, got %+v", f.deferredVectorProject)
	}
}

// TestSwitchProjectSetupVector_ManagerReadyClearsDeferred pins the supersede
// path: once the manager is ready, a switch clears any stale deferred setup
// (so it is applied exactly once) and runs the real setup.
func TestSwitchProjectSetupVector_ManagerReadyClearsDeferred(t *testing.T) {
	f, mgr := newStartupVectorAPI(t)
	publishVectorManager(f, mgr)

	f.deferredVectorProject = &project.ProjectInfo{ID: "stale-project"}

	p := &project.ProjectInfo{ID: "proj-a", WorkspacePath: t.TempDir()}
	if err := f.switchProjectSetupVector(p); err != nil {
		t.Fatalf("switchProjectSetupVector (ready manager): %v", err)
	}
	if f.deferredVectorProject != nil {
		t.Fatalf("a ready manager must clear the deferred setup, got %+v", f.deferredVectorProject)
	}
	waitForVectorReady(t, mgr)
}

// TestInitVectorIndexForActiveProject_AppliesDeferredSetup pins the fix: a
// setup deferred while the manager was nil is applied once the manager is
// wired in and the project is the active one — without a manual project switch.
func TestInitVectorIndexForActiveProject_AppliesDeferredSetup(t *testing.T) {
	f, mgr := newStartupVectorAPI(t)

	ws := t.TempDir()
	if err := os.WriteFile(filepath.Join(ws, "a.go"), []byte("package a\n"), 0o644); err != nil {
		t.Fatalf("write file: %v", err)
	}
	p := &project.ProjectInfo{ID: "proj-a", WorkspacePath: ws}

	// Startup race: the switch runs while the manager is still being built.
	seedDeferred(t, f, p)
	if branch := mgr.GetIndexStatus().Branch; branch != "" {
		t.Fatalf("manager must not have initialized a project before the deferred setup runs, got branch %q", branch)
	}

	// Background init finishes: publish the manager, then mark the project
	// active (SwitchProject commits activation after the vector step).
	publishVectorManager(f, mgr)
	setActiveProject(f, p.ID)

	f.Lifecycle().InitVectorIndexForActiveProject()

	if f.deferredVectorProject != nil {
		t.Fatal("the drain must clear the deferred setup")
	}
	waitForVectorReady(t, mgr)
}

// TestInitVectorIndexForActiveProject_NoOpWhenNoProjectActive pins that the
// drain is a no-op while no project is active: the frontend simply has not
// switched yet, and its later switch (now seeing a ready manager) initializes
// the index itself.
func TestInitVectorIndexForActiveProject_NoOpWhenNoProjectActive(t *testing.T) {
	f, mgr := newStartupVectorAPI(t)
	publishVectorManager(f, mgr)

	f.Lifecycle().InitVectorIndexForActiveProject()

	if branch := mgr.GetIndexStatus().Branch; branch != "" {
		t.Fatalf("no active project: the drain must not initialize anything, got branch %q", branch)
	}
}

// TestInitVectorIndexForActiveProject_SkipsStaleDeferred pins the guard: a
// deferred setup for a project that is no longer active must not be applied
// (a superseding switch owns the manager state).
func TestInitVectorIndexForActiveProject_SkipsStaleDeferred(t *testing.T) {
	f, mgr := newStartupVectorAPI(t)
	publishVectorManager(f, mgr)

	f.deferredVectorProject = &project.ProjectInfo{ID: "proj-a", WorkspacePath: t.TempDir()}
	setActiveProject(f, "proj-b")

	f.Lifecycle().InitVectorIndexForActiveProject()

	if f.deferredVectorProject != nil {
		t.Fatal("the drain must clear the deferred slot even when it skips applying it")
	}
	// Give a (would-be) async init a moment; nothing must have been applied.
	time.Sleep(200 * time.Millisecond)
	if branch := mgr.GetIndexStatus().Branch; branch != "" {
		t.Fatalf("a deferred setup for a non-active project must not initialize the manager, got branch %q", branch)
	}
}
