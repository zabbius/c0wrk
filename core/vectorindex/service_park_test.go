package vectorindex

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"

	chromem "github.com/philippgille/chromem-go"

	"github.com/v0lka/c0wrk/core/vectorindex/lexical"
)

// persistentDBOpenCounter counts chromem.NewPersistentDB opens per cleaned
// path so the park tests can prove that restoring a parked project does NOT
// reopen (and therefore re-gob-decode) its persistent DB.
type persistentDBOpenCounter struct {
	mu    sync.Mutex
	opens map[string]int
}

// installPersistentDBOpenCounter swaps the package-level newPersistentDB seam
// for a counting wrapper and restores the original on test cleanup. Safe
// because the package's tests run sequentially (only the Telemetry tests opt
// into t.Parallel, and they never touch this seam).
func installPersistentDBOpenCounter(t *testing.T) *persistentDBOpenCounter {
	t.Helper()
	c := &persistentDBOpenCounter{opens: make(map[string]int)}
	orig := newPersistentDB
	newPersistentDB = func(path string, compress bool) (*chromem.DB, error) {
		c.mu.Lock()
		c.opens[filepath.Clean(path)]++
		c.mu.Unlock()
		return orig(path, compress)
	}
	t.Cleanup(func() { newPersistentDB = orig })
	return c
}

func (c *persistentDBOpenCounter) count(path string) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.opens[filepath.Clean(path)]
}

func (c *persistentDBOpenCounter) total() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	n := 0
	for _, v := range c.opens {
		n += v
	}
	return n
}

// parkAddDocs opens a write-locked AddDocuments call with a single document so
// the state gains a collection entry and a file-hash sidecar entry.
func parkAddDocs(t *testing.T, svc *Service, dir, name, hash string) {
	t.Helper()
	docs := []chromem.Document{{
		ID:       name + ":0",
		Content:  name,
		Metadata: map[string]string{"file_path": filepath.Join(dir, name), "content_hash": hash},
	}}
	svc.AcquireWriteLock()
	defer svc.ReleaseWriteLock()
	if err := svc.AddDocuments(context.Background(), docs, nil); err != nil {
		t.Fatalf("AddDocuments: %v", err)
	}
}

// TestService_ParkRestoreSkipsReopen is the A→B→A acceptance test: with parking
// enabled, returning to A restores the SAME chromem collection, lexical index,
// and DB objects and never reopens A's persistent DB.
func TestService_ParkRestoreSkipsReopen(t *testing.T) {
	counter := installPersistentDBOpenCounter(t)

	// Storage roots first, close-cleanup second: t.Cleanup is LIFO, so the
	// TempDir RemoveAll must be registered BEFORE svc.Close for Close to run
	// first and release the lexical bolt/zap handles — an open handle fails
	// the unlink on Windows.
	dirA := filepath.Join(t.TempDir(), "A")
	dirB := filepath.Join(t.TempDir(), "B")

	svc, err := NewService(ServiceConfig{EmbeddingFunc: fakeEmbeddingFunc(), ParkCapacity: 2})
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	t.Cleanup(func() { _ = svc.Close() })

	// Open and populate A.
	if err := svc.SetProject("A", dirA); err != nil {
		t.Fatalf("SetProject A: %v", err)
	}
	if err := svc.SwitchBranch(context.Background(), "main"); err != nil {
		t.Fatalf("SwitchBranch A: %v", err)
	}
	parkAddDocs(t, svc, dirA, "a.go", "hashA")

	colA, lexA, dbA := svc.current.collection, svc.current.lexical, svc.current.db
	if colA == nil || lexA == nil || dbA == nil {
		t.Fatalf("A not fully open: collection=%v lexical=%v db=%v", colA != nil, lexA != nil, dbA != nil)
	}

	// Park A by switching to B.
	if err := svc.SetProject("B", dirB); err != nil {
		t.Fatalf("SetProject B: %v", err)
	}
	if err := svc.SwitchBranch(context.Background(), "main"); err != nil {
		t.Fatalf("SwitchBranch B: %v", err)
	}
	if len(svc.parked) != 1 || svc.parked[0].projectID != "A" {
		t.Fatalf("parked = %d entries, want [A]", len(svc.parked))
	}

	// Return to A: must restore, not reopen.
	if err := svc.SetProject("A", dirA); err != nil {
		t.Fatalf("SetProject A (restore): %v", err)
	}

	if svc.current.collection != colA {
		t.Error("restore did not reuse the chromem collection object")
	}
	if svc.current.lexical != lexA {
		t.Error("restore did not reuse the lexical index object")
	}
	if svc.current.db != dbA {
		t.Error("restore did not reuse the chromem DB object")
	}
	if got := counter.count(dirA); got != 1 {
		t.Errorf("persistent DB for A opened %d times, want 1 (restore must not reopen)", got)
	}
	if got := counter.total(); got != 2 {
		t.Errorf("total persistent DB opens = %d, want 2 (A once, B once)", got)
	}
	if got := svc.current.collection.Count(); got != 1 {
		t.Errorf("restored collection has %d docs, want 1", got)
	}
	if svc.current.fileHashes[filepath.Join(dirA, "a.go")] == "" {
		t.Error("restored sidecar lost A's file entry")
	}
	// B is now parked.
	if len(svc.parked) != 1 || svc.parked[0].projectID != "B" {
		t.Errorf("parked = %v, want [B]", parkedIDs(svc))
	}
}

func parkedIDs(svc *Service) []string {
	svc.mu.RLock()
	defer svc.mu.RUnlock()
	ids := make([]string, 0, len(svc.parked))
	for _, ps := range svc.parked {
		ids = append(ids, ps.projectID)
	}
	return ids
}

// TestService_ParkEvictionFlushesSidecar verifies that overflowing the park LRU
// evicts the oldest state and flushes its file-hash sidecar to disk.
func TestService_ParkEvictionFlushesSidecar(t *testing.T) {
	// Storage roots before the Close-cleanup registration (t.Cleanup is
	// LIFO): svc.Close must release the lexical handles before the TempDir
	// RemoveAll, or the unlink fails on Windows.
	base := t.TempDir()
	dirA, dirB, dirC := filepath.Join(base, "A"), filepath.Join(base, "B"), filepath.Join(base, "C")

	svc, err := NewService(ServiceConfig{EmbeddingFunc: fakeEmbeddingFunc(), ParkCapacity: 1})
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	t.Cleanup(func() { _ = svc.Close() })

	if err := svc.SetProject("A", dirA); err != nil {
		t.Fatalf("SetProject A: %v", err)
	}
	if err := svc.SwitchBranch(context.Background(), "main"); err != nil {
		t.Fatalf("SwitchBranch A: %v", err)
	}
	parkAddDocs(t, svc, dirA, "a.go", "hashA")

	// Park A (capacity 1 → LRU holds A).
	if err := svc.SetProject("B", dirB); err != nil {
		t.Fatalf("SetProject B: %v", err)
	}
	if err := svc.SwitchBranch(context.Background(), "main"); err != nil {
		t.Fatalf("SwitchBranch B: %v", err)
	}

	sidecarA := filepath.Join(dirA, "file_hashes_branch_main.json")
	if err := os.Remove(sidecarA); err != nil {
		t.Fatalf("removing A sidecar to make the eviction flush observable: %v", err)
	}

	// Park B → LRU overflow → A evicted (sidecar flushed from its in-memory map).
	if err := svc.SetProject("C", dirC); err != nil {
		t.Fatalf("SetProject C: %v", err)
	}
	if err := svc.SwitchBranch(context.Background(), "main"); err != nil {
		t.Fatalf("SwitchBranch C: %v", err)
	}

	if ids := parkedIDs(svc); len(ids) != 1 || ids[0] != "B" {
		t.Fatalf("parked = %v, want [B] (A must be evicted)", ids)
	}

	data, err := os.ReadFile(sidecarA)
	if err != nil {
		t.Fatalf("evicted A's sidecar was not flushed to disk: %v", err)
	}
	var m map[string]string
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatalf("evicted sidecar is not valid JSON: %v", err)
	}
	if m[filepath.Join(dirA, "a.go")] == "" {
		t.Errorf("evicted sidecar is missing A's entry; got %v", m)
	}
}

// TestService_ParkDisabledReopens verifies that park_capacity=0 reproduces the
// historical behaviour: every switch reopens the persistent DB and nothing is
// parked.
func TestService_ParkDisabledReopens(t *testing.T) {
	counter := installPersistentDBOpenCounter(t)

	// Storage roots before the Close-cleanup registration (t.Cleanup is
	// LIFO): svc.Close must release the lexical handles before the TempDir
	// RemoveAll, or the unlink fails on Windows.
	dirA := filepath.Join(t.TempDir(), "A")
	dirB := filepath.Join(t.TempDir(), "B")

	// ParkCapacity left at its zero value → parking disabled.
	svc, err := NewService(ServiceConfig{EmbeddingFunc: fakeEmbeddingFunc()})
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	t.Cleanup(func() { _ = svc.Close() })

	if err := svc.SetProject("A", dirA); err != nil {
		t.Fatalf("SetProject A: %v", err)
	}
	if err := svc.SwitchBranch(context.Background(), "main"); err != nil {
		t.Fatalf("SwitchBranch A: %v", err)
	}
	parkAddDocs(t, svc, dirA, "a.go", "hashA")
	colA := svc.current.collection

	if err := svc.SetProject("B", dirB); err != nil {
		t.Fatalf("SetProject B: %v", err)
	}
	if err := svc.SwitchBranch(context.Background(), "main"); err != nil {
		t.Fatalf("SwitchBranch B: %v", err)
	}
	if err := svc.SetProject("A", dirA); err != nil {
		t.Fatalf("SetProject A (reopen): %v", err)
	}
	if err := svc.SwitchBranch(context.Background(), "main"); err != nil {
		t.Fatalf("SwitchBranch A (reopen): %v", err)
	}

	if svc.current.collection == colA {
		t.Error("with parking disabled, A should have been reopened (new collection object)")
	}
	if got := counter.count(dirA); got != 2 {
		t.Errorf("persistent DB for A opened %d times, want 2 (reopen expected)", got)
	}
	if len(svc.parked) != 0 {
		t.Errorf("parked = %d, want 0 when parking is disabled", len(svc.parked))
	}
}

// TestService_DeleteProjectDataDropsParked verifies that deleting a project's
// data also discards its parked slot (so a later switch back cannot restore a
// collection rooted at a removed directory).
func TestService_DeleteProjectDataDropsParked(t *testing.T) {
	// Storage roots before the Close-cleanup registration (t.Cleanup is
	// LIFO): svc.Close must release the lexical handles before the TempDir
	// RemoveAll, or the unlink fails on Windows.
	dirA := filepath.Join(t.TempDir(), "A")
	dirB := filepath.Join(t.TempDir(), "B")

	svc, err := NewService(ServiceConfig{EmbeddingFunc: fakeEmbeddingFunc(), ParkCapacity: 2})
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	t.Cleanup(func() { _ = svc.Close() })

	if err := svc.SetProject("A", dirA); err != nil {
		t.Fatalf("SetProject A: %v", err)
	}
	if err := svc.SwitchBranch(context.Background(), "main"); err != nil {
		t.Fatalf("SwitchBranch A: %v", err)
	}
	parkAddDocs(t, svc, dirA, "a.go", "hashA")

	// Park A by switching to B.
	if err := svc.SetProject("B", dirB); err != nil {
		t.Fatalf("SetProject B: %v", err)
	}
	if err := svc.SwitchBranch(context.Background(), "main"); err != nil {
		t.Fatalf("SwitchBranch B: %v", err)
	}
	if len(svc.parked) != 1 {
		t.Fatalf("parked = %d, want 1", len(svc.parked))
	}

	if err := svc.DeleteProjectData(dirA); err != nil {
		t.Fatalf("DeleteProjectData: %v", err)
	}
	if len(svc.parked) != 0 {
		t.Errorf("parked = %d after DeleteProjectData, want 0", len(svc.parked))
	}
	if _, err := os.Stat(dirA); !os.IsNotExist(err) {
		t.Errorf("A's storage directory still exists after delete (err=%v)", err)
	}
}

// TestService_CloseReleasesParked verifies Close releases the current AND every
// parked state's handles and clears the LRU, without hanging.
func TestService_CloseReleasesParked(t *testing.T) {
	svc, err := NewService(ServiceConfig{EmbeddingFunc: fakeEmbeddingFunc(), ParkCapacity: 3})
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}

	dirA := filepath.Join(t.TempDir(), "A")
	dirB := filepath.Join(t.TempDir(), "B")

	if err := svc.SetProject("A", dirA); err != nil {
		t.Fatalf("SetProject A: %v", err)
	}
	if err := svc.SwitchBranch(context.Background(), "main"); err != nil {
		t.Fatalf("SwitchBranch A: %v", err)
	}
	parkAddDocs(t, svc, dirA, "a.go", "hashA")

	// Park A, open B.
	if err := svc.SetProject("B", dirB); err != nil {
		t.Fatalf("SetProject B: %v", err)
	}
	if err := svc.SwitchBranch(context.Background(), "main"); err != nil {
		t.Fatalf("SwitchBranch B: %v", err)
	}
	parkedLex := svc.parked[0].lexical
	if len(svc.parked) != 1 || parkedLex == nil {
		t.Fatalf("expected A parked with an open lexical index")
	}

	if err := svc.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if svc.parked != nil {
		t.Errorf("parked not cleared on Close: %v", svc.parked)
	}
	if svc.current.collection != nil || svc.current.db != nil || svc.current.lexical != nil {
		t.Error("Close did not release the current state's handles")
	}
	// The parked lexical index must have been closed: reopening the same path
	// succeeds only when the previous handle was released.
	relPath := filepath.Join(dirA, "lexical", "main")
	if lex, err := lexical.Open(relPath); err != nil {
		t.Errorf("parked lexical index was not closed (reopen failed): %v", err)
	} else if lex != nil {
		_ = lex.Close()
	}
}

// TestService_ParkConcurrentSwitches hammers SetProject from many goroutines
// (with parking enabled) and asserts the LRU invariants survive: one current
// state, no duplicate parked projectIDs, and never more than parkCapacity
// parked slots. Run under -race it also guards the park/restore bookkeeping.
func TestService_ParkConcurrentSwitches(t *testing.T) {
	svc, err := NewService(ServiceConfig{EmbeddingFunc: fakeEmbeddingFunc(), ParkCapacity: 2})
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	t.Cleanup(func() { _ = svc.Close() })

	base := t.TempDir()
	dirs := map[string]string{
		"A": filepath.Join(base, "A"),
		"B": filepath.Join(base, "B"),
		"C": filepath.Join(base, "C"),
	}
	order := []string{"A", "B", "C"}

	var wg sync.WaitGroup
	for i := 0; i < 24; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			id := order[i%len(order)]
			if err := svc.SetProject(id, dirs[id]); err != nil {
				t.Errorf("SetProject(%s): %v", id, err)
			}
		}(i)
	}
	wg.Wait()

	svc.mu.RLock()
	defer svc.mu.RUnlock()

	if svc.current == nil {
		t.Fatal("current is nil after concurrent switches")
	}
	if len(svc.parked) > svc.parkCapacity {
		t.Errorf("parked = %d, exceeds capacity %d", len(svc.parked), svc.parkCapacity)
	}
	seen := make(map[string]bool, len(svc.parked))
	for _, ps := range svc.parked {
		if seen[ps.projectID] {
			t.Errorf("duplicate parked state for project %q", ps.projectID)
		}
		seen[ps.projectID] = true
	}
	if svc.current.projectID != "" && seen[svc.current.projectID] {
		t.Errorf("current project %q is also present in the park LRU", svc.current.projectID)
	}
}
