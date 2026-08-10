package bridge

import (
	"testing"
	"time"
)

func TestJitterBufferOrdering(t *testing.T) {
	jb := NewJitterBuffer(2)

	// Push packets out of order.
	now := time.Now()
	jb.Push(&JitterPacket{SequenceNumber: 3, Payload: []byte{3}, ReceivedAt: now})
	jb.Push(&JitterPacket{SequenceNumber: 1, Payload: []byte{1}, ReceivedAt: now})
	jb.Push(&JitterPacket{SequenceNumber: 2, Payload: []byte{2}, ReceivedAt: now})

	// Pop should return packets in sequence order.
	pkt := jb.Pop()
	if pkt == nil || pkt.SequenceNumber != 1 {
		t.Fatalf("expected seq 1, got %v", pkt)
	}

	pkt = jb.Pop()
	if pkt == nil || pkt.SequenceNumber != 2 {
		t.Fatalf("expected seq 2, got %v", pkt)
	}

	pkt = jb.Pop()
	if pkt == nil || pkt.SequenceNumber != 3 {
		t.Fatalf("expected seq 3, got %v", pkt)
	}

	// Buffer should be empty now.
	pkt = jb.Pop()
	if pkt != nil {
		t.Fatalf("expected nil, got seq %d", pkt.SequenceNumber)
	}
}

func TestJitterBufferDepth(t *testing.T) {
	jb := NewJitterBuffer(3)

	now := time.Now()
	// Push only 2 packets (less than depth of 3).
	jb.Push(&JitterPacket{SequenceNumber: 1, Payload: []byte{1}, ReceivedAt: now})
	jb.Push(&JitterPacket{SequenceNumber: 2, Payload: []byte{2}, ReceivedAt: now})

	// Pop should return nil (buffer not full enough).
	pkt := jb.Pop()
	if pkt != nil {
		t.Fatalf("expected nil (buffer not full), got seq %d", pkt.SequenceNumber)
	}

	// Add a third packet to meet depth requirement.
	jb.Push(&JitterPacket{SequenceNumber: 3, Payload: []byte{3}, ReceivedAt: now})

	// Now Pop should work.
	pkt = jb.Pop()
	if pkt == nil || pkt.SequenceNumber != 1 {
		t.Fatalf("expected seq 1, got %v", pkt)
	}
}

func TestJitterBufferDuplicateDropped(t *testing.T) {
	jb := NewJitterBuffer(1)

	now := time.Now()
	jb.Push(&JitterPacket{SequenceNumber: 5, Payload: []byte{5}, ReceivedAt: now})
	jb.Push(&JitterPacket{SequenceNumber: 5, Payload: []byte{5}, ReceivedAt: now}) // duplicate

	// Should only have one packet.
	pkt := jb.Pop()
	if pkt == nil || pkt.SequenceNumber != 5 {
		t.Fatalf("expected seq 5, got %v", pkt)
	}

	pkt = jb.Pop()
	if pkt != nil {
		t.Fatalf("expected nil after single packet, got seq %d", pkt.SequenceNumber)
	}

	stats := jb.Stats()
	if stats.PacketsDropped != 1 {
		t.Errorf("expected 1 dropped packet, got %d", stats.PacketsDropped)
	}
}

func TestJitterBufferStalePacket(t *testing.T) {
	jb := NewJitterBuffer(1)

	now := time.Now()
	// Push and pop first packet.
	jb.Push(&JitterPacket{SequenceNumber: 10, Payload: []byte{10}, ReceivedAt: now})
	pkt := jb.Pop()
	if pkt == nil || pkt.SequenceNumber != 10 {
		t.Fatalf("expected seq 10, got %v", pkt)
	}

	// Now push a stale packet (seq < nextSeq which is now 11).
	jb.Push(&JitterPacket{SequenceNumber: 8, Payload: []byte{8}, ReceivedAt: now})

	// The stale packet should be dropped.
	stats := jb.Stats()
	if stats.PacketsDropped != 1 {
		t.Errorf("expected stale packet dropped, got drops=%d", stats.PacketsDropped)
	}
}

func TestJitterBufferWraparound(t *testing.T) {
	jb := NewJitterBuffer(2)

	now := time.Now()
	// Test sequence number wraparound (65534, 65535, 0, 1).
	jb.Push(&JitterPacket{SequenceNumber: 65535, Payload: []byte{0xFF}, ReceivedAt: now})
	jb.Push(&JitterPacket{SequenceNumber: 0, Payload: []byte{0x00}, ReceivedAt: now})
	jb.Push(&JitterPacket{SequenceNumber: 1, Payload: []byte{0x01}, ReceivedAt: now})

	pkt := jb.Pop()
	if pkt == nil || pkt.SequenceNumber != 65535 {
		t.Fatalf("expected seq 65535, got %v", pkt)
	}

	pkt = jb.Pop()
	if pkt == nil || pkt.SequenceNumber != 0 {
		t.Fatalf("expected seq 0 (wrap), got %v", pkt)
	}

	pkt = jb.Pop()
	if pkt == nil || pkt.SequenceNumber != 1 {
		t.Fatalf("expected seq 1, got %v", pkt)
	}
}

func TestJitterBufferReorderStats(t *testing.T) {
	jb := NewJitterBuffer(2)

	now := time.Now()
	// Push packets in reverse order.
	jb.Push(&JitterPacket{SequenceNumber: 5, Payload: []byte{5}, ReceivedAt: now})
	jb.Push(&JitterPacket{SequenceNumber: 3, Payload: []byte{3}, ReceivedAt: now})
	jb.Push(&JitterPacket{SequenceNumber: 4, Payload: []byte{4}, ReceivedAt: now})

	stats := jb.Stats()
	if stats.Reorders < 1 {
		t.Errorf("expected reorder count > 0, got %d", stats.Reorders)
	}
}

func TestJitterBufferReset(t *testing.T) {
	jb := NewJitterBuffer(1)

	now := time.Now()
	jb.Push(&JitterPacket{SequenceNumber: 1, Payload: []byte{1}, ReceivedAt: now})
	jb.Push(&JitterPacket{SequenceNumber: 2, Payload: []byte{2}, ReceivedAt: now})

	jb.Reset()

	if jb.Len() != 0 {
		t.Errorf("expected empty after reset, got len %d", jb.Len())
	}

	stats := jb.Stats()
	if stats.PacketsReceived != 0 {
		t.Errorf("expected zero stats after reset, got received=%d", stats.PacketsReceived)
	}
}

func TestSeqAfterBefore(t *testing.T) {
	tests := []struct {
		a, b   uint16
		after  bool
		before bool
	}{
		{1, 0, true, false},
		{0, 1, false, true},
		{100, 50, true, false},
		{0, 65535, true, false},       // 0 is "after" 65535 (wraparound)
		{65535, 0, false, true},       // 65535 is "before" 0 (wraparound)
		{32768, 0, false, true},       // exactly half range
		{5, 5, false, false},          // equal
	}

	for _, tc := range tests {
		if got := seqAfter(tc.a, tc.b); got != tc.after {
			t.Errorf("seqAfter(%d, %d) = %v, want %v", tc.a, tc.b, got, tc.after)
		}
		if got := seqBefore(tc.a, tc.b); got != tc.before {
			t.Errorf("seqBefore(%d, %d) = %v, want %v", tc.a, tc.b, got, tc.before)
		}
	}
}
