package backend

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/v0lka/c0wrk/backend/config"
	"github.com/v0lka/c0wrk/backend/project"
)

// Projects-row lost-update tests (review [C3-1]).
//
// Contract under test: the pin RPCs (SetResearchPinned / SetHypothesisPinned /
// DeleteResearch) re-load the projects row INSIDE the per-root mutation mutex
// and persist only their pins delta, and EnableResearch / DisableResearch take
// the same mutex — so no full-row save can clobber row state committed by a
// serialized writer (another pin toggle, an enable/disable root change).

// rowLoadSignalingStore wraps a ProjectStore, signaling a buffered channel on
// every LoadProject call. It gives the lost-update tests a deterministic
// handshake with an RPC goroutine's initial (pre-mutex) row load, so the
// "load → wait → concurrent commit → save" interleave is guaranteed rather
// than dependent on goroutine scheduling.
type rowLoadSignalingStore struct {
	project.ProjectStore
	loads chan string
}

func (s *rowLoadSignalingStore) LoadProject(ctx context.Context, id string) (*project.ProjectInfo, error) {
	info, err := s.ProjectStore.LoadProject(ctx, id)
	select {
	case s.loads <- id:
	default:
	}
	return info, err
}

// researchLostUpdateTestFrontend mirrors researchRootTestFrontend (one
// research-enabled project, one seeded R-001-test) but routes the project
// manager through a rowLoadSignalingStore. It returns the API, the project
// ID, the research root, and the load-signal channel.
func researchLostUpdateTestFrontend(t *testing.T) (f *FrontendAPI, projectID, root string, loads chan string) {
	t.Helper()
	base := t.TempDir()
	ws := filepath.Join(base, "ws")
	root = filepath.Join(ws, ".research")

	seedResearchProjectDir(t, root, "R-001-test")
	index := "# Research Index\n\n" +
		"Active research projects following the Iterative Engineering Research\n" +
		"Methodology.\n\n" +
		"| ID | Title | Status | Domain | Quarter | Researcher(s) | Brief |\n" +
		"|---|---|---|---|---|---|---|\n" +
		"| R-001 | Test R-001 | Active | — | — | — | [brief](R-001-test/brief.md) |\n"
	if err := os.WriteFile(filepath.Join(root, "index.md"), []byte(index), 0o644); err != nil {
		t.Fatalf("index.md: %v", err)
	}

	db := openResearchTestDB(t)
	t.Cleanup(func() { _ = db.Close() })
	store, err := project.NewSQLiteProjectStore(db)
	if err != nil {
		t.Fatalf("create project store: %v", err)
	}
	signaling := &rowLoadSignalingStore{ProjectStore: store, loads: make(chan string, 16)}
	if err := signaling.SaveProject(context.Background(), project.ProjectInfo{
		ID:            "proj-1",
		Name:          "Research",
		WorkspacePath: ws,
		ResearchRoot:  root,
	}); err != nil {
		t.Fatalf("save project: %v", err)
	}

	f = &FrontendAPI{
		projectManager: project.NewManager(signaling, base, nil),
		projStore:      store,
		emitEvent:      func(string, ...any) {},
	}
	return f, "proj-1", root, signaling.loads
}

// waitForInitialRowLoad blocks until the RPC goroutine's pre-mutex row load
// has been observed on the signal channel (bounded).
func waitForInitialRowLoad(t *testing.T, loads chan string) {
	t.Helper()
	select {
	case <-loads:
	case <-time.After(5 * time.Second):
		t.Fatal("RPC goroutine did not perform its initial row load within 5s")
	}
}

// TestResearchRPC_PinSaveMergesConcurrentRowWrite verifies the merge half of
// the contract: a pin RPC that waited on the mutation mutex while another
// serialized writer committed a DIFFERENT pin must not lose that pin — its
// save starts from the row state its mutex predecessor committed, not from
// the snapshot taken before the wait.
func TestResearchRPC_PinSaveMergesConcurrentRowWrite(t *testing.T) {
	f, projectID, root, loads := researchLostUpdateTestFrontend(t)

	// Hold the per-root mutation mutex so the pin RPC parks at its save
	// phase; the concurrent writer below commits "while it waits".
	mu := f.researchMutationMu(root)
	mu.Lock()

	done := make(chan error, 1)
	go func() { done <- f.SetHypothesisPinned(projectID, "R-001", "H-001", true) }()

	// Deterministic interleave: wait for the RPC's initial (pre-mutex) row
	// load before committing the competing pin.
	waitForInitialRowLoad(t, loads)

	// Simulate a serialized writer (another pin RPC holding the mutex)
	// committing an H-002 pin between the RPC's initial row load and its
	// save.
	row, err := f.projectManager.GetProject(projectID)
	if err != nil {
		mu.Unlock()
		t.Fatalf("load project: %v", err)
	}
	row.ResearchPins.Hypotheses = map[string][]string{
		"H-002": {"R-001-test/hypotheses/H-002.md"},
	}
	if err := f.projStore.SaveProject(context.Background(), *row); err != nil {
		mu.Unlock()
		t.Fatalf("commit concurrent pin: %v", err)
	}
	mu.Unlock()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("SetHypothesisPinned: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("SetHypothesisPinned did not finish after the mutation mutex was released")
	}

	final, err := f.projectManager.GetProject(projectID)
	if err != nil {
		t.Fatalf("reload project: %v", err)
	}
	if got := final.ResearchPins.Hypotheses["H-001"]; len(got) != 1 || got[0] != "R-001-test/hypotheses/H-001.md" {
		t.Errorf("H-001 pin = %v, want the RPC's own pin to persist", got)
	}
	if got, ok := final.ResearchPins.Hypotheses["H-002"]; !ok || len(got) != 1 {
		t.Errorf("H-002 pin = %v (present=%t), want the concurrently committed pin to survive — a stale full-row save lost it", got, ok)
	}
}

// TestResearchRPC_PinDoesNotResurrectClearedResearchRoot verifies the guard
// half of the contract: when DisableResearch clears ResearchRoot while a pin
// RPC waits on the mutation mutex, the pin RPC must fail cleanly instead of
// saving its stale row — a full-row save of the pre-wait snapshot would
// resurrect the cleared root, silently re-enabling RESEARCH mode.
func TestResearchRPC_PinDoesNotResurrectClearedResearchRoot(t *testing.T) {
	f, projectID, root, loads := researchLostUpdateTestFrontend(t)

	mu := f.researchMutationMu(root)
	mu.Lock()

	done := make(chan error, 1)
	go func() { done <- f.SetResearchPinned(projectID, "R-001", true) }()

	// Deterministic interleave: the RPC must have loaded the row (root still
	// set) before the clear below commits.
	waitForInitialRowLoad(t, loads)

	// Simulate DisableResearch's committed clear while the RPC waits.
	row, err := f.projectManager.GetProject(projectID)
	if err != nil {
		mu.Unlock()
		t.Fatalf("load project: %v", err)
	}
	row.ResearchRoot = ""
	if err := f.projStore.SaveProject(context.Background(), *row); err != nil {
		mu.Unlock()
		t.Fatalf("commit disable clear: %v", err)
	}
	mu.Unlock()

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("pin RPC succeeded although the research root was cleared concurrently")
		}
		if !errors.Is(err, errResearchRootChanged) {
			t.Fatalf("pin RPC error = %v, want errResearchRootChanged", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("SetResearchPinned did not finish after the mutation mutex was released")
	}

	final, err := f.projectManager.GetProject(projectID)
	if err != nil {
		t.Fatalf("reload project: %v", err)
	}
	if final.ResearchRoot != "" {
		t.Errorf("research root resurrected by the pin save: %q, want it to stay cleared", final.ResearchRoot)
	}
}

// TestResearchRPC_DisableResearchTakesRootMutationMutex verifies
// DisableResearch serializes on the same per-root mutation mutex as the pin
// RPCs: while the mutex is held externally, the disable cannot complete.
func TestResearchRPC_DisableResearchTakesRootMutationMutex(t *testing.T) {
	f, projectID, root, _ := researchRootTestFrontend(t, []string{"R-001-test"}, project.ResearchPins{})

	mu := f.researchMutationMu(root)
	mu.Lock()

	done := make(chan error, 1)
	go func() { done <- f.DisableResearch(projectID) }()

	select {
	case err := <-done:
		mu.Unlock()
		t.Fatalf("DisableResearch completed while the per-root mutation mutex was held externally: %v", err)
	case <-time.After(200 * time.Millisecond):
		// Still parked on the mutex — the serialization holds.
	}
	mu.Unlock()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("DisableResearch: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("DisableResearch did not finish after the mutation mutex was released")
	}

	final, err := f.projectManager.GetProject(projectID)
	if err != nil {
		t.Fatalf("reload project: %v", err)
	}
	if final.ResearchRoot != "" {
		t.Errorf("research root = %q after disable, want cleared", final.ResearchRoot)
	}
}

// TestResearchRPC_EnableResearchTakesRootMutationMutex verifies EnableResearch
// persists the research root under the same per-root mutation mutex (keyed by
// the resolved root, which equals the persisted root for the default path):
// while the mutex is held externally, the enable cannot complete its save.
func TestResearchRPC_EnableResearchTakesRootMutationMutex(t *testing.T) {
	f, projectID, root, _ := researchRootTestFrontend(t, []string{"R-001-test"}, project.ResearchPins{})

	// EnableResearch resolves the default root as
	// config.ProjectResearchPath(workspace) — the same string the fixture
	// persisted, so both sides key the same mutex.
	ws := filepath.Dir(root)
	if got, want := config.ProjectResearchPath(ws), root; got != want {
		t.Fatalf("resolved enable root %q does not match the fixture root %q — test premise broken", got, want)
	}

	mu := f.researchMutationMu(root)
	mu.Lock()

	done := make(chan error, 1)
	go func() {
		_, err := f.EnableResearch(projectID, "")
		done <- err
	}()

	select {
	case err := <-done:
		mu.Unlock()
		t.Fatalf("EnableResearch completed while the per-root mutation mutex was held externally: %v", err)
	case <-time.After(200 * time.Millisecond):
		// Still parked on the mutex — the serialization holds.
	}
	mu.Unlock()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("EnableResearch: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("EnableResearch did not finish after the mutation mutex was released")
	}

	final, err := f.projectManager.GetProject(projectID)
	if err != nil {
		t.Fatalf("reload project: %v", err)
	}
	if final.ResearchRoot != root {
		t.Errorf("research root = %q after enable, want %q", final.ResearchRoot, root)
	}
}
