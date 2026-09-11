package vectorindex

import (
	"context"
	"fmt"
	"sync/atomic"
	"testing"
	"time"
)

type cacheBenchmarkEmbedder struct {
	inputs atomic.Int64
	delay  time.Duration
}

func (e *cacheBenchmarkEmbedder) EmbedDocuments(ctx context.Context, texts []string) ([][]float32, error) {
	e.inputs.Add(int64(len(texts)))
	if e.delay > 0 {
		timer := time.NewTimer(e.delay)
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-timer.C:
		}
	}
	base := fakeEmbeddingFunc()
	vecs := make([][]float32, len(texts))
	for i, text := range texts {
		vec, err := base(ctx, text)
		if err != nil {
			return nil, err
		}
		vecs[i] = vec
	}
	return vecs, nil
}

// BenchmarkEmbeddingCacheWarm compares a cold document-embedding pass with a
// fully warm persistent cache. The corpus deliberately repeats boilerplate so
// cold results also expose in-batch content deduplication. Run with:
//
//	go test ./core/vectorindex -run '^$' -bench BenchmarkEmbeddingCacheWarm -benchmem
func BenchmarkEmbeddingCacheWarm(b *testing.B) {
	texts := make([]string, 128)
	for i := range texts {
		// 32 unique chunks repeated four times, including line-ending variants.
		lineEnd := "\n"
		if i%2 == 0 {
			lineEnd = "\r\n"
		}
		texts[i] = normalizeEmbeddingChunk(fmt.Sprintf("func boilerplate%d() {%s\treturn%s}", i%32, lineEnd, lineEnd))
	}

	b.Run("cold", func(b *testing.B) {
		embedder := &cacheBenchmarkEmbedder{delay: 10 * time.Millisecond}
		svc, err := NewService(ServiceConfig{
			EmbeddingFunc:      fakeEmbeddingFunc(),
			BatchEmbedder:      embedder,
			EmbeddingBatchSize: 32,
		})
		if err != nil {
			b.Fatal(err)
		}
		b.ReportMetric(0, "hit_ratio")
		b.ReportAllocs()
		b.ResetTimer()
		for range b.N {
			if _, _, err := svc.resolveEmbeddingChunk(context.Background(), texts); err != nil {
				b.Fatal(err)
			}
		}
		b.StopTimer()
		b.ReportMetric(float64(embedder.inputs.Load())/float64(b.N), "embed_inputs/op")
		b.ReportMetric(float64(len(texts)*b.N)/b.Elapsed().Seconds(), "docs/s")
	})

	b.Run("warm", func(b *testing.B) {
		root := b.TempDir()
		seedEmbedder := &cacheBenchmarkEmbedder{delay: time.Millisecond}
		seed := newEmbeddingCache(root, "benchmark-fingerprint", 8, 1<<30, nil)
		seedSvc, err := NewService(ServiceConfig{
			EmbeddingFunc:      fakeEmbeddingFunc(),
			BatchEmbedder:      seedEmbedder,
			EmbeddingBatchSize: 32,
		})
		if err != nil {
			b.Fatal(err)
		}
		seedSvc.embeddingCache = seed
		seedSvc.embeddingDimension = 8
		if _, _, err := seedSvc.resolveEmbeddingChunk(context.Background(), texts); err != nil {
			b.Fatal(err)
		}

		embedder := &cacheBenchmarkEmbedder{delay: 10 * time.Millisecond}
		telemetry := &Telemetry{}
		svc, err := NewService(ServiceConfig{
			EmbeddingFunc:      fakeEmbeddingFunc(),
			BatchEmbedder:      embedder,
			EmbeddingBatchSize: 32,
			Telemetry:          telemetry,
		})
		if err != nil {
			b.Fatal(err)
		}
		svc.embeddingCache = newEmbeddingCache(root, "benchmark-fingerprint", 8, 1<<30, nil)
		svc.embeddingDimension = 8
		b.ReportAllocs()
		b.ResetTimer()
		for range b.N {
			if _, _, err := svc.resolveEmbeddingChunk(context.Background(), texts); err != nil {
				b.Fatal(err)
			}
		}
		b.StopTimer()
		snapshot := telemetry.Snapshot()
		b.ReportMetric(snapshot.EmbeddingCacheHitRatio(), "hit_ratio")
		b.ReportMetric(float64(embedder.inputs.Load())/float64(b.N), "embed_inputs/op")
		b.ReportMetric(float64(len(texts)*b.N)/b.Elapsed().Seconds(), "docs/s")
	})
}
