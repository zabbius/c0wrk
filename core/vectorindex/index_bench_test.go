package vectorindex

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/v0lka/sp4rk/embedding"
)

const benchmarkCorpusFiles = 24

type benchmarkBatchEmbedder struct {
	batchSize  int
	inferences atomic.Int64
}

func (e *benchmarkBatchEmbedder) EmbedDocuments(_ context.Context, texts []string) ([][]float32, error) {
	for start := 0; start < len(texts); start += e.batchSize {
		e.inferences.Add(1)
	}
	vectors := make([][]float32, len(texts))
	for i, text := range texts {
		vectors[i] = deterministicEmbedding(text)
	}
	return vectors, nil
}

func deterministicEmbedding(text string) []float32 {
	var a, b, c float32 = 1, 1, 1
	for i, r := range text {
		switch i % 3 {
		case 0:
			a += float32(r%97) / 97
		case 1:
			b += float32(r%89) / 89
		default:
			c += float32(r%83) / 83
		}
	}
	return []float32{a, b, c}
}

func benchmarkCorpusText(kind string, i int) string {
	short := fmt.Sprintf("package corpus\n\nfunc Item%d() int { return %d }\n", i, i)
	if kind == "short" {
		return short
	}
	paragraph := strings.Repeat(fmt.Sprintf("worker%d validates bounded indexing telemetry and deterministic batches. ", i), 18)
	return short + "\n// " + paragraph + "\n\n" +
		fmt.Sprintf("type Record%d struct { Name string; Values []int }\n", i) +
		"\n# synthetic markdown section\n\n" + paragraph + "\n"
}

func writeBenchmarkCorpus(tb testing.TB, root, kind string) {
	tb.Helper()
	for i := range benchmarkCorpusFiles {
		ext := ".go"
		if kind == "mixed" && i%3 == 1 {
			ext = ".md"
		}
		path := filepath.Join(root, fmt.Sprintf("file-%02d%s", i, ext))
		if err := os.WriteFile(path, []byte(benchmarkCorpusText(kind, i)), 0o600); err != nil {
			tb.Fatalf("write corpus file: %v", err)
		}
	}
}

func benchmarkChunker(path string, content []byte, maxChunkSize, overlap int) ([]ChunkResult, error) {
	chunks, err := embedding.ChunkFile(path, content, embedding.ChunkerConfig{
		MaxChunkSize: maxChunkSize,
		Overlap:      overlap,
	})
	if err != nil {
		return nil, err
	}
	out := make([]ChunkResult, 0, len(chunks))
	for _, chunk := range chunks {
		out = append(out, ChunkResult{
			Content: chunk.Content, StartLine: chunk.StartLine,
			EndLine: chunk.EndLine, Language: chunk.Language,
		})
	}
	return out, nil
}

func TestBenchmarkCorpusDeterministic(t *testing.T) {
	t.Parallel()
	for _, kind := range []string{"short", "mixed"} {
		a, b := t.TempDir(), t.TempDir()
		writeBenchmarkCorpus(t, a, kind)
		writeBenchmarkCorpus(t, b, kind)
		for i := range benchmarkCorpusFiles {
			ext := ".go"
			if kind == "mixed" && i%3 == 1 {
				ext = ".md"
			}
			left, err := os.ReadFile(filepath.Join(a, fmt.Sprintf("file-%02d%s", i, ext)))
			if err != nil {
				t.Fatal(err)
			}
			right, err := os.ReadFile(filepath.Join(b, fmt.Sprintf("file-%02d%s", i, ext)))
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(left, right) {
				t.Fatalf("%s corpus file %d is not deterministic", kind, i)
			}
		}
	}
}

func BenchmarkIndexingPipeline(b *testing.B) {
	for _, corpus := range []string{"short", "mixed"} {
		for _, batchSize := range []int{8, 16, 32, 64} {
			name := fmt.Sprintf("corpus=%s/batch=%d", corpus, batchSize)
			b.Run(name, func(b *testing.B) {
				benchmarkIndexScenarios(b, corpus, batchSize)
			})
		}
	}
}

// realONNXEmbedder caches the process-wide ONNX embedder for
// BenchmarkRealONNXIndexingPersistence. The ONNX Runtime environment is a
// process-global singleton guarded by sync.Once inside sp4rk: the first
// initialization is final and can never be repeated, even after Close
// destroyed the environment (see embedding/main_test.go). A benchmark
// function may be invoked several times within one test binary, so the
// embedder is created exactly once and never closed — the process exit
// reclaims the environment, mirroring the manager's bounded-shutdown
// trade-off.
var realONNXEmbedder struct {
	once     sync.Once
	embedder *embedding.Embedder
	err      error
}

func realONNXBatchEmbedder(b *testing.B) *embedding.Embedder {
	b.Helper()
	realONNXEmbedder.once.Do(func() {
		modelPath := os.Getenv("EMBEDDING_TEST_MODEL_PATH")
		tokenizerPath := os.Getenv("EMBEDDING_TEST_TOKENIZER_PATH")
		libraryPath := os.Getenv("EMBEDDING_TEST_LIBRARY_PATH")
		if modelPath == "" || tokenizerPath == "" || libraryPath == "" {
			realONNXEmbedder.err = errRealONNXAssetsUnavailable
			return
		}
		embedder, err := embedding.NewEmbedder(embedding.EmbedderConfig{
			ModelPath: modelPath, TokenizerPath: tokenizerPath, LibraryPath: libraryPath,
			BatchSize: 32,
		})
		realONNXEmbedder.embedder = embedder
		realONNXEmbedder.err = err
	})
	if errors.Is(realONNXEmbedder.err, errRealONNXAssetsUnavailable) {
		b.Skip("set EMBEDDING_TEST_MODEL_PATH, EMBEDDING_TEST_TOKENIZER_PATH, and EMBEDDING_TEST_LIBRARY_PATH")
	}
	if realONNXEmbedder.err != nil {
		b.Fatalf("NewEmbedder: %v", realONNXEmbedder.err)
	}
	return realONNXEmbedder.embedder
}

// errRealONNXAssetsUnavailable marks the opt-out path of the real-ONNX
// benchmark when local model/runtime assets are not configured.
var errRealONNXAssetsUnavailable = errors.New("real ONNX benchmark assets unavailable")

// BenchmarkRealONNXIndexingPersistence is the go/no-go profile for
// pipelining embedding with chromem/Bleve persistence (see BENCHMARKS.md,
// "Embedding/persistence pipelining gate"). Unlike BenchmarkIndexingPipeline
// it drives the production ONNX embedder, so the persistence share
// (chromem_commit + bleve_upsert) is measured against representative
// inference wall time instead of the deterministic embedder's near-zero
// inference cost. The scenario is a cold full pass: fresh chromem + Bleve
// stores per iteration, which is the persistence-heaviest path.
func BenchmarkRealONNXIndexingPersistence(b *testing.B) {
	embedder := realONNXBatchEmbedder(b)
	for _, corpus := range []string{"short", "mixed"} {
		b.Run("corpus="+corpus, func(b *testing.B) {
			for range b.N {
				root := b.TempDir()
				writeBenchmarkCorpus(b, root, corpus)
				telemetry := &Telemetry{}
				svc, svcErr := NewService(ServiceConfig{
					EmbeddingFunc: embedder.EmbeddingFunc(), BatchEmbedder: embedder,
					EmbeddingBatchSize: 32, Telemetry: telemetry,
				})
				if svcErr != nil {
					b.Fatal(svcErr)
				}
				if setErr := svc.SetProject("benchmark-real-onnx", b.TempDir()); setErr != nil {
					b.Fatal(setErr)
				}
				if switchErr := svc.SwitchBranch(context.Background(), "main"); switchErr != nil {
					b.Fatal(switchErr)
				}
				idx := NewIndexer(IndexerConfig{
					Service: svc, ChunkFn: benchmarkChunker, PrepWorkers: 1, Telemetry: telemetry,
				})

				started := time.Now()
				if indexErr := idx.IndexFull(context.Background(), root); indexErr != nil {
					b.Fatal(indexErr)
				}
				elapsed := time.Since(started)
				snapshot := telemetry.Snapshot()
				persistence := snapshot.Stages[StageChromemCommit].Duration + snapshot.Stages[StageBleveUpsert].Duration
				b.ReportMetric(float64(elapsed)/float64(time.Millisecond), "ms/pass")
				b.ReportMetric(float64(snapshot.Stages[StageEmbedding].Duration)/float64(time.Millisecond), "ms/embedding")
				b.ReportMetric(float64(snapshot.Stages[StageChromemCommit].Duration)/float64(time.Millisecond), "ms/chromem_commit")
				b.ReportMetric(float64(snapshot.Stages[StageBleveUpsert].Duration)/float64(time.Millisecond), "ms/bleve_upsert")
				b.ReportMetric(float64(persistence)/float64(elapsed), "persistence-ratio")
				if closeErr := svc.Close(); closeErr != nil {
					b.Fatal(closeErr)
				}
			}
		})
	}
}

func benchmarkIndexScenarios(b *testing.B, corpus string, batchSize int) {
	b.Run("cold_full", func(b *testing.B) {
		for range b.N {
			root := b.TempDir()
			writeBenchmarkCorpus(b, root, corpus)
			telemetry, embedder, svc, idx := newBenchmarkPipeline(b, root, batchSize)
			started := time.Now()
			if err := idx.IndexFull(context.Background(), root); err != nil {
				b.Fatal(err)
			}
			reportIndexMetrics(b, telemetry.Snapshot(), embedder.inferences.Load(), benchmarkCorpusFiles, time.Since(started))
			if err := svc.Close(); err != nil {
				b.Fatal(err)
			}
		}
	})

	root := b.TempDir()
	writeBenchmarkCorpus(b, root, corpus)
	telemetry, embedder, svc, idx := newBenchmarkPipeline(b, root, batchSize)
	if err := idx.IndexFull(context.Background(), root); err != nil {
		b.Fatal(err)
	}
	b.Cleanup(func() { _ = svc.Close() })

	b.Run("warm_full", func(b *testing.B) {
		for range b.N {
			telemetry.Reset()
			before := embedder.inferences.Load()
			started := time.Now()
			if err := idx.IndexFull(context.Background(), root); err != nil {
				b.Fatal(err)
			}
			reportIndexMetrics(b, telemetry.Snapshot(), embedder.inferences.Load()-before, benchmarkCorpusFiles, time.Since(started))
		}
	})

	b.Run("warm_incremental_noop", func(b *testing.B) {
		for range b.N {
			telemetry.Reset()
			before := embedder.inferences.Load()
			started := time.Now()
			if err := idx.IndexIncremental(context.Background(), root); err != nil {
				b.Fatal(err)
			}
			reportIndexMetrics(b, telemetry.Snapshot(), embedder.inferences.Load()-before, benchmarkCorpusFiles, time.Since(started))
		}
	})

	b.Run("warm_incremental_one_file", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			path := filepath.Join(root, "file-00.go")
			content := benchmarkCorpusText(corpus, 0) + fmt.Sprintf("\n// revision %d\n", i)
			if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
				b.Fatal(err)
			}
			telemetry.Reset()
			before := embedder.inferences.Load()
			started := time.Now()
			if err := idx.IndexIncremental(context.Background(), root); err != nil {
				b.Fatal(err)
			}
			reportIndexMetrics(b, telemetry.Snapshot(), embedder.inferences.Load()-before, 1, time.Since(started))
		}
	})
}

func newBenchmarkPipeline(b *testing.B, root string, batchSize int) (*Telemetry, *benchmarkBatchEmbedder, *Service, *Indexer) {
	b.Helper()
	telemetry := &Telemetry{}
	embedder := &benchmarkBatchEmbedder{batchSize: batchSize}
	svc, err := NewService(ServiceConfig{
		EmbeddingFunc: func(_ context.Context, text string) ([]float32, error) { return deterministicEmbedding(text), nil },
		BatchEmbedder: embedder, EmbeddingBatchSize: batchSize, Telemetry: telemetry,
	})
	if err != nil {
		b.Fatal(err)
	}
	if err := svc.SetProject("benchmark", b.TempDir()); err != nil {
		b.Fatal(err)
	}
	if err := svc.SwitchBranch(context.Background(), "main"); err != nil {
		b.Fatal(err)
	}
	idx := NewIndexer(IndexerConfig{
		Service: svc, ChunkFn: benchmarkChunker, PrepWorkers: 1, Telemetry: telemetry,
	})
	return telemetry, embedder, svc, idx
}

func reportIndexMetrics(b *testing.B, s TelemetrySnapshot, inferences int64, docs int, elapsed time.Duration) {
	b.Helper()
	b.ReportMetric(float64(docs)/elapsed.Seconds(), "docs/sec")
	b.ReportMetric(float64(elapsed)/float64(time.Millisecond), "ms/pass")
	b.ReportMetric(s.BatchFill(), "index-batch-fill")
	b.ReportMetric(float64(inferences), "inferences/pass")
	for _, stage := range []TelemetryStage{
		StageWalkValidation, StageReadHashChunk, StageCacheLookup,
		StageEmbedding, StageChromemCommit, StageBleveUpsert,
	} {
		b.ReportMetric(float64(s.Stages[stage].Duration)/float64(time.Millisecond), "ms/"+string(stage))
	}
}
