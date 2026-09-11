package core

// Conductor-level test for delegation-spec persistence: a delegate call made
// inside a real RunConductor run persists the full DelegationSpec into the
// task store (via the registry spec sink wired by RunConductor), so a paused
// delegation survives the end of the run and can be rebuilt by the Resume
// auto-resume wave.

import (
	"context"
	"encoding/json"
	"sync"
	"testing"

	coretools "github.com/v0lka/c0wrk/core/tools"
	"github.com/v0lka/sp4rk/llm"
	"github.com/v0lka/sp4rk/orchestration"
	"github.com/v0lka/sp4rk/tools"
)

// specRecordingStore records PersistDelegationSpec calls on top of the base
// TaskPersistence mock.
type specRecordingStore struct {
	mockTaskStoreWithReactivate
	mu    sync.Mutex
	specs []coretools.DelegationSpec
}

func (s *specRecordingStore) PersistDelegationSpec(taskID string, spec coretools.DelegationSpec) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.specs = append(s.specs, spec)
	return nil
}

func (s *specRecordingStore) recorded() []coretools.DelegationSpec {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]coretools.DelegationSpec(nil), s.specs...)
}

// TestRunConductor_DelegateCallPersistsSpec drives a full RunConductor with a
// scripted LLM that (1) delegates del_1, (2) the subagent finishes, (3) the
// conductor finishes — and asserts the spec for del_1 was persisted with
// root-registry stamps (ParentID "", Depth 0).
func TestRunConductor_DelegateCallPersistsSpec(t *testing.T) {
	caller := &mockLLMCaller{responses: []*llm.ChatResponse{
		// Conductor turn 1: delegate del_1 (blocking).
		{
			Message: llm.Message{
				Role:    "assistant",
				Content: "delegating",
				ToolCalls: []llm.ToolCall{{ID: "c1", Name: "delegate", Input: json.RawMessage(
					`{"tasks":[{"id":"del_1","summary":"do the thing","task":"do the thing carefully"}]}`)}},
			},
			StopReason: "tool_use",
		},
		// Subagent del_1's only LLM call: finish with an answer.
		executorFinishResponse("subagent done"),
		// Conductor turn 2: finish.
		executorFinishResponse("all done"),
	}}

	recStore := &specRecordingStore{}
	emitter := &mockEmitter{}
	o := NewOrchestrator(OrchestratorConfig{}, OrchestratorDeps{
		LLM:            caller,
		ToolExec:       createTestRegistryWithDelegate(t),
		ToolRegistry:   createTestRegistryWithDelegate(t),
		TokenCounter:   llm.NewSimpleTokenCounter(),
		ContextFactory: testContextFactory,
		Emitter:        emitter,
		CircuitBreaker: defaultCircuitBreakerConfig,
	})
	o.SetTaskStore(recStore)

	bb := &testPersistableBlackboard{
		MapBlackboard: orchestration.NewMapBlackboard(),
		taskID:        "task-spec-1",
		store:         recStore,
	}
	availableTools := createTestRegistryWithDelegate(t).ListFiltered(nil)
	ctx := WithComplexity(WithDomain(context.Background(), "general"), 1)

	if _, err := o.runConductor(ctx, "please delegate the thing", bb, availableTools, t.TempDir(), nil, nil, nil, "", "", false); err != nil {
		t.Fatalf("runConductor: %v", err)
	}

	specs := recStore.recorded()
	if len(specs) != 1 {
		t.Fatalf("persisted %d delegation specs, want exactly 1 (del_1)", len(specs))
	}
	got := specs[0]
	if got.Task.ID != "del_1" || got.Task.Task != "do the thing carefully" || got.Task.Summary != "do the thing" {
		t.Errorf("spec task = %+v, want the full registered delegation task", got.Task)
	}
	if got.ParentID != "" || got.Depth != 0 {
		t.Errorf("root-registry spec stamps = (parent %q, depth %d), want (\"\", 0)", got.ParentID, got.Depth)
	}

	// The delegation itself must have completed on the blackboard.
	sr, ok := bb.GetStepResult("del_1")
	if !ok || sr.Error != nil {
		t.Fatalf("del_1 StepResult = %+v (ok=%v), want completed without error", sr, ok)
	}
}

// createTestRegistryWithDelegate builds the plain test registry plus the real
// DelegateTool (its launcher/registry context handles are injected by
// RunConductor itself).
func createTestRegistryWithDelegate(t *testing.T) *tools.ToolRegistry {
	t.Helper()
	reg := createTestRegistry()
	reg.Register(coretools.NewDelegateTool())
	return reg
}
