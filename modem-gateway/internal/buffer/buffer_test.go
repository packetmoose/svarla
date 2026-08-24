package buffer

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// testEntry is a simple struct used for testing the buffer.
type testEntry struct {
	ID      int    `json:"id"`
	Message string `json:"message"`
}

func tempFilePath(t *testing.T) string {
	t.Helper()
	return filepath.Join(t.TempDir(), "buffer.jsonl")
}

func TestNew_EmptyFile(t *testing.T) {
	path := tempFilePath(t)
	buf, err := New[testEntry](path, 10)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if buf.Len() != 0 {
		t.Fatalf("expected empty buffer, got %d items", buf.Len())
	}
}

func TestNew_InvalidCapacity(t *testing.T) {
	path := tempFilePath(t)
	_, err := New[testEntry](path, 0)
	if err == nil {
		t.Fatal("expected error for zero capacity")
	}
	_, err = New[testEntry](path, -1)
	if err == nil {
		t.Fatal("expected error for negative capacity")
	}
}

func TestPush_Basic(t *testing.T) {
	path := tempFilePath(t)
	buf, err := New[testEntry](path, 10)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	entry := testEntry{ID: 1, Message: "hello"}
	if err := buf.Push(entry); err != nil {
		t.Fatalf("push failed: %v", err)
	}

	if buf.Len() != 1 {
		t.Fatalf("expected 1 item, got %d", buf.Len())
	}

	// Verify file was written
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("failed to read file: %v", err)
	}

	var loaded testEntry
	if err := json.Unmarshal([]byte(strings.TrimSpace(string(data))), &loaded); err != nil {
		t.Fatalf("failed to unmarshal file contents: %v", err)
	}
	if loaded.ID != 1 || loaded.Message != "hello" {
		t.Fatalf("unexpected file contents: %+v", loaded)
	}
}

func TestPush_Eviction(t *testing.T) {
	path := tempFilePath(t)
	buf, err := New[testEntry](path, 3)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	for i := 1; i <= 5; i++ {
		if err := buf.Push(testEntry{ID: i, Message: "msg"}); err != nil {
			t.Fatalf("push %d failed: %v", i, err)
		}
	}

	if buf.Len() != 3 {
		t.Fatalf("expected 3 items after eviction, got %d", buf.Len())
	}

	items, err := buf.DrainAll()
	if err != nil {
		t.Fatalf("drain failed: %v", err)
	}

	// Should contain items 3, 4, 5 (oldest evicted)
	expectedIDs := []int{3, 4, 5}
	for i, item := range items {
		if item.ID != expectedIDs[i] {
			t.Errorf("item %d: expected ID %d, got %d", i, expectedIDs[i], item.ID)
		}
	}
}

func TestDrainAll_Empty(t *testing.T) {
	path := tempFilePath(t)
	buf, err := New[testEntry](path, 10)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	items, err := buf.DrainAll()
	if err != nil {
		t.Fatalf("drain failed: %v", err)
	}
	if items != nil {
		t.Fatalf("expected nil for empty drain, got %v", items)
	}
}

func TestDrainAll_ClearsBuffer(t *testing.T) {
	path := tempFilePath(t)
	buf, err := New[testEntry](path, 10)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	for i := 1; i <= 3; i++ {
		buf.Push(testEntry{ID: i, Message: "msg"})
	}

	items, err := buf.DrainAll()
	if err != nil {
		t.Fatalf("drain failed: %v", err)
	}
	if len(items) != 3 {
		t.Fatalf("expected 3 items, got %d", len(items))
	}

	if buf.Len() != 0 {
		t.Fatalf("expected empty buffer after drain, got %d", buf.Len())
	}

	// File should be empty
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("failed to read file: %v", err)
	}
	if len(data) != 0 {
		t.Fatalf("expected empty file after drain, got %d bytes", len(data))
	}
}

func TestDrainAll_FIFOOrder(t *testing.T) {
	path := tempFilePath(t)
	buf, err := New[testEntry](path, 10)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	for i := 1; i <= 5; i++ {
		buf.Push(testEntry{ID: i, Message: "msg"})
	}

	items, err := buf.DrainAll()
	if err != nil {
		t.Fatalf("drain failed: %v", err)
	}

	for i, item := range items {
		expected := i + 1
		if item.ID != expected {
			t.Errorf("item %d: expected ID %d, got %d", i, expected, item.ID)
		}
	}
}

func TestPersistence_AcrossReload(t *testing.T) {
	path := tempFilePath(t)

	// Create and populate buffer
	buf1, err := New[testEntry](path, 10)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	for i := 1; i <= 3; i++ {
		buf1.Push(testEntry{ID: i, Message: "persisted"})
	}

	// Create new buffer from same file (simulates restart)
	buf2, err := New[testEntry](path, 10)
	if err != nil {
		t.Fatalf("unexpected error on reload: %v", err)
	}

	if buf2.Len() != 3 {
		t.Fatalf("expected 3 items after reload, got %d", buf2.Len())
	}

	items, err := buf2.DrainAll()
	if err != nil {
		t.Fatalf("drain failed: %v", err)
	}

	for i, item := range items {
		expected := i + 1
		if item.ID != expected {
			t.Errorf("item %d: expected ID %d, got %d", i, expected, item.ID)
		}
		if item.Message != "persisted" {
			t.Errorf("item %d: expected message 'persisted', got %q", i, item.Message)
		}
	}
}

func TestPersistence_AfterEviction(t *testing.T) {
	path := tempFilePath(t)

	buf1, err := New[testEntry](path, 3)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Push 5 items into capacity-3 buffer
	for i := 1; i <= 5; i++ {
		buf1.Push(testEntry{ID: i, Message: "msg"})
	}

	// Reload and verify
	buf2, err := New[testEntry](path, 3)
	if err != nil {
		t.Fatalf("unexpected error on reload: %v", err)
	}

	if buf2.Len() != 3 {
		t.Fatalf("expected 3 items after reload, got %d", buf2.Len())
	}

	items, err := buf2.DrainAll()
	if err != nil {
		t.Fatalf("drain failed: %v", err)
	}

	expectedIDs := []int{3, 4, 5}
	for i, item := range items {
		if item.ID != expectedIDs[i] {
			t.Errorf("item %d: expected ID %d, got %d", i, expectedIDs[i], item.ID)
		}
	}
}

func TestMalformedLines_Skipped(t *testing.T) {
	path := tempFilePath(t)

	// Write some valid and invalid lines
	content := `{"id":1,"message":"good"}
not valid json
{"id":2,"message":"also good"}
{broken
{"id":3,"message":"fine"}
`
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatalf("failed to write test file: %v", err)
	}

	buf, err := New[testEntry](path, 10)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if buf.Len() != 3 {
		t.Fatalf("expected 3 valid items, got %d", buf.Len())
	}

	items, err := buf.DrainAll()
	if err != nil {
		t.Fatalf("drain failed: %v", err)
	}

	expectedIDs := []int{1, 2, 3}
	for i, item := range items {
		if item.ID != expectedIDs[i] {
			t.Errorf("item %d: expected ID %d, got %d", i, expectedIDs[i], item.ID)
		}
	}
}

func TestFlush_Rewrites(t *testing.T) {
	path := tempFilePath(t)

	buf, err := New[testEntry](path, 10)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	for i := 1; i <= 3; i++ {
		buf.Push(testEntry{ID: i, Message: "msg"})
	}

	// Flush should succeed and file should contain same data
	if err := buf.Flush(); err != nil {
		t.Fatalf("flush failed: %v", err)
	}

	// Reload to verify
	buf2, err := New[testEntry](path, 10)
	if err != nil {
		t.Fatalf("unexpected error on reload: %v", err)
	}

	if buf2.Len() != 3 {
		t.Fatalf("expected 3 items after flush+reload, got %d", buf2.Len())
	}
}

func TestConcurrentPush(t *testing.T) {
	path := tempFilePath(t)
	buf, err := New[testEntry](path, 100)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			buf.Push(testEntry{ID: id, Message: "concurrent"})
		}(i)
	}
	wg.Wait()

	if buf.Len() != 50 {
		t.Fatalf("expected 50 items after concurrent pushes, got %d", buf.Len())
	}
}

func TestCapacityTrim_OnLoad(t *testing.T) {
	path := tempFilePath(t)

	// Write more entries than capacity to the file (simulates external edits)
	var lines []string
	for i := 1; i <= 15; i++ {
		data, _ := json.Marshal(testEntry{ID: i, Message: "overflow"})
		lines = append(lines, string(data))
	}
	content := strings.Join(lines, "\n") + "\n"
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatalf("failed to write test file: %v", err)
	}

	// Load with capacity 10 — should keep only last 10
	buf, err := New[testEntry](path, 10)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if buf.Len() != 10 {
		t.Fatalf("expected 10 items (trimmed to capacity), got %d", buf.Len())
	}

	items, err := buf.DrainAll()
	if err != nil {
		t.Fatalf("drain failed: %v", err)
	}

	// Should keep items 6-15 (most recent)
	for i, item := range items {
		expected := i + 6
		if item.ID != expected {
			t.Errorf("item %d: expected ID %d, got %d", i, expected, item.ID)
		}
	}
}

func TestUnicode_Content(t *testing.T) {
	path := tempFilePath(t)
	buf, err := New[testEntry](path, 10)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	entry := testEntry{ID: 1, Message: "こんにちは 🌍 مرحبا"}
	if err := buf.Push(entry); err != nil {
		t.Fatalf("push failed: %v", err)
	}

	// Reload and verify
	buf2, err := New[testEntry](path, 10)
	if err != nil {
		t.Fatalf("unexpected error on reload: %v", err)
	}

	items, err := buf2.DrainAll()
	if err != nil {
		t.Fatalf("drain failed: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("expected 1 item, got %d", len(items))
	}
	if items[0].Message != "こんにちは 🌍 مرحبا" {
		t.Errorf("unicode content not preserved: got %q", items[0].Message)
	}
}
