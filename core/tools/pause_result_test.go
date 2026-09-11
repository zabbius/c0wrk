package tools

import (
	"errors"
	"strings"
	"testing"
)

// TestBuildDelegateToolResult_Paused verifies a paused delegation surfaces as a
// distinct "paused" section (not a failure) with a FACTUAL status: the
// checkpoint exists and the system resumes the delegation automatically —
// no instruction is addressed to the model.
func TestBuildDelegateToolResult_Paused(t *testing.T) {
	res := buildDelegateToolResult([]DelegationResult{
		{ID: "del_1", Status: DelegationStatusPaused, Error: errors.New("paused")},
		{ID: "del_2", Status: DelegationStatusCompleted, Output: "ok"},
	})

	content := res.Content
	if !strings.Contains(content, "## Delegations paused") {
		t.Fatalf("expected a paused section, got:\n%s", content)
	}
	if !strings.Contains(content, "del_1") {
		t.Fatalf("expected paused delegation id in result, got:\n%s", content)
	}
	if !strings.Contains(content, "the system resumes it automatically") {
		t.Fatalf("expected the factual auto-resume note, got:\n%s", content)
	}
	if strings.Contains(content, "Re-invoke") {
		t.Fatalf("paused delegations must not carry model-facing resume instructions, got:\n%s", content)
	}
}

// TestBuildExecutePlanResult_Paused verifies a paused plan step is reported as
// paused (not failed) with a FACTUAL note: checkpointed steps continue
// automatically on resume — no instruction addressed to the model.
func TestBuildExecutePlanResult_Paused(t *testing.T) {
	res := buildExecutePlanResult([]PlanStepResult{
		{StepID: "step_1", Summary: "do a", Status: "completed", Output: "a"},
		{StepID: "step_2", Summary: "do b", Status: "paused", Error: errors.New("paused")},
	})

	content := res.Content
	if !strings.Contains(content, "paused") {
		t.Fatalf("expected paused status in result, got:\n%s", content)
	}
	if !strings.Contains(content, "[step_2] do b — paused") {
		t.Fatalf("expected step_2 rendered as paused, got:\n%s", content)
	}
	if !strings.Contains(content, "continues the plan automatically") {
		t.Fatalf("expected the factual auto-continue note, got:\n%s", content)
	}
	if strings.Contains(content, "Re-invoke") {
		t.Fatalf("paused plan steps must not carry model-facing resume instructions, got:\n%s", content)
	}
}
