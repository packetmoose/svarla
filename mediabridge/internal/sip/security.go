package sip

import (
	"net"
	"sync"
)

// SecurityConfig holds IP allowlist configuration.
type SecurityConfig struct {
	// AllowedIPs is a list of allowed provider IP addresses or CIDR ranges.
	// If empty, all IPs are allowed (open mode).
	AllowedIPs []string `yaml:"allowedIps"`
}

// IPAllowlist checks whether a remote address is permitted to send SIP messages.
type IPAllowlist struct {
	mu      sync.RWMutex
	nets    []*net.IPNet
	ips     []net.IP
	allowAll bool
}

// NewIPAllowlist creates an IP allowlist from a list of IPs/CIDRs.
// If the list is empty, all IPs are allowed.
func NewIPAllowlist(allowed []string) *IPAllowlist {
	al := &IPAllowlist{}

	if len(allowed) == 0 {
		al.allowAll = true
		return al
	}

	for _, entry := range allowed {
		// Try parsing as CIDR.
		_, ipNet, err := net.ParseCIDR(entry)
		if err == nil {
			al.nets = append(al.nets, ipNet)
			continue
		}
		// Try parsing as single IP.
		ip := net.ParseIP(entry)
		if ip != nil {
			al.ips = append(al.ips, ip)
		}
	}

	// If nothing was successfully parsed, allow all.
	if len(al.nets) == 0 && len(al.ips) == 0 {
		al.allowAll = true
	}

	return al
}

// IsAllowed checks if the given address (IP:port or just IP) is in the allowlist.
func (al *IPAllowlist) IsAllowed(addr string) bool {
	al.mu.RLock()
	defer al.mu.RUnlock()

	if al.allowAll {
		return true
	}

	// Extract IP from addr (may be "ip:port" or just "ip").
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		host = addr
	}

	ip := net.ParseIP(host)
	if ip == nil {
		return false
	}

	// Check individual IPs.
	for _, allowed := range al.ips {
		if allowed.Equal(ip) {
			return true
		}
	}

	// Check CIDR ranges.
	for _, ipNet := range al.nets {
		if ipNet.Contains(ip) {
			return true
		}
	}

	return false
}

// Update replaces the allowlist with a new set of IPs/CIDRs.
func (al *IPAllowlist) Update(allowed []string) {
	newAl := NewIPAllowlist(allowed)

	al.mu.Lock()
	defer al.mu.Unlock()
	al.nets = newAl.nets
	al.ips = newAl.ips
	al.allowAll = newAl.allowAll
}
