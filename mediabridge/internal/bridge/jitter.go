package bridge

import (
	"sync"
	"time"
)

// JitterBuffer reorders incoming RTP packets from the SIP leg and smooths
// playback timing. It uses a simple fixed-size buffer that holds packets
// until their playout time, reordering out-of-sequence packets.
//
// Design goals:
//   - Reorder packets that arrive out of sequence
//   - Smooth playback timing by adding a small fixed delay
//   - Keep latency minimal (target: 1-2 frames / 20-40ms)
//   - Drop packets that are too late (beyond buffer window)

const (
	// DefaultJitterDepth is the number of frames to buffer before playout.
	// At 20ms per frame, depth=2 means 40ms of buffering.
	DefaultJitterDepth = 2

	// MaxJitterDepth is the maximum allowed buffer depth.
	MaxJitterDepth = 10

	// MaxSequenceGap is the maximum acceptable gap in sequence numbers.
	// Packets outside this range are considered stale and dropped.
	MaxSequenceGap = 50
)

// JitterPacket represents a single audio frame with sequence information.
type JitterPacket struct {
	// SequenceNumber is the RTP sequence number.
	SequenceNumber uint16

	// Timestamp is the RTP timestamp.
	Timestamp uint32

	// Payload is the audio data (G.711 µ-law bytes or decoded PCM).
	Payload []byte

	// ReceivedAt is when the packet was received (for timing).
	ReceivedAt time.Time
}

// JitterBuffer provides packet reordering and playout smoothing.
type JitterBuffer struct {
	mu    sync.Mutex
	depth int // number of frames to buffer

	// packets holds buffered packets sorted by sequence number.
	packets []*JitterPacket

	// nextSeq is the next expected sequence number for playout.
	nextSeq uint16

	// initialized tracks whether we've received the first packet.
	initialized bool

	// playing tracks whether playout has started (after initial fill).
	playing bool

	// stats for monitoring.
	stats JitterStats
}

// JitterStats tracks buffer performance metrics.
type JitterStats struct {
	PacketsReceived int64
	PacketsDropped  int64 // late or duplicate
	PacketsPlayed   int64
	Reorders        int64 // out-of-order arrivals that were corrected
}

// NewJitterBuffer creates a jitter buffer with the specified depth.
// Depth is the number of 20ms frames to buffer before starting playout.
func NewJitterBuffer(depth int) *JitterBuffer {
	if depth < 1 {
		depth = 1
	}
	if depth > MaxJitterDepth {
		depth = MaxJitterDepth
	}
	return &JitterBuffer{
		depth:   depth,
		packets: make([]*JitterPacket, 0, depth*2),
	}
}

// Push adds a packet to the jitter buffer.
// Packets may arrive out of order; the buffer sorts them by sequence number.
func (jb *JitterBuffer) Push(pkt *JitterPacket) {
	jb.mu.Lock()
	defer jb.mu.Unlock()

	jb.stats.PacketsReceived++

	if !jb.initialized {
		jb.initialized = true
		// Don't set nextSeq until first Pop — we don't know the actual order yet.
	}

	// Check if packet is too old (already played).
	if jb.playing && jb.isStale(pkt.SequenceNumber) {
		jb.stats.PacketsDropped++
		return
	}

	// Check for duplicates.
	for _, existing := range jb.packets {
		if existing.SequenceNumber == pkt.SequenceNumber {
			jb.stats.PacketsDropped++
			return
		}
	}

	// Insert in sequence order.
	inserted := false
	for i, existing := range jb.packets {
		if seqAfter(pkt.SequenceNumber, existing.SequenceNumber) {
			continue
		}
		// Insert before this position — this means the packet arrived out of order.
		jb.packets = append(jb.packets, nil)
		copy(jb.packets[i+1:], jb.packets[i:])
		jb.packets[i] = pkt
		inserted = true
		jb.stats.Reorders++
		break
	}
	if !inserted {
		jb.packets = append(jb.packets, pkt)
	}
}

// Pop retrieves the next packet ready for playout.
// Returns nil if no packet is ready (buffer not full enough during initial fill).
func (jb *JitterBuffer) Pop() *JitterPacket {
	jb.mu.Lock()
	defer jb.mu.Unlock()

	if len(jb.packets) == 0 {
		return nil
	}

	// Wait until we have enough packets buffered (initial fill only).
	// Once we start playing, we continue even with fewer packets.
	if !jb.playing && len(jb.packets) < jb.depth {
		return nil
	}

	// Mark that playout has started.
	jb.playing = true

	// Get the first packet (lowest sequence number).
	pkt := jb.packets[0]

	// Check if this is the next expected packet or close enough.
	gap := seqDiff(pkt.SequenceNumber, jb.nextSeq)
	if gap > MaxSequenceGap {
		// Large gap — reset the buffer (likely a stream restart).
		jb.nextSeq = pkt.SequenceNumber
	}

	// Pop the packet.
	jb.packets = jb.packets[1:]
	jb.nextSeq = pkt.SequenceNumber + 1
	jb.stats.PacketsPlayed++

	return pkt
}

// Len returns the current number of packets in the buffer.
func (jb *JitterBuffer) Len() int {
	jb.mu.Lock()
	defer jb.mu.Unlock()
	return len(jb.packets)
}

// Stats returns a copy of the buffer statistics.
func (jb *JitterBuffer) Stats() JitterStats {
	jb.mu.Lock()
	defer jb.mu.Unlock()
	return jb.stats
}

// Reset clears the buffer and resets state.
func (jb *JitterBuffer) Reset() {
	jb.mu.Lock()
	defer jb.mu.Unlock()
	jb.packets = jb.packets[:0]
	jb.initialized = false
	jb.playing = false
	jb.stats = JitterStats{}
}

// isStale returns true if the sequence number is behind our playout point.
func (jb *JitterBuffer) isStale(seq uint16) bool {
	// A packet is stale if it's before nextSeq (accounting for wraparound).
	return seqBefore(seq, jb.nextSeq)
}

// seqAfter returns true if a comes after b in sequence space (mod 65536).
func seqAfter(a, b uint16) bool {
	return int16(a-b) > 0
}

// seqBefore returns true if a comes before b in sequence space (mod 65536).
func seqBefore(a, b uint16) bool {
	return int16(a-b) < 0
}

// seqDiff returns the absolute distance between two sequence numbers.
func seqDiff(a, b uint16) uint16 {
	diff := int16(a - b)
	if diff < 0 {
		return uint16(-diff)
	}
	return uint16(diff)
}
