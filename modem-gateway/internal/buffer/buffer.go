// Package buffer provides a disk-persisted ring buffer for storing SMS
// notifications and missed calls during signaling WebSocket disconnections.
package buffer

import (
	"bufio"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"sync"
)

// DefaultCapacity is the maximum number of entries the buffer holds.
const DefaultCapacity = 1000

// PersistentBuffer is a generic disk-persisted ring buffer that stores items
// as JSON Lines. It evicts the oldest entry when capacity is reached (FIFO).
// All operations are thread-safe.
type PersistentBuffer[T any] struct {
	mu       sync.Mutex
	items    []T
	path     string
	capacity int
}

// New creates a new PersistentBuffer backed by the file at path.
// If the file exists, its contents are loaded into memory. Malformed lines
// are skipped with a warning logged to stderr. If the file does not exist,
// an empty buffer is created (the file is written on first Push).
func New[T any](path string, capacity int) (*PersistentBuffer[T], error) {
	if capacity <= 0 {
		return nil, fmt.Errorf("buffer: capacity must be positive, got %d", capacity)
	}

	buf := &PersistentBuffer[T]{
		path:     path,
		capacity: capacity,
		items:    make([]T, 0),
	}

	if err := buf.loadFromDisk(); err != nil {
		return nil, err
	}

	return buf, nil
}

// Push adds an item to the buffer. If the buffer is at capacity, the oldest
// entry is evicted first. The buffer is flushed to disk after every push.
// If no eviction occurred, only the new line is appended; otherwise the
// entire file is rewritten.
func (b *PersistentBuffer[T]) Push(item T) error {
	b.mu.Lock()
	defer b.mu.Unlock()

	evicted := false
	if len(b.items) >= b.capacity {
		// Evict oldest (index 0)
		b.items = b.items[1:]
		evicted = true
	}

	b.items = append(b.items, item)

	if evicted {
		return b.rewriteFile()
	}
	return b.appendLine(item)
}

// DrainAll returns all buffered entries in chronological order (oldest first)
// and clears the buffer. The backing file is truncated to empty.
func (b *PersistentBuffer[T]) DrainAll() ([]T, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	if len(b.items) == 0 {
		return nil, nil
	}

	// Copy items out
	result := make([]T, len(b.items))
	copy(result, b.items)

	// Clear in-memory buffer
	b.items = b.items[:0]

	// Truncate file
	if err := os.WriteFile(b.path, nil, 0644); err != nil {
		// Restore items on failure so we don't lose data
		b.items = result
		return nil, fmt.Errorf("buffer: failed to truncate file: %w", err)
	}

	return result, nil
}

// Len returns the current number of entries in the buffer.
func (b *PersistentBuffer[T]) Len() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.items)
}

// Flush rewrites the entire backing file from the current in-memory state.
func (b *PersistentBuffer[T]) Flush() error {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.rewriteFile()
}

// loadFromDisk reads the backing file and populates the in-memory buffer.
// If the file does not exist, the buffer remains empty. Malformed JSON lines
// are skipped with a warning logged.
func (b *PersistentBuffer[T]) loadFromDisk() error {
	f, err := os.Open(b.path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("buffer: failed to open file: %w", err)
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	lineNum := 0
	for scanner.Scan() {
		lineNum++
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}

		var item T
		if err := json.Unmarshal(line, &item); err != nil {
			log.Printf("buffer: skipping malformed line %d in %s: %v", lineNum, b.path, err)
			continue
		}
		b.items = append(b.items, item)
	}

	if err := scanner.Err(); err != nil {
		return fmt.Errorf("buffer: error reading file: %w", err)
	}

	// If file had more entries than capacity (e.g., manual edits), trim to capacity
	if len(b.items) > b.capacity {
		b.items = b.items[len(b.items)-b.capacity:]
	}

	return nil
}

// appendLine appends a single JSON-encoded item as a new line to the file.
func (b *PersistentBuffer[T]) appendLine(item T) error {
	f, err := os.OpenFile(b.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		return fmt.Errorf("buffer: failed to open file for append: %w", err)
	}
	defer f.Close()

	data, err := json.Marshal(item)
	if err != nil {
		return fmt.Errorf("buffer: failed to marshal item: %w", err)
	}

	data = append(data, '\n')
	if _, err := f.Write(data); err != nil {
		return fmt.Errorf("buffer: failed to write to file: %w", err)
	}

	return f.Sync()
}

// rewriteFile writes the entire in-memory buffer to disk, replacing the file
// contents. It writes to a temp file first, then renames for atomicity.
func (b *PersistentBuffer[T]) rewriteFile() error {
	tmpPath := b.path + ".tmp"
	f, err := os.OpenFile(tmpPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0644)
	if err != nil {
		return fmt.Errorf("buffer: failed to create temp file: %w", err)
	}

	writer := bufio.NewWriter(f)
	for _, item := range b.items {
		data, err := json.Marshal(item)
		if err != nil {
			f.Close()
			os.Remove(tmpPath)
			return fmt.Errorf("buffer: failed to marshal item: %w", err)
		}
		data = append(data, '\n')
		if _, err := writer.Write(data); err != nil {
			f.Close()
			os.Remove(tmpPath)
			return fmt.Errorf("buffer: failed to write to temp file: %w", err)
		}
	}

	if err := writer.Flush(); err != nil {
		f.Close()
		os.Remove(tmpPath)
		return fmt.Errorf("buffer: failed to flush temp file: %w", err)
	}

	if err := f.Sync(); err != nil {
		f.Close()
		os.Remove(tmpPath)
		return fmt.Errorf("buffer: failed to sync temp file: %w", err)
	}

	if err := f.Close(); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("buffer: failed to close temp file: %w", err)
	}

	if err := os.Rename(tmpPath, b.path); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("buffer: failed to rename temp file: %w", err)
	}

	return nil
}
