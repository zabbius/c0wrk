package core

// Regression tests for review rev_c2b findings [1]-[4] (see
// specs/domains/review.md for the review-mode domain):
//   - [1] repeated failed resumes keep the stored history in the
//     [user:request, failed] shape dropFailedExchangeTail matches;
//   - [2]/[4-goal] a resumed goal task with a wave summary still resolves its
//     image content blocks from the conversation history, and the wave
//     summary does not leak into HandleResult.Output;
//   - [3]/[4-plan] the wave summary omits plan steps that were already
//     successful before the wave;
//   - [2-registry] the settled-delegation replay (registry.Register, no spec
//     sink) still resolves dependencies for relaunched paused delegates.

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/v0lka/c0wrk/core/goal"
	coretools "github.com/v0lka/c0wrk/core/tools"
	"github.com/v0lka/sp4rk/agent"
	"github.com/v0lka/sp4rk/llm"
	"github.com/v0lka/sp4rk/orchestration"
	sdktools "github.com/v0lka/sp4rk/tools"
)

// TestResume_RepeatedFailuresKeepFailedExchangeShape verifies finding [1]:
// every failed resume re-collapses the stored history to exactly one
// [user:request, failed] exchange, so dropFailedExchangeTail (the
// injection-time mirror used by the NEXT resume) keeps matching no matter how
// many times a resume fails. Regression: the failure branch used to append an
// assistant-only note, so from the second failed resume on the tail read
// [user:req, failed1, failed2, …] and never matched.
func TestResume_RepeatedFailuresKeepFailedExchangeShape(t *testing.T) {
	mockLLM := &mockLLMCaller{err: errors.New("conductor LLM unavailable")}
	o := newHistoryTestOrchestrator(mockLLM)

	// Simulate the restored history of a FAILED task: the user message plus
	// the recorded failure note (recordConversationOutcome's failure branch,
	// or the backend's identical reconstruction from the message store).
	o.SetConversationHistory([]llm.Message{
		{Role: "user", Content: "long running task"},
		{Role: "assistant", Content: HistoryNoteFailed("first attempt failed")},
	})
	bb := orchestration.NewMapBlackboard()
	bb.SetOriginalRequest("long running task")

	for attempt := 1; attempt <= 3; attempt++ {
		if _, err := o.Resume(context.Background(), bb, nil, "", nil, nil, ""); err == nil {
			t.Fatalf("failed resume %d: expected an error", attempt)
		}
		history := o.ConversationHistory()
		if len(history) != 2 {
			t.Fatalf("after failed resume %d: history has %d messages, want exactly 2 ([user, failed]): %+v", attempt, len(history), history)
		}
		if history[0].Role != "user" || history[0].Content != "long running task" {
			t.Fatalf("after failed resume %d: history[0] = %+v, want the original user request", attempt, history[0])
		}
		if history[1].Role != "assistant" || !strings.HasPrefix(history[1].Content, historyNoteFailedPrefix) {
			t.Fatalf("after failed resume %d: history[1] = %+v, want a failure note", attempt, history[1])
		}
	}

	// The next resume's injection-time mirror must match the tail exactly:
	// the failed exchange is dropped so the model never sees the same
	// request twice with stale failure markers in between.
	if dropped := dropFailedExchangeTail(o.ConversationHistory(), "long running task"); len(dropped) != 0 {
		t.Fatalf("dropFailedExchangeTail left %d messages, want the failed exchange dropped: %+v", len(dropped), dropped)
	}
}

// TestResume_FailedResumeAfterPauseKeepsLoneUserAnchored verifies the
// companion edge of finding [1]: when the restored history carries only the
// user message (a paused or crash-interrupted task whose outcome was never
// recorded), a failed resume records [user:request, failed] without
// duplicating the user message.
func TestResume_FailedResumeAfterPauseKeepsLoneUserAnchored(t *testing.T) {
	mockLLM := &mockLLMCaller{err: errors.New("conductor LLM unavailable")}
	o := newHistoryTestOrchestrator(mockLLM)

	o.SetConversationHistory([]llm.Message{
		{Role: "user", Content: "paused task"},
	})
	bb := orchestration.NewMapBlackboard()
	bb.SetOriginalRequest("paused task")

	if _, err := o.Resume(context.Background(), bb, nil, "", nil, nil, ""); err == nil {
		t.Fatal("expected the resumed task to fail")
	}

	history := o.ConversationHistory()
	if len(history) != 2 {
		t.Fatalf("history has %d messages, want exactly 2 ([user, failed]): %+v", len(history), history)
	}
	if history[0].Role != "user" || history[0].Content != "paused task" {
		t.Fatalf("history[0] = %+v, want the original user request (not duplicated)", history[0])
	}
	if history[1].Role != "assistant" || !strings.HasPrefix(history[1].Content, historyNoteFailedPrefix) {
		t.Fatalf("history[1] = %+v, want a failure note", history[1])
	}
	if dropped := dropFailedExchangeTail(history, "paused task"); len(dropped) != 0 {
		t.Fatalf("dropFailedExchangeTail left %d messages, want the failed exchange dropped", len(dropped))
	}
}

// goalTurnVisionRecorder is a goal-turn runner stand-in that records each
// turn's message and content blocks, then pauses the goal loop — so
// resumeGoalLoop's output falls back to the original request (no verdict
// reason exists), exactly the path that must not leak the wave summary.
type goalTurnVisionRecorder struct {
	mu       sync.Mutex
	messages []string
	blocks   [][]llm.ContentBlock
}

func (r *goalTurnVisionRecorder) run(
	_ context.Context,
	_ int,
	message string,
	_ orchestration.Blackboard,
	_ []sdktools.ToolDescriptor,
	_ string,
	_ []llm.Message,
	deps conductorDeps,
) (int, *orchestration.ExecutionResult, error) {
	r.mu.Lock()
	r.messages = append(r.messages, message)
	r.blocks = append(r.blocks, deps.contentBlocks)
	r.mu.Unlock()
	return 0, &orchestration.ExecutionResult{Status: orchestration.ExecutionStatusPaused}, nil
}

func (r *goalTurnVisionRecorder) snapshot() (messages []string, blocks [][]llm.ContentBlock) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.messages...), append([][]llm.ContentBlock(nil), r.blocks...)
}

// TestResumeWave_GoalLoopVisionBlocksWithWaveSummary verifies finding [4]
// (goal-loop half): a vision-bearing goal task that pauses with a paused
// delegate resumes through the wave — which appends its factual summary to
// the goal message — and the resumed goal turns still receive the image
// content blocks from the conversation history, and the summary does not
// leak into HandleResult.Output.
func TestResumeWave_GoalLoopVisionBlocksWithWaveSummary(t *testing.T) {
	caller := &pauseScriptLLM{script: []pauseScriptStep{
		// Wave (before the goal loop's first turn): del_1 finishes.
		{respond: executorFinishResponse("del_1 done")},
	}}

	emitter := &launchRecorder{}
	o := newWaveOrchestrator(t, caller, emitter, nil)
	recStore := &specRecordingStore{}
	o.SetTaskStore(recStore)
	recorder := &goalTurnVisionRecorder{}
	o.goalTurnRunner = recorder.run

	bb := newDelegSpecBB("task-goal-vision", recStore)
	bb.SetOriginalRequest("reach the goal")
	// A paused delegate checkpoint + its persisted spec: the wave settles it
	// and appends a summary, so the goal message is request + summary.
	bb.SetStepResult("del_1", "", agent.ErrPaused, nil)
	bb.specs = []coretools.DelegationSpec{{
		Task: coretools.DelegationTask{ID: "del_1", Summary: "s", Task: "do work"},
	}}

	// The restored history carries the ORIGINAL request with image content
	// blocks (what convertChatMessagesToLLM rebuilds for a vision task).
	o.SetConversationHistory([]llm.Message{{
		Role:    "user",
		Content: "reach the goal",
		ContentBlocks: []llm.ContentBlock{
			{Type: "text", Text: "reach the goal"},
			{Type: "image", ImageB64: "aGVsbG8=", MediaType: "image/png"},
		},
	}})

	gs := &goal.GoalState{Status: goal.StatusActive, Condition: "reach the goal"}
	plansDir := t.TempDir()
	ctx := WithComplexity(WithDomain(context.Background(), "general"), 1)

	res, err := o.Resume(ctx, bb, nil, plansDir, nil, gs, "")
	if err != nil {
		t.Fatalf("Resume: %v", err)
	}
	if res == nil {
		t.Fatal("Resume returned a nil result")
	}

	msgs, blocks := recorder.snapshot()
	if len(msgs) != 1 {
		t.Fatalf("goal turns run = %d, want 1", len(msgs))
	}
	// The turn message is intentionally augmented (request + wave data)…
	if !strings.Contains(msgs[0], "reach the goal") {
		t.Errorf("goal turn message lacks the original request: %q", msgs[0])
	}
	if !strings.Contains(msgs[0], "Auto-resumed subagents") {
		t.Errorf("goal turn message lacks the wave summary: %q", msgs[0])
	}
	// …but the image lookup must still resolve against the ORIGINAL request
	// (the history's user message never carries the summary).
	if len(blocks) != 1 || len(blocks[0]) == 0 {
		t.Fatalf("resumed goal turn received no content blocks — the image lookup missed (blocks=%v)", blocks)
	}
	hasImage := false
	for _, blk := range blocks[0] {
		if blk.Type == "image" {
			hasImage = true
		}
	}
	if !hasImage {
		t.Errorf("resumed goal turn content blocks carry no image block: %+v", blocks[0])
	}

	// The paused goal (no verdict reason) falls back to the clean original
	// request — the wave summary must not leak into the task output.
	if res.Output != "reach the goal" {
		t.Errorf("Resume output = %q, want the original request without the wave summary", res.Output)
	}
	if strings.Contains(res.Output, "Auto-resumed subagents") {
		t.Errorf("Resume output leaked the wave summary: %q", res.Output)
	}
}

// TestResumeWave_SummaryOmitsPreWaveSuccessfulSteps verifies finding [3]:
// plan steps that were already successful BEFORE the wave are replayed as
// skipped by the plan DAG engine and must not be re-listed in the wave
// summary — each resume used to grow the task message by one factually wrong
// "settled by the system" line per completed step.
func TestResumeWave_SummaryOmitsPreWaveSuccessfulSteps(t *testing.T) {
	caller := &pauseScriptLLM{script: []pauseScriptStep{
		// Wave: s2 runs (s1 is skipped — already successful).
		{respond: executorFinishResponse("s2 done")},
		// The resumed conductor's ONLY LLM call: finish.
		{respond: executorFinishResponse("all done")},
	}}

	emitter := &launchRecorder{}
	rec := &cmRecorder{}
	o := newWaveOrchestrator(t, caller, emitter, rec)
	recStore := &specRecordingStore{}
	o.SetTaskStore(recStore)

	bb := newDelegSpecBB("task-wave-skip-summary", recStore)
	bb.SetOriginalRequest("build the widget")
	bb.SetPlan(&orchestration.Plan{Steps: []orchestration.PlanStep{
		{ID: "s1", Summary: "Do the groundwork", Description: "What: groundwork\nHow: tools\nWhere: repo\nAcceptance Criteria: done"},
		{ID: "s2", Summary: "Wrap up", Description: "What: wrap\nHow: tools\nWhere: repo\nAcceptance Criteria: done", DependsOn: []string{"s1"}},
	}})
	// s1 succeeded in an earlier run; s2 never ran.
	bb.SetStepResult("s1", "s1 done", nil, nil)

	plansDir := t.TempDir()
	ctx := WithComplexity(WithDomain(context.Background(), "general"), 2)

	res, err := o.Resume(ctx, bb, nil, plansDir, nil, nil, "")
	if err != nil {
		t.Fatalf("Resume: %v", err)
	}
	if res.Status != orchestration.ExecutionStatusSuccess {
		t.Fatalf("Resume status = %q, want success", res.Status)
	}

	// The wave ran s2 to completion; s1 kept its earlier result.
	for _, step := range []struct{ id, want string }{{"s1", "s1 done"}, {"s2", "s2 done"}} {
		sr, ok := bb.GetStepResult(step.id)
		if !ok || sr.Error != nil || sr.FullOutput != step.want {
			t.Fatalf("%s after resume = %+v (ok=%v), want successful %q", step.id, sr, ok, step.want)
		}
	}

	// The conductor's task message lists ONLY the step the wave actually
	// settled (s2); the pre-wave-successful s1 is not re-listed.
	cms := rec.snapshot()
	if len(cms) == 0 {
		t.Fatal("no context managers recorded")
	}
	task := cms[len(cms)-1].taskDefinition
	if !strings.Contains(task, "build the widget") {
		t.Errorf("conductor task message lacks the original request: %q", task)
	}
	if !strings.Contains(task, "- s2:") {
		t.Errorf("conductor task message lacks the wave-settled s2 line: %q", task)
	}
	if strings.Contains(task, "- s1:") {
		t.Errorf("conductor task message re-lists the pre-wave-successful s1: %q", task)
	}

	if got := caller.consumed(); got != len(caller.script) {
		t.Errorf("script consumed %d/%d — the run deviated", got, len(caller.script))
	}
}

// TestResumeWave_SettledReplayResolvesDependencies verifies finding [2]
// (registry): the settled-delegation replay — which registers settled specs
// via registry.Register (no spec sink) and immediately completes them — still
// feeds dependency resolution, so a relaunched paused delegate whose
// dependency settled in the prior run launches instead of failing with
// "dependencies could not be satisfied". Settled delegations are never
// relaunched and never re-listed in the wave summary.
func TestResumeWave_SettledReplayResolvesDependencies(t *testing.T) {
	caller := &pauseScriptLLM{script: []pauseScriptStep{
		// Wave: the relaunched del_parent finishes (its dependency del_child
		// was settled in the prior run and replayed into the registry).
		{respond: executorFinishResponse("parent done")},
		// The resumed conductor's ONLY LLM call: finish.
		{respond: executorFinishResponse("all done")},
	}}

	emitter := &launchRecorder{}
	rec := &cmRecorder{}
	o := newWaveOrchestrator(t, caller, emitter, rec)
	recStore := &specRecordingStore{}
	o.SetTaskStore(recStore)

	bb := newDelegSpecBB("task-wave-settled", recStore)
	bb.SetOriginalRequest("delegate the work")
	// del_child settled (completed) in the prior run; del_parent paused with
	// a dependency on it.
	bb.SetStepResult("del_child", "child done", nil, nil)
	bb.SetStepResult("del_parent", "", agent.ErrPaused, nil)
	bb.specs = []coretools.DelegationSpec{
		{Task: coretools.DelegationTask{ID: "del_child", Summary: "child work", Task: "do child work"}},
		{Task: coretools.DelegationTask{ID: "del_parent", Summary: "parent work", Task: "do parent work", DependsOn: []string{"del_child"}}},
	}

	plansDir := t.TempDir()
	ctx := WithComplexity(WithDomain(context.Background(), "general"), 1)

	res, err := o.Resume(ctx, bb, nil, plansDir, nil, nil, "")
	if err != nil {
		t.Fatalf("Resume: %v", err)
	}
	if res.Status != orchestration.ExecutionStatusSuccess {
		t.Fatalf("Resume status = %q, want success", res.Status)
	}

	// The parent launched and completed — the replayed settled child
	// satisfied its dependency.
	sr, ok := bb.GetStepResult("del_parent")
	if !ok || sr.Error != nil || sr.FullOutput != "parent done" {
		t.Fatalf("del_parent after resume = %+v (ok=%v), want completed with output (dependency resolved via the settled replay)", sr, ok)
	}
	if n := emitter.launchCount("del_parent"); n != 1 {
		t.Errorf("SubAgentLaunch for del_parent = %d, want 1 (the wave relaunch)", n)
	}
	if n := emitter.launchCount("del_child"); n != 0 {
		t.Errorf("SubAgentLaunch for del_child = %d, want 0 (settled delegations are never relaunched)", n)
	}

	// The wave summary lists the relaunched parent only — the settled child
	// is replay data, not a settled-by-the-system outcome.
	cms := rec.snapshot()
	if len(cms) == 0 {
		t.Fatal("no context managers recorded")
	}
	task := cms[len(cms)-1].taskDefinition
	if !strings.Contains(task, "- del_parent:") {
		t.Errorf("conductor task message lacks the del_parent wave line: %q", task)
	}
	if strings.Contains(task, "- del_child:") {
		t.Errorf("conductor task message re-lists the settled del_child: %q", task)
	}

	if got := caller.consumed(); got != len(caller.script) {
		t.Errorf("script consumed %d/%d — the run deviated", got, len(caller.script))
	}
}
