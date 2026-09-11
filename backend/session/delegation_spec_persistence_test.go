package session

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/v0lka/c0wrk/core/tools"
)

// TestSaveAndLoadDelegationSpecs round-trips delegation specs through the
// SQLite store: save two, replace one, load back, and verify fields.
func TestSaveAndLoadDelegationSpecs(t *testing.T) {
	store, sessionID, cleanup := setupTestStoreWithSession(t)
	defer cleanup()

	if err := store.SaveTask(context.Background(), TaskRecord{
		ID: "task-del", SessionID: sessionID, OriginalRequest: "req", Status: "in_progress", CreatedAt: time.Now(),
	}); err != nil {
		t.Fatalf("SaveTask: %v", err)
	}

	spec := tools.DelegationSpec{
		Task: tools.DelegationTask{
			ID: "del_1", Summary: "sum", Task: "do work",
			Tools: []string{"read-only", "execute"}, DependsOn: []string{"del_0"},
			Mode: "async", MaxSteps: 7, AllowRedelegate: true, Agent: "reviewer",
		},
		ParentID: "step_2",
		Depth:    2,
	}
	data, err := json.Marshal(spec)
	if err != nil {
		t.Fatalf("marshal spec: %v", err)
	}
	if err := store.SaveDelegationSpec(context.Background(), "task-del", TaskDelegationRecord{
		DelegationID: "del_1", TaskID: "task-del", ParentID: spec.ParentID,
		Depth: spec.Depth, Spec: data, CreatedAt: time.Now(),
	}); err != nil {
		t.Fatalf("SaveDelegationSpec: %v", err)
	}

	// Second spec for the same task.
	if err := store.SaveDelegationSpec(context.Background(), "task-del", TaskDelegationRecord{
		DelegationID: "del_2", TaskID: "task-del", Spec: json.RawMessage(`{"task":{"id":"del_2","summary":"s","task":"t"}}`), CreatedAt: time.Now(),
	}); err != nil {
		t.Fatalf("SaveDelegationSpec (del_2): %v", err)
	}

	recs, err := store.LoadDelegationSpecs(context.Background(), "task-del")
	if err != nil {
		t.Fatalf("LoadDelegationSpecs: %v", err)
	}
	if len(recs) != 2 {
		t.Fatalf("loaded %d records, want 2", len(recs))
	}

	// Replace del_1 (upsert semantics).
	replaced := spec
	replaced.Task.Summary = "updated"
	rdata, _ := json.Marshal(replaced)
	if err := store.SaveDelegationSpec(context.Background(), "task-del", TaskDelegationRecord{
		DelegationID: "del_1", TaskID: "task-del", ParentID: replaced.ParentID,
		Depth: replaced.Depth, Spec: rdata, CreatedAt: time.Now(),
	}); err != nil {
		t.Fatalf("SaveDelegationSpec (replace): %v", err)
	}
	recs, err = store.LoadDelegationSpecs(context.Background(), "task-del")
	if err != nil {
		t.Fatalf("LoadDelegationSpecs (replace): %v", err)
	}
	if len(recs) != 2 {
		t.Fatalf("after replace loaded %d records, want 2 (upsert, not insert)", len(recs))
	}

	// Verify the adapter-level round-trip: TaskStoreAdapter unmarshals specs.
	adapter := NewTaskStoreAdapter(store)
	specs, err := adapter.LoadDelegationSpecs("task-del")
	if err != nil {
		t.Fatalf("adapter LoadDelegationSpecs: %v", err)
	}
	if len(specs) != 2 {
		t.Fatalf("adapter loaded %d specs, want 2", len(specs))
	}
	var found bool
	for _, s := range specs {
		if s.Task.ID == "del_1" {
			found = true
			if s.Task.Summary != "updated" || s.ParentID != "step_2" || s.Depth != 2 || s.Task.Agent != "reviewer" {
				t.Errorf("del_1 spec round-trip = %+v, want full fidelity", s)
			}
		}
	}
	if !found {
		t.Fatal("del_1 spec missing after round-trip")
	}

	// Missing task → nil, nil.
	if specs, err := adapter.LoadDelegationSpecs("missing-task"); err != nil || specs != nil {
		t.Fatalf("LoadDelegationSpecs(missing) = %v, %v; want nil, nil", specs, err)
	}
}

// TestTaskDelegationSpecs_CascadeOnTaskDelete verifies delegation specs are
// removed with their task (ON DELETE CASCADE).
func TestTaskDelegationSpecs_CascadeOnTaskDelete(t *testing.T) {
	store, sessionID, cleanup := setupTestStoreWithSession(t)
	defer cleanup()

	if err := store.SaveTask(context.Background(), TaskRecord{
		ID: "task-casc", SessionID: sessionID, OriginalRequest: "req", Status: "in_progress", CreatedAt: time.Now(),
	}); err != nil {
		t.Fatalf("SaveTask: %v", err)
	}
	if err := store.SaveDelegationSpec(context.Background(), "task-casc", TaskDelegationRecord{
		DelegationID: "del_1", TaskID: "task-casc", Spec: json.RawMessage(`{"task":{"id":"del_1"}}`), CreatedAt: time.Now(),
	}); err != nil {
		t.Fatalf("SaveDelegationSpec: %v", err)
	}
	if err := store.DeleteSession(context.Background(), sessionID); err != nil {
		t.Fatalf("DeleteSession: %v", err)
	}
	recs, err := store.LoadDelegationSpecs(context.Background(), "task-casc")
	if err != nil {
		t.Fatalf("LoadDelegationSpecs after cascade: %v", err)
	}
	if len(recs) != 0 {
		t.Fatalf("expected 0 records after cascade, got %d", len(recs))
	}
}

// TestRestoreBlackboard_DelegationSpecs verifies the restored blackboard
// exposes persisted delegation specs via core.DelegationSpecReader.
func TestRestoreBlackboard_DelegationSpecs(t *testing.T) {
	store, sessionID, cleanup := setupTestStoreWithSession(t)
	defer cleanup()

	if err := store.SaveTask(context.Background(), TaskRecord{
		ID: "task-restore", SessionID: sessionID, OriginalRequest: "req", Status: "paused", CreatedAt: time.Now(),
	}); err != nil {
		t.Fatalf("SaveTask: %v", err)
	}
	spec := tools.DelegationSpec{Task: tools.DelegationTask{ID: "del_1", Summary: "s", Task: "do work"}}
	data, _ := json.Marshal(spec)
	if err := store.SaveDelegationSpec(context.Background(), "task-restore", TaskDelegationRecord{
		DelegationID: "del_1", TaskID: "task-restore", Spec: data, CreatedAt: time.Now(),
	}); err != nil {
		t.Fatalf("SaveDelegationSpec: %v", err)
	}

	adapter := NewTaskStoreAdapter(store)
	pb, err := RestoreBlackboard("task-restore", sessionID, adapter, nil)
	if err != nil || pb == nil {
		t.Fatalf("RestoreBlackboard: %v, %v", pb, err)
	}
	reader, ok := interface{}(pb).(interface{ DelegationSpecs() []tools.DelegationSpec })
	if !ok {
		t.Fatal("restored blackboard does not implement DelegationSpecReader")
	}
	specs := reader.DelegationSpecs()
	if len(specs) != 1 || specs[0].Task.ID != "del_1" || specs[0].Task.Task != "do work" {
		t.Fatalf("DelegationSpecs() = %+v, want the persisted del_1 spec", specs)
	}
}
