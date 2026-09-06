package sms

import (
	"testing"
	"time"
)

func TestDeterministicMessageID_StableForSameSingle(t *testing.T) {
	ts := time.Unix(1_700_000_000, 0).UTC()
	p := parsedMessage{Sender: "+15551234567", Body: "hello", Timestamp: ts}

	id1 := deterministicMessageID(p)
	id2 := deterministicMessageID(p)
	if id1 != id2 {
		t.Fatalf("same PDU produced different IDs: %q vs %q", id1, id2)
	}
	if id1 == "" || id1[:3] != "in-" {
		t.Fatalf("unexpected ID format: %q", id1)
	}
}

func TestDeterministicMessageID_DiffersOnContent(t *testing.T) {
	ts := time.Unix(1_700_000_000, 0).UTC()
	base := parsedMessage{Sender: "+15551234567", Body: "hello", Timestamp: ts}

	other := base
	other.Body = "goodbye"
	if deterministicMessageID(base) == deterministicMessageID(other) {
		t.Fatal("different bodies should produce different IDs")
	}

	otherSender := base
	otherSender.Sender = "+15559999999"
	if deterministicMessageID(base) == deterministicMessageID(otherSender) {
		t.Fatal("different senders should produce different IDs")
	}

	otherTime := base
	otherTime.Timestamp = ts.Add(time.Second)
	if deterministicMessageID(base) == deterministicMessageID(otherTime) {
		t.Fatal("different timestamps should produce different IDs")
	}
}

func TestDeterministicMessageID_ConcatSharedAcrossParts(t *testing.T) {
	// All parts of the same concatenated message must collapse to one ID,
	// regardless of per-part sequence number or body, so the assembled message
	// dedupes correctly server-side.
	part1 := parsedMessage{
		Sender:    "+15551234567",
		Body:      "part one",
		Timestamp: time.Unix(1, 0),
		Concat:    &ConcatInfo{RefNum: 42, SeqNum: 1, TotalParts: 3},
	}
	part2 := parsedMessage{
		Sender:    "+15551234567",
		Body:      "part two",
		Timestamp: time.Unix(2, 0), // parts can carry different SCTS
		Concat:    &ConcatInfo{RefNum: 42, SeqNum: 2, TotalParts: 3},
	}

	if deterministicMessageID(part1) != deterministicMessageID(part2) {
		t.Fatal("parts of the same concat message must share one ID")
	}
}

func TestDeterministicMessageID_ConcatDiffersByRef(t *testing.T) {
	a := parsedMessage{Sender: "+1", Concat: &ConcatInfo{RefNum: 1, SeqNum: 1, TotalParts: 2}}
	b := parsedMessage{Sender: "+1", Concat: &ConcatInfo{RefNum: 2, SeqNum: 1, TotalParts: 2}}
	if deterministicMessageID(a) == deterministicMessageID(b) {
		t.Fatal("different concat references should produce different IDs")
	}
}
