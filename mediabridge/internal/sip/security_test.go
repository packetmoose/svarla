package sip

import (
	"testing"
)

func TestIPAllowlist_EmptyAllowsAll(t *testing.T) {
	al := NewIPAllowlist(nil)

	if !al.IsAllowed("10.0.0.1:5060") {
		t.Error("empty allowlist should allow all")
	}
	if !al.IsAllowed("192.168.1.1:5060") {
		t.Error("empty allowlist should allow all")
	}
}

func TestIPAllowlist_SingleIP(t *testing.T) {
	al := NewIPAllowlist([]string{"10.0.0.1"})

	if !al.IsAllowed("10.0.0.1:5060") {
		t.Error("should allow configured IP")
	}
	if al.IsAllowed("10.0.0.2:5060") {
		t.Error("should reject unconfigured IP")
	}
}

func TestIPAllowlist_MultipleIPs(t *testing.T) {
	al := NewIPAllowlist([]string{"10.0.0.1", "10.0.0.2", "192.168.1.100"})

	if !al.IsAllowed("10.0.0.1:5060") {
		t.Error("should allow first IP")
	}
	if !al.IsAllowed("10.0.0.2:5060") {
		t.Error("should allow second IP")
	}
	if !al.IsAllowed("192.168.1.100:5060") {
		t.Error("should allow third IP")
	}
	if al.IsAllowed("172.16.0.1:5060") {
		t.Error("should reject unlisted IP")
	}
}

func TestIPAllowlist_CIDR(t *testing.T) {
	al := NewIPAllowlist([]string{"10.0.0.0/24"})

	if !al.IsAllowed("10.0.0.1:5060") {
		t.Error("should allow IP in CIDR range")
	}
	if !al.IsAllowed("10.0.0.254:5060") {
		t.Error("should allow IP in CIDR range")
	}
	if al.IsAllowed("10.0.1.1:5060") {
		t.Error("should reject IP outside CIDR range")
	}
}

func TestIPAllowlist_MixedIPAndCIDR(t *testing.T) {
	al := NewIPAllowlist([]string{"192.168.1.50", "10.0.0.0/16"})

	if !al.IsAllowed("192.168.1.50:5060") {
		t.Error("should allow explicit IP")
	}
	if !al.IsAllowed("10.0.5.10:5060") {
		t.Error("should allow IP in CIDR range")
	}
	if al.IsAllowed("192.168.1.51:5060") {
		t.Error("should reject IP not in list or CIDR")
	}
}

func TestIPAllowlist_WithoutPort(t *testing.T) {
	al := NewIPAllowlist([]string{"10.0.0.1"})

	// Should also handle bare IP without port.
	if !al.IsAllowed("10.0.0.1") {
		t.Error("should handle bare IP without port")
	}
}

func TestIPAllowlist_InvalidIP(t *testing.T) {
	al := NewIPAllowlist([]string{"10.0.0.1"})

	if al.IsAllowed("not-an-ip:5060") {
		t.Error("should reject invalid IP")
	}
}

func TestIPAllowlist_Update(t *testing.T) {
	al := NewIPAllowlist([]string{"10.0.0.1"})

	if !al.IsAllowed("10.0.0.1:5060") {
		t.Error("initially should allow 10.0.0.1")
	}
	if al.IsAllowed("10.0.0.2:5060") {
		t.Error("initially should reject 10.0.0.2")
	}

	// Update the allowlist.
	al.Update([]string{"10.0.0.2"})

	if al.IsAllowed("10.0.0.1:5060") {
		t.Error("after update should reject 10.0.0.1")
	}
	if !al.IsAllowed("10.0.0.2:5060") {
		t.Error("after update should allow 10.0.0.2")
	}
}
