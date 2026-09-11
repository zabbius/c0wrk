package vectorindex

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func newCacheTestService(t *testing.T, root, fingerprint string, maxBytes int64, batch *fakeBatchEmbedder) *Service {
	t.Helper()
	telemetry := &Telemetry{}
	svc, err := NewService(ServiceConfig{
		EmbeddingFunc:             fakeEmbeddingFunc(),
		BatchEmbedder:             batch,
		EmbeddingBatchSize:        2,
		EmbeddingCacheFingerprint: fingerprint,
		EmbeddingDimension:        8,
		EmbeddingCacheMaxBytes:    maxBytes,
		Telemetry:                 telemetry,
	})
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	cachePath := filepath.Join(root, "embedding_cache")
	if err := svc.SetProject("cache-test", root, cachePath); err != nil {
		t.Fatalf("SetProject: %v", err)
	}
	t.Cleanup(func() { _ = svc.Close() })
	return svc
}

func TestEmbeddingCache_DeduplicatesNormalizedChunksAndWarmHitSkipsEmbedder(t *testing.T) {
	root := t.TempDir()
	coldBatch := &fakeBatchEmbedder{}
	cold := newCacheTestService(t, root, "fp-a", 1<<20, coldBatch)
	texts := []string{"same\r\nchunk", "other", "same\nchunk", "same\rchunk"}

	coldVecs, failed, err := cold.resolveEmbeddingChunk(context.Background(), normalizedTexts(texts))
	if err != nil {
		t.Fatalf("cold resolveEmbeddingChunk: %v", err)
	}
	if len(failed) != 0 {
		t.Fatalf("cold failed = %v, want none", failed)
	}
	if got := coldBatch.recordedTexts(); !reflect.DeepEqual(got, []string{"same\nchunk", "other"}) {
		t.Fatalf("cold embedder texts = %q, want two unique normalized chunks", got)
	}
	if !reflect.DeepEqual(coldVecs[0], coldVecs[2]) || !reflect.DeepEqual(coldVecs[0], coldVecs[3]) {
		t.Fatal("normalized duplicate chunks did not receive identical vectors")
	}

	warmBatch := &fakeBatchEmbedder{}
	warm := newCacheTestService(t, root, "fp-a", 1<<20, warmBatch)
	warmVecs, failed, err := warm.resolveEmbeddingChunk(context.Background(), normalizedTexts(texts))
	if err != nil {
		t.Fatalf("warm resolveEmbeddingChunk: %v", err)
	}
	if len(failed) != 0 {
		t.Fatalf("warm failed = %v, want none", failed)
	}
	if got := warmBatch.recordedTexts(); len(got) != 0 {
		t.Fatalf("warm cache hit invoked embedder with %q; want zero ONNX inputs", got)
	}
	if !reflect.DeepEqual(warmVecs, coldVecs) {
		t.Fatal("warm vectors differ from cold vectors")
	}
	snapshot := warm.telemetry.Snapshot()
	const uniqueChunks = 2
	if snapshot.EmbeddingHits != uniqueChunks || snapshot.EmbeddingCacheHitRatio() != 1 {
		t.Fatalf("warm telemetry hits=%d misses=%d ratio=%v, want %d/0/1", snapshot.EmbeddingHits, snapshot.EmbeddingMisses, snapshot.EmbeddingCacheHitRatio(), uniqueChunks)
	}
}

func normalizedTexts(texts []string) []string {
	out := make([]string, len(texts))
	for i, text := range texts {
		out[i] = normalizeEmbeddingChunk(text)
	}
	return out
}

func TestEmbeddingCache_ReusesAcrossBranchSwitch(t *testing.T) {
	root := t.TempDir()
	cachePath := filepath.Join(root, "cache")
	batch := &fakeBatchEmbedder{}
	svc, err := NewService(ServiceConfig{
		EmbeddingFunc:             fakeEmbeddingFunc(),
		BatchEmbedder:             batch,
		EmbeddingBatchSize:        8,
		EmbeddingCacheFingerprint: "fp-branch",
		EmbeddingDimension:        8,
		EmbeddingCacheMaxBytes:    1 << 20,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.SetProject("project", root, cachePath); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = svc.Close() })

	for _, branch := range []string{"main", "feature"} {
		if err := svc.SwitchBranch(context.Background(), branch); err != nil {
			t.Fatal(err)
		}
		doc := batchTestDocs(1)
		svc.AcquireWriteLock()
		err := svc.AddDocuments(context.Background(), doc, nil)
		svc.ReleaseWriteLock()
		if err != nil {
			t.Fatal(err)
		}
	}
	if got := batch.recordedTexts(); !reflect.DeepEqual(got, []string{batchTestDocs(1)[0].Content}) {
		t.Fatalf("branch switch embedder inputs = %q, want one cold input", got)
	}
	if _, err := os.Stat(cachePath); err != nil {
		t.Fatalf("cache not stored at explicit vector-index path: %v", err)
	}
}

func TestEmbeddingCache_PathOutsideVectorStorageIsDisabled(t *testing.T) {
	root := t.TempDir()
	outside := filepath.Join(t.TempDir(), "cache")
	svc, err := NewService(ServiceConfig{
		EmbeddingFunc:             fakeEmbeddingFunc(),
		BatchEmbedder:             &fakeBatchEmbedder{},
		EmbeddingCacheFingerprint: "fp-path",
		EmbeddingDimension:        8,
		EmbeddingCacheMaxBytes:    1 << 20,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.SetProject("project", root, outside); err != nil {
		t.Fatalf("cache containment must fail open: %v", err)
	}
	t.Cleanup(func() { _ = svc.Close() })
	if svc.current.embeddingCache != nil {
		t.Fatal("outside cache path was accepted")
	}
}

func TestEmbeddingCache_FingerprintInvalidatesModelTokenizerAndParameters(t *testing.T) {
	dir := t.TempDir()
	model := filepath.Join(dir, "model.onnx")
	tokenizer := filepath.Join(dir, "tokenizer.json")
	if err := os.WriteFile(model, []byte("model-a"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(tokenizer, []byte("tokenizer-a"), 0o600); err != nil {
		t.Fatal(err)
	}
	base := EmbeddingFingerprintParams{MaxSeqLength: 512, Dimension: 8, NormalizationAlgorithm: "norm-v1"}
	fp, err := EmbeddingFingerprint(model, tokenizer, base)
	if err != nil {
		t.Fatal(err)
	}
	variants := []EmbeddingFingerprintParams{
		{MaxSeqLength: 256, Dimension: 8, NormalizationAlgorithm: "norm-v1"},
		{MaxSeqLength: 512, Dimension: 16, NormalizationAlgorithm: "norm-v1"},
		{MaxSeqLength: 512, Dimension: 8, NormalizationAlgorithm: "norm-v2"},
	}
	for _, variant := range variants {
		got, err := EmbeddingFingerprint(model, tokenizer, variant)
		if err != nil {
			t.Fatal(err)
		}
		if got == fp {
			t.Fatalf("parameter change did not invalidate fingerprint: %+v", variant)
		}
	}
	if err := os.WriteFile(model, []byte("model-b"), 0o600); err != nil {
		t.Fatal(err)
	}
	modelChanged, err := EmbeddingFingerprint(model, tokenizer, base)
	if err != nil {
		t.Fatal(err)
	}
	if modelChanged == fp {
		t.Fatal("model content change did not invalidate fingerprint")
	}
	if err := os.WriteFile(model, []byte("model-a"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(tokenizer, []byte("tokenizer-b"), 0o600); err != nil {
		t.Fatal(err)
	}
	tokenizerChanged, err := EmbeddingFingerprint(model, tokenizer, base)
	if err != nil {
		t.Fatal(err)
	}
	if tokenizerChanged == fp {
		t.Fatal("tokenizer content change did not invalidate fingerprint")
	}
}

func TestEmbeddingCache_CorruptionFailsOpenAndRebuilds(t *testing.T) {
	root := t.TempDir()
	firstBatch := &fakeBatchEmbedder{}
	first := newCacheTestService(t, root, "fp-corrupt", 1<<20, firstBatch)
	text := "cached content"
	if _, _, err := first.resolveEmbeddingChunk(context.Background(), []string{text}); err != nil {
		t.Fatal(err)
	}
	entryPath := first.current.embeddingCache.path(first.current.embeddingCache.key(text))
	if err := os.WriteFile(entryPath, []byte("corrupt"), 0o600); err != nil {
		t.Fatal(err)
	}

	rebuildBatch := &fakeBatchEmbedder{}
	rebuild := newCacheTestService(t, root, "fp-corrupt", 1<<20, rebuildBatch)
	vecs, failed, err := rebuild.resolveEmbeddingChunk(context.Background(), []string{text})
	if err != nil {
		t.Fatalf("corrupt cache must fail open: %v", err)
	}
	if len(failed) != 0 || len(vecs) != 1 || len(vecs[0]) != 8 {
		t.Fatalf("rebuild result invalid: vecs=%v failed=%v", vecs, failed)
	}
	if got := rebuildBatch.recordedTexts(); !reflect.DeepEqual(got, []string{text}) {
		t.Fatalf("corruption rebuild embedder texts = %q, want %q", got, []string{text})
	}
	data, err := os.ReadFile(entryPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := decodeEmbeddingCacheEntry(data, 8); err != nil {
		t.Fatalf("rebuilt entry is invalid: %v", err)
	}
}

func TestEmbeddingCache_RejectsWrongDimensionAndChecksum(t *testing.T) {
	vec := []float32{1, 2, 3, 4}
	data := encodeEmbeddingCacheEntry(vec)
	if _, err := decodeEmbeddingCacheEntry(data, 8); err == nil {
		t.Fatal("wrong dimension accepted")
	}
	data[len(data)-1] ^= 0xff
	if _, err := decodeEmbeddingCacheEntry(data, 4); err == nil {
		t.Fatal("checksum corruption accepted")
	}
}

func TestEmbeddingCache_PrunesOldestEntriesToSizeCap(t *testing.T) {
	root := t.TempDir()
	entrySize := int64(len(encodeEmbeddingCacheEntry(make([]float32, 8))))
	// Cap the cache at exactly the three entries' combined size: the tracked
	// total sits at 100% of the cap, past the 95% prune-at threshold, so
	// prune must walk and evict oldest-first down to the 90% low-water mark —
	// which removes only the oldest entry.
	cache := newEmbeddingCache(root, "fp-prune", 8, entrySize*3, nil)
	for i, text := range []string{"oldest", "middle", "newest"} {
		cache.put(text, make([]float32, 8))
		path := cache.path(cache.key(text))
		stamp := time.Unix(int64(i+1), 0)
		if _, err := os.Stat(path); err == nil {
			if err := os.Chtimes(path, stamp, stamp); err != nil {
				t.Fatal(err)
			}
		}
	}
	// Run pruning after deterministic timestamps are installed, matching the
	// once-per-resolved-batch production call.
	cache.prune()
	if _, ok := cache.get("oldest"); ok {
		t.Fatal("oldest cache entry survived pruning")
	}
	if _, ok := cache.get("middle"); !ok {
		t.Fatal("middle cache entry was pruned unexpectedly")
	}
	if _, ok := cache.get("newest"); !ok {
		t.Fatal("newest cache entry was pruned unexpectedly")
	}
	if cache.trackedBytes != 2*entrySize {
		t.Fatalf("prune() trackedBytes = %d, want reconciled %d", cache.trackedBytes, 2*entrySize)
	}
}

// TestEmbeddingCache_PruneFastPathSkipsWalksUnderCap pins the amortization
// contract: below the prune-at threshold and between forced reconciliations,
// the once-per-resolved-batch production prune must not walk the tree at all,
// and crossing the threshold must evict oldest-first down to the exact
// low-water mark.
func TestEmbeddingCache_PruneFastPathSkipsWalksUnderCap(t *testing.T) {
	root := t.TempDir()
	entrySize := int64(len(encodeEmbeddingCacheEntry(make([]float32, 8))))
	const totalEntries = 96 // 96% of a 100-entry cap, past the 95% prune-at threshold
	cache := newEmbeddingCache(root, "fp-fastpath", 8, entrySize*100, nil)

	// The SetProject prune: the one seeding walk a fresh cache must perform.
	cache.prune()
	if cache.pruneWalks != 1 || !cache.accountingSeeded {
		t.Fatalf("initial prune: walks=%d seeded=%t, want 1/true", cache.pruneWalks, cache.accountingSeeded)
	}

	// Simulate cold-indexing resolve batches: one put + one prune each. While
	// tracked bytes stay below 95% of the cap, none of these prunes may walk.
	for i := 0; i < 90; i++ {
		cache.put(fmt.Sprintf("chunk-%d", i), make([]float32, 8))
		cache.prune()
	}
	if got := cache.pruneWalks; got != 1 {
		t.Fatalf("pruneWalks = %d after 90 under-cap batches, want 1 (seeding walk only)", got)
	}
	if cache.trackedBytes != 90*entrySize {
		t.Fatalf("trackedBytes = %d after 90 puts, want %d", cache.trackedBytes, 90*entrySize)
	}

	// Finish the corpus and install deterministic increasing timestamps so
	// eviction order follows the construction index, then cross the
	// prune-at threshold.
	for i := 90; i < totalEntries; i++ {
		cache.put(fmt.Sprintf("chunk-%d", i), make([]float32, 8))
	}
	for i := 0; i < totalEntries; i++ {
		path := cache.path(cache.key(fmt.Sprintf("chunk-%d", i)))
		stamp := time.Unix(int64(i+1), 0)
		if err := os.Chtimes(path, stamp, stamp); err != nil {
			t.Fatal(err)
		}
	}
	if cache.trackedBytes < cache.maxBytes*embeddingCachePruneAtPercent/100 {
		t.Fatalf("test setup error: trackedBytes=%d did not cross the prune-at threshold %d", cache.trackedBytes, cache.maxBytes*embeddingCachePruneAtPercent/100)
	}
	cache.prune()
	if got := cache.pruneWalks; got != 2 {
		t.Fatalf("pruneWalks = %d after crossing the prune-at threshold, want 2", got)
	}
	// The low-water mark is 90% of the cap: exactly 6 of the 96 entries are
	// evicted, oldest first, and the accounting reconciles to the mark.
	if _, ok := cache.get("chunk-5"); ok {
		t.Fatal("chunk-5 (6th oldest) survived the low-water eviction")
	}
	if _, ok := cache.get("chunk-6"); !ok {
		t.Fatal("chunk-6 was evicted before the low-water mark was reached")
	}
	if cache.trackedBytes != 90*entrySize {
		t.Fatalf("prune() trackedBytes = %d, want low-water mark %d", cache.trackedBytes, 90*entrySize)
	}
	if cache.putsSinceReconcile != 0 {
		t.Fatalf("putsSinceReconcile = %d after a walked prune, want 0", cache.putsSinceReconcile)
	}
}

// TestEmbeddingCache_PruneReconcilesAccountingDrift pins the drift backstop:
// the tracked-bytes counter is not repaired while the fast path is in effect,
// a forced reconciliation walk (every reconcileEveryPuts puts) resets it to
// the walked truth, and the corrupt-entry removal in get decrements it by the
// bytes that actually left the tree.
func TestEmbeddingCache_PruneReconcilesAccountingDrift(t *testing.T) {
	root := t.TempDir()
	entrySize := int64(len(encodeEmbeddingCacheEntry(make([]float32, 8))))
	cache := newEmbeddingCache(root, "fp-drift", 8, entrySize*100, nil)
	cache.prune() // seeding walk

	cache.put("kept", make([]float32, 8))
	// An external deletion the incremental accounting cannot observe.
	if err := os.Remove(cache.path(cache.key("kept"))); err != nil {
		t.Fatal(err)
	}
	if cache.trackedBytes != entrySize {
		t.Fatalf("trackedBytes = %d after external deletion, want stale %d", cache.trackedBytes, entrySize)
	}
	// Under the cap the fast path keeps skipping the walk, so the stale value
	// must persist untouched...
	cache.prune()
	if cache.pruneWalks != 1 || cache.trackedBytes != entrySize {
		t.Fatalf("under-cap prune repaired drift without a walk: walks=%d trackedBytes=%d", cache.pruneWalks, cache.trackedBytes)
	}
	// ...until the forced-reconcile cadence (tightened here) triggers a walk.
	cache.reconcileEveryPuts = 1
	cache.prune()
	if cache.pruneWalks != 2 {
		t.Fatalf("pruneWalks = %d after forced reconcile, want 2", cache.pruneWalks)
	}
	if cache.trackedBytes != 0 {
		t.Fatalf("reconcile trackedBytes = %d, want walked truth 0", cache.trackedBytes)
	}

	// get() removing a corrupt entry decrements the accounting by the bytes
	// actually leaving the tree (the whole file was read into memory).
	cache.put("corrupt", make([]float32, 8))
	if err := os.WriteFile(cache.path(cache.key("corrupt")), []byte("junk"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, ok := cache.get("corrupt"); ok {
		t.Fatal("corrupt cache entry was served")
	}
	if want := entrySize - int64(len("junk")); cache.trackedBytes != want {
		t.Fatalf("trackedBytes = %d after corrupt-entry removal, want %d", cache.trackedBytes, want)
	}
}

// TestEmbeddingCache_NegativeMaxBytesDisablesCache pins the
// vector_index.embedding_cache_max_bytes wiring contract: a negative cap
// disables the cache entirely (every resolve reaches the batch embedder, no
// cache directory is created) while indexing keeps working.
func TestEmbeddingCache_NegativeMaxBytesDisablesCache(t *testing.T) {
	root := t.TempDir()
	cachePath := filepath.Join(root, "embedding_cache")
	batch := &fakeBatchEmbedder{}
	svc, err := NewService(ServiceConfig{
		EmbeddingFunc:             fakeEmbeddingFunc(),
		BatchEmbedder:             batch,
		EmbeddingBatchSize:        2,
		EmbeddingCacheFingerprint: "fp-disabled",
		EmbeddingDimension:        8,
		EmbeddingCacheMaxBytes:    -1,
		Telemetry:                 &Telemetry{},
	})
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	if err := svc.SetProject("cache-test", root, cachePath); err != nil {
		t.Fatalf("SetProject: %v", err)
	}
	t.Cleanup(func() { _ = svc.Close() })

	texts := []string{"alpha", "beta"}
	wantInputs := append(normalizedTexts(texts), normalizedTexts(texts)...)
	for pass := 0; pass < 2; pass++ {
		vecs, failed, err := svc.resolveEmbeddingChunk(context.Background(), normalizedTexts(texts))
		if err != nil {
			t.Fatalf("pass %d resolveEmbeddingChunk: %v", pass, err)
		}
		if len(failed) != 0 {
			t.Fatalf("pass %d failed = %v, want none", pass, failed)
		}
		if len(vecs) != len(texts) {
			t.Fatalf("pass %d vectors = %d, want %d", pass, len(vecs), len(texts))
		}
	}
	// Both passes must reach the embedder — nothing was cached.
	if got := batch.recordedTexts(); !reflect.DeepEqual(got, wantInputs) {
		t.Fatalf("disabled cache embedder inputs = %q, want both passes to reach the embedder", got)
	}
	if snapshot := svc.telemetry.Snapshot(); snapshot.EmbeddingHits != 0 || snapshot.EmbeddingMisses != 0 {
		t.Fatalf("disabled cache telemetry hits=%d misses=%d, want 0/0 (no cache accounting)", snapshot.EmbeddingHits, snapshot.EmbeddingMisses)
	}
	if _, err := os.Stat(cachePath); !os.IsNotExist(err) {
		t.Fatalf("disabled cache created %s (stat err=%v)", cachePath, err)
	}
}
