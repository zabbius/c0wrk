package tools

import (
	"sync"
	"testing"
)

// TestRegisterTask_FiresSpecSink verifies RegisterTask registers the
// delegation AND fires the spec sink exactly once with the full persistable
// spec (task fields, defaulted mode, parent/depth stamps from the registry).
func TestRegisterTask_FiresSpecSink(t *testing.T) {
	r := NewDelegationRegistryWithDepth(1)

	var mu sync.Mutex
	var specs []DelegationSpec
	r.SetSpecSink("parent_1", func(spec DelegationSpec) {
		mu.Lock()
		specs = append(specs, spec)
		mu.Unlock()
	})

	task := DelegationTask{
		ID: "del_1", Summary: "s", Task: "do work",
		Tools: []string{"read-only"}, DependsOn: []string{"a"}, Agent: "reviewer",
	}
	if err := r.RegisterTask(task); err != nil {
		t.Fatalf("RegisterTask: %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(specs) != 1 {
		t.Fatalf("spec sink fired %d times, want 1", len(specs))
	}
	got := specs[0]
	if got.Task.ID != "del_1" || got.Task.Task != "do work" || got.Task.Agent != "reviewer" {
		t.Errorf("spec task = %+v, want the full registered task", got.Task)
	}
	if got.Task.Mode != "blocking" {
		t.Errorf("spec mode = %q, want defaulted \"blocking\"", got.Task.Mode)
	}
	if got.ParentID != "parent_1" {
		t.Errorf("spec parent = %q, want parent_1", got.ParentID)
	}
	if got.Depth != 1 {
		t.Errorf("spec depth = %d, want 1 (registry depth)", got.Depth)
	}

	// The registry entry itself must exist and be pending.
	d := r.Get("del_1")
	if d == nil || d.Status != DelegationStatusPending {
		t.Fatalf("registry entry after RegisterTask = %+v, want pending", d)
	}
}

// TestRegisterTask_DuplicateRejected mirrors Register's duplicate-ID guard.
func TestRegisterTask_DuplicateRejected(t *testing.T) {
	r := NewDelegationRegistry()
	if err := r.RegisterTask(DelegationTask{ID: "del_1", Summary: "s", Task: "t"}); err != nil {
		t.Fatalf("first RegisterTask: %v", err)
	}
	if err := r.RegisterTask(DelegationTask{ID: "del_1", Summary: "s", Task: "t"}); err == nil {
		t.Fatal("expected error for duplicate ID")
	}
}

// TestSetSpecSink_NilSinkNoop verifies RegisterTask works without a sink.
func TestSetSpecSink_NilSinkNoop(t *testing.T) {
	r := NewDelegationRegistry()
	if err := r.RegisterTask(DelegationTask{ID: "del_1", Summary: "s", Task: "t"}); err != nil {
		t.Fatalf("RegisterTask without sink: %v", err)
	}
}
