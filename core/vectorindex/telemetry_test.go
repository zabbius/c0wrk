package vectorindex

import (
	"sync"
	"testing"
	"time"
)

func TestTelemetrySnapshotAggregatesBoundedMetrics(t *testing.T) {
	t.Parallel()
	telemetry := &Telemetry{}
	telemetry.observe(StageWalkValidation, 10, time.Millisecond)
	telemetry.observe(StageReadHashChunk, 20, 2*time.Millisecond)
	telemetry.observe(StageCacheLookup, 10, time.Millisecond)
	telemetry.observe(StageEmbedding, 20, 3*time.Millisecond)
	telemetry.observe(StageChromemCommit, 20, 4*time.Millisecond)
	telemetry.observe(StageBleveUpsert, 20, 5*time.Millisecond)
	telemetry.observeBatch(40, 50)

	s := telemetry.Snapshot()
	if got, want := len(s.Stages), 6; got != want {
		t.Fatalf("stage cardinality = %d, want %d", got, want)
	}
	allowed := map[TelemetryStage]bool{
		StageWalkValidation: true, StageReadHashChunk: true,
		StageCacheLookup: true, StageEmbedding: true,
		StageChromemCommit: true, StageBleveUpsert: true,
	}
	for stage := range s.Stages {
		if !allowed[stage] {
			t.Fatalf("unexpected free-form stage %q", stage)
		}
	}
	if got := s.BatchFill(); got != 0.8 {
		t.Fatalf("BatchFill = %v, want 0.8", got)
	}
	if got := s.Stages[StageEmbedding].Items; got != 20 {
		t.Fatalf("embedding items = %d, want 20", got)
	}
}

func TestTelemetryConcurrentPrepObservation(t *testing.T) {
	t.Parallel()
	telemetry := &Telemetry{}
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range 100 {
				telemetry.observe(StageReadHashChunk, 1, time.Microsecond)
				_ = telemetry.Snapshot()
			}
		}()
	}
	wg.Wait()
	if got := telemetry.Snapshot().Stages[StageReadHashChunk].Items; got != 800 {
		t.Fatalf("prep items = %d, want 800", got)
	}
	telemetry.Reset()
	if got := len(telemetry.Snapshot().Stages); got != 0 {
		t.Fatalf("stages after Reset = %d, want 0", got)
	}
}
