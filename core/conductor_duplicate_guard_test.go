package core

// Tests for the delegate duplicate guard in the delegate TOOL (before
// registration): a task id that already carries a successful StepResult on
// the blackboard (settled by the auto-resume wave before the run started, or
// completed in a prior leg) is refused with a factual error instead of
// silently re-running as a fresh subagent — while co-launched dependents
// still resolve through the replayed registry entry. Because the guard runs
// BEFORE RegisterTask, a refusal never re-fires the spec sink and the
// persisted created_at ordering stays stable.

import (
	"context"
	"encoding/json"
	"strings"
	"sync/atomic"
	"testing"

	coretools "github.com/v0lka/c0wrk/core/tools"
	"github.com/v0lka/sp4rk/llm"
	"github.com/v0lka/sp4rk/orchestration"
)

// guardTestCaller answers every LLM call with a no-tool-call finish response,
// so a launched subagent completes immediately.
type guardTestCaller struct {
	calls atomic.Int32
}

func (c *guardTestCaller) Call(_ context.Context, _ llm.ChatRequest) (*llm.ChatResponse, error) {
	c.calls.Add(1)
	return &llm.ChatResponse{
		Message:    llm.Message{Role: "assistant", Content: "dependent done"},
		StopReason: "end_turn",
	}, nil
}

// newGuardLauncher builds a conductorLauncher over bb whose context factory
// records every invocation (each invocation means a subagent was built).
func newGuardLauncher(bb orchestration.Blackboard, caller *guardTestCaller, factoryCalls *atomic.Int32) *conductorLauncher {
	return &conductorLauncher{
		deps: conductorDeps{
			llm:          caller,
			tokenCounter: llm.NewSimpleTokenCounter(),
			contextFactory: func(_ string, _ llm.ModelMetadata, _ string, _ ...orchestration.PruningOverride) ContextManager {
				factoryCalls.Add(1)
				return &mockContextManager{}
			},
		},
		bb: bb,
	}
}

// runDelegateTool invokes the delegate tool with the given tasks payload and
// returns its result content.
func runDelegateTool(t *testing.T, launcher *conductorLauncher, registry *coretools.DelegationRegistry, payload string) string {
	t.Helper()
	ctx := coretools.WithDelegationRegistry(WithComplexity(context.Background(), 2), registry)
	ctx = coretools.WithDelegationLauncher(ctx, launcher)
	res, err := coretools.NewDelegateTool().Execute(ctx, json.RawMessage(payload))
	if err != nil {
		t.Fatalf("delegate tool Execute: %v", err)
	}
	return res.Content
}

// TestDelegate_DuplicateGuard_RefusesSettledDelegation: bb has a successful
// StepResult for del_1 → the tool refuses the re-delegation factually and
// never builds a subagent (context factory untouched, no LLM call).
func TestDelegate_DuplicateGuard_RefusesSettledDelegation(t *testing.T) {
	bb := orchestration.NewMapBlackboard()
	bb.SetStepResult("del_1", "already done output", nil, nil)

	var factoryCalls atomic.Int32
	caller := &guardTestCaller{}
	launcher := newGuardLauncher(bb, caller, &factoryCalls)

	registry := coretools.NewDelegationRegistry()
	content := runDelegateTool(t, launcher, registry, `{"tasks":[{"id":"del_1","summary":"s","task":"redo the work"}]}`)

	if !strings.Contains(content, "already completed") || !strings.Contains(content, "read_step_output") {
		t.Errorf("refusal should point at the existing output and read_step_output, got: %s", content)
	}
	if !strings.Contains(content, "del_1") {
		t.Errorf("refusal should name the settled delegation, got: %s", content)
	}
	if n := factoryCalls.Load(); n != 0 {
		t.Errorf("context factory called %d times, want 0 (no subagent may be built for a settled id)", n)
	}
	if n := caller.calls.Load(); n != 0 {
		t.Errorf("LLM called %d times, want 0 (no subagent may run for a settled id)", n)
	}

	// The registry entry is settled (completed), so co-launched dependents in
	// a follow-up call would resolve normally.
	if !registry.IsCompleted("del_1") {
		t.Error("the settled delegation must be replayed as completed in the registry")
	}
}

// TestDelegate_DuplicateGuard_DependantStillRuns: a co-launched dependent of
// a settled delegation resolves through the replayed registry entry — the
// guard must not cascade "dependencies could not be satisfied" onto it. The
// dependent itself launches (subagent built) and completes.
func TestDelegate_DuplicateGuard_DependantStillRuns(t *testing.T) {
	bb := orchestration.NewMapBlackboard()
	bb.SetStepResult("del_1", "already done output", nil, nil)

	var factoryCalls atomic.Int32
	caller := &guardTestCaller{}
	launcher := newGuardLauncher(bb, caller, &factoryCalls)

	registry := coretools.NewDelegationRegistry()
	content := runDelegateTool(t, launcher, registry, `{"tasks":[
		{"id":"del_1","summary":"s","task":"redo"},
		{"id":"del_2","summary":"s","task":"fresh dependent work","depends_on":["del_1"]}]}`)

	if !strings.Contains(content, "already completed") {
		t.Errorf("del_1 refusal missing from the tool result: %s", content)
	}
	if !strings.Contains(content, "dependent done") {
		t.Errorf("del_2 output missing from the tool result (dependent must still run): %s", content)
	}
	if strings.Contains(content, "dependencies could not be satisfied") {
		t.Errorf("the guard must not cascade onto dependents: %s", content)
	}
	if n := factoryCalls.Load(); n != 1 {
		t.Errorf("context factory called %d times, want exactly 1 (only del_2's subagent)", n)
	}
	if n := caller.calls.Load(); n != 1 {
		t.Errorf("LLM called %d times, want exactly 1 (only del_2's subagent)", n)
	}
}
