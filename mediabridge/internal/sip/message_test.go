package sip

import (
	"testing"
)

func TestParseMessage_INVITE(t *testing.T) {
	raw := "INVITE sip:abc-123@192.168.1.100:5060 SIP/2.0\r\n" +
		"Via: SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK776\r\n" +
		"From: <sip:provider@10.0.0.1>;tag=from123\r\n" +
		"To: <sip:abc-123@192.168.1.100>\r\n" +
		"Call-ID: call-001@10.0.0.1\r\n" +
		"CSeq: 1 INVITE\r\n" +
		"Contact: <sip:provider@10.0.0.1:5060>\r\n" +
		"Content-Type: application/sdp\r\n" +
		"Content-Length: 0\r\n" +
		"\r\n"

	msg, err := ParseMessage([]byte(raw))
	if err != nil {
		t.Fatalf("ParseMessage failed: %v", err)
	}

	if !msg.IsRequest {
		t.Fatal("expected request")
	}
	if msg.Method != MethodINVITE {
		t.Fatalf("expected INVITE, got %s", msg.Method)
	}
	if msg.RequestURI != "sip:abc-123@192.168.1.100:5060" {
		t.Fatalf("unexpected RequestURI: %s", msg.RequestURI)
	}
	if msg.CallID != "call-001@10.0.0.1" {
		t.Fatalf("unexpected CallID: %s", msg.CallID)
	}
	if msg.From != "<sip:provider@10.0.0.1>;tag=from123" {
		t.Fatalf("unexpected From: %s", msg.From)
	}
	if msg.To != "<sip:abc-123@192.168.1.100>" {
		t.Fatalf("unexpected To: %s", msg.To)
	}
	if len(msg.Via) != 1 {
		t.Fatalf("expected 1 Via, got %d", len(msg.Via))
	}
	if msg.CSeq != "1 INVITE" {
		t.Fatalf("unexpected CSeq: %s", msg.CSeq)
	}
}

func TestParseMessage_BYE(t *testing.T) {
	raw := "BYE sip:abc-123@192.168.1.100:5060 SIP/2.0\r\n" +
		"Via: SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK999\r\n" +
		"From: <sip:provider@10.0.0.1>;tag=from456\r\n" +
		"To: <sip:abc-123@192.168.1.100>;tag=to789\r\n" +
		"Call-ID: call-002@10.0.0.1\r\n" +
		"CSeq: 2 BYE\r\n" +
		"Content-Length: 0\r\n" +
		"\r\n"

	msg, err := ParseMessage([]byte(raw))
	if err != nil {
		t.Fatalf("ParseMessage failed: %v", err)
	}

	if !msg.IsRequest {
		t.Fatal("expected request")
	}
	if msg.Method != MethodBYE {
		t.Fatalf("expected BYE, got %s", msg.Method)
	}
	if msg.CallID != "call-002@10.0.0.1" {
		t.Fatalf("unexpected CallID: %s", msg.CallID)
	}
}

func TestParseMessage_Response(t *testing.T) {
	raw := "SIP/2.0 200 OK\r\n" +
		"Via: SIP/2.0/UDP 192.168.1.100:5060;branch=z9hG4bKabc\r\n" +
		"From: <sip:mediabridge@192.168.1.100>;tag=mb-111\r\n" +
		"To: <sip:provider@10.0.0.1>;tag=remote222\r\n" +
		"Call-ID: call-003@192.168.1.100\r\n" +
		"CSeq: 1 BYE\r\n" +
		"Content-Length: 0\r\n" +
		"\r\n"

	msg, err := ParseMessage([]byte(raw))
	if err != nil {
		t.Fatalf("ParseMessage failed: %v", err)
	}

	if msg.IsRequest {
		t.Fatal("expected response")
	}
	if msg.StatusCode != 200 {
		t.Fatalf("expected 200, got %d", msg.StatusCode)
	}
	if msg.ReasonPhrase != "OK" {
		t.Fatalf("unexpected reason: %s", msg.ReasonPhrase)
	}
}

func TestParseMessage_WithBody(t *testing.T) {
	body := "v=0\r\no=- 0 0 IN IP4 10.0.0.1\r\ns=-\r\nc=IN IP4 10.0.0.1\r\nt=0 0\r\nm=audio 4000 RTP/AVP 0\r\n"
	raw := "INVITE sip:session-1@host:5060 SIP/2.0\r\n" +
		"Via: SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK1\r\n" +
		"From: <sip:p@10.0.0.1>;tag=t1\r\n" +
		"To: <sip:session-1@host>\r\n" +
		"Call-ID: c1@10.0.0.1\r\n" +
		"CSeq: 1 INVITE\r\n" +
		"Content-Type: application/sdp\r\n" +
		"Content-Length: " + itoa(len(body)) + "\r\n" +
		"\r\n" +
		body

	msg, err := ParseMessage([]byte(raw))
	if err != nil {
		t.Fatalf("ParseMessage failed: %v", err)
	}

	if len(msg.Body) != len(body) {
		t.Fatalf("expected body length %d, got %d", len(body), len(msg.Body))
	}
	if string(msg.Body) != body {
		t.Fatalf("body mismatch")
	}
}

func TestExtractSessionIDFromURI(t *testing.T) {
	tests := []struct {
		uri      string
		expected string
	}{
		{"sip:abc-123@host:5060", "abc-123"},
		{"sip:my-session@192.168.1.1:5060", "my-session"},
		{"sips:secure-sess@host", "secure-sess"},
		{"sip:plainuser@host.com", "plainuser"},
		{"sip:550e8400-e29b-41d4-a716-446655440000@10.0.0.1:5060", "550e8400-e29b-41d4-a716-446655440000"},
		{"noprefix@host", "noprefix"},
	}

	for _, tt := range tests {
		result := ExtractSessionIDFromURI(tt.uri)
		if result != tt.expected {
			t.Errorf("ExtractSessionIDFromURI(%q) = %q, want %q", tt.uri, result, tt.expected)
		}
	}
}

func TestBuildResponse(t *testing.T) {
	req := &Message{
		IsRequest:  true,
		Method:     MethodINVITE,
		RequestURI: "sip:session@host:5060",
		Via:        []string{"SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK1"},
		From:       "<sip:provider@10.0.0.1>;tag=fromtag",
		To:         "<sip:session@host>",
		CallID:     "call-100",
		CSeq:       "1 INVITE",
	}

	resp := BuildResponse(req, 200, "OK", nil, nil)
	respStr := string(resp)

	if !contains(respStr, "SIP/2.0 200 OK") {
		t.Error("missing status line")
	}
	if !contains(respStr, "Via: SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK1") {
		t.Error("missing Via header")
	}
	if !contains(respStr, "Call-ID: call-100") {
		t.Error("missing Call-ID")
	}
	if !contains(respStr, "CSeq: 1 INVITE") {
		t.Error("missing CSeq")
	}
	if !contains(respStr, "Content-Length: 0") {
		t.Error("missing Content-Length")
	}
}

func TestBuildResponse_WithTag(t *testing.T) {
	req := &Message{
		IsRequest:  true,
		Via:        []string{"SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK1"},
		From:       "<sip:provider@10.0.0.1>;tag=fromtag",
		To:         "<sip:session@host>",
		CallID:     "call-101",
		CSeq:       "1 INVITE",
	}

	resp := BuildResponse(req, 200, "OK", nil, nil)
	respStr := string(resp)

	// 200 response should add a tag to the To header.
	if !contains(respStr, ";tag=mb-") {
		t.Error("expected To tag in 200 response")
	}
}

func contains(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || len(s) > 0 && containsHelper(s, substr))
}

func containsHelper(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	result := ""
	for n > 0 {
		result = string(rune('0'+n%10)) + result
		n /= 10
	}
	return result
}
