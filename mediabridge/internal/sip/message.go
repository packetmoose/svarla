// Package sip implements a minimal SIP User Agent Server (UAS) for the MediaBridge.
// It listens for SIP INVITE/BYE messages from telephony providers and manages
// SIP dialogs for audio bridging sessions.
package sip

import (
	"bufio"
	"bytes"
	"fmt"
	"net/textproto"
	"strconv"
	"strings"
)

// Method represents a SIP method.
type Method string

const (
	MethodINVITE Method = "INVITE"
	MethodACK    Method = "ACK"
	MethodBYE    Method = "BYE"
	MethodCANCEL Method = "CANCEL"
)

// Message represents a parsed SIP message (request or response).
type Message struct {
	// Request fields
	IsRequest bool
	Method    Method
	RequestURI string

	// Response fields
	StatusCode   int
	ReasonPhrase string

	// Common fields
	Headers map[string][]string
	Body    []byte

	// Parsed convenience fields
	CallID    string
	From      string
	To        string
	Via       []string
	CSeq      string
	Contact   string
	ContentType string
}

// GetHeader returns the first value for a header (case-insensitive).
func (m *Message) GetHeader(name string) string {
	key := strings.ToLower(name)
	for k, vals := range m.Headers {
		if strings.ToLower(k) == key && len(vals) > 0 {
			return vals[0]
		}
	}
	return ""
}

// GetHeaders returns all values for a header (case-insensitive).
func (m *Message) GetHeaders(name string) []string {
	key := strings.ToLower(name)
	for k, vals := range m.Headers {
		if strings.ToLower(k) == key {
			return vals
		}
	}
	return nil
}

// ParseMessage parses a raw SIP message from bytes.
func ParseMessage(data []byte) (*Message, error) {
	reader := bufio.NewReader(bytes.NewReader(data))
	tp := textproto.NewReader(reader)

	// Read the start line.
	startLine, err := tp.ReadLine()
	if err != nil {
		return nil, fmt.Errorf("reading start line: %w", err)
	}

	msg := &Message{
		Headers: make(map[string][]string),
	}

	// Determine if it's a request or response.
	if strings.HasPrefix(startLine, "SIP/") {
		// Response: SIP/2.0 200 OK
		if err := parseResponseLine(startLine, msg); err != nil {
			return nil, err
		}
	} else {
		// Request: INVITE sip:session-id@host:5060 SIP/2.0
		if err := parseRequestLine(startLine, msg); err != nil {
			return nil, err
		}
	}

	// Read headers.
	mimeHeader, err := tp.ReadMIMEHeader()
	if err != nil {
		return nil, fmt.Errorf("reading headers: %w", err)
	}
	for k, v := range mimeHeader {
		msg.Headers[k] = v
	}

	// Extract common headers for convenience.
	msg.CallID = msg.GetHeader("Call-ID")
	if msg.CallID == "" {
		msg.CallID = msg.GetHeader("i")
	}
	msg.From = msg.GetHeader("From")
	if msg.From == "" {
		msg.From = msg.GetHeader("f")
	}
	msg.To = msg.GetHeader("To")
	if msg.To == "" {
		msg.To = msg.GetHeader("t")
	}
	msg.Via = msg.GetHeaders("Via")
	if len(msg.Via) == 0 {
		msg.Via = msg.GetHeaders("v")
	}
	msg.CSeq = msg.GetHeader("CSeq")
	msg.Contact = msg.GetHeader("Contact")
	if msg.Contact == "" {
		msg.Contact = msg.GetHeader("m")
	}
	msg.ContentType = msg.GetHeader("Content-Type")
	if msg.ContentType == "" {
		msg.ContentType = msg.GetHeader("c")
	}

	// Read body if Content-Length is present.
	clStr := msg.GetHeader("Content-Length")
	if clStr == "" {
		clStr = msg.GetHeader("l")
	}
	if clStr != "" {
		cl, err := strconv.Atoi(strings.TrimSpace(clStr))
		if err == nil && cl > 0 {
			body := make([]byte, cl)
			n, _ := reader.Read(body)
			msg.Body = body[:n]
		}
	}

	return msg, nil
}

func parseRequestLine(line string, msg *Message) error {
	parts := strings.SplitN(line, " ", 3)
	if len(parts) < 3 {
		return fmt.Errorf("invalid request line: %s", line)
	}
	msg.IsRequest = true
	msg.Method = Method(parts[0])
	msg.RequestURI = parts[1]
	return nil
}

func parseResponseLine(line string, msg *Message) error {
	parts := strings.SplitN(line, " ", 3)
	if len(parts) < 2 {
		return fmt.Errorf("invalid response line: %s", line)
	}
	msg.IsRequest = false
	code, err := strconv.Atoi(parts[1])
	if err != nil {
		return fmt.Errorf("invalid status code: %s", parts[1])
	}
	msg.StatusCode = code
	if len(parts) >= 3 {
		msg.ReasonPhrase = parts[2]
	}
	return nil
}

// ExtractSessionIDFromURI extracts the user part of a SIP URI.
// Example: "sip:session-id@host:5060" returns "session-id".
func ExtractSessionIDFromURI(uri string) string {
	// Strip "sip:" or "sips:" prefix.
	u := uri
	if strings.HasPrefix(u, "sip:") {
		u = u[4:]
	} else if strings.HasPrefix(u, "sips:") {
		u = u[5:]
	}

	// Extract user part (before @).
	if idx := strings.Index(u, "@"); idx >= 0 {
		return u[:idx]
	}
	return u
}

// BuildResponse creates a SIP response message to a request.
func BuildResponse(req *Message, statusCode int, reasonPhrase string, body []byte, extraHeaders map[string]string) []byte {
	var buf bytes.Buffer

	// Status line
	fmt.Fprintf(&buf, "SIP/2.0 %d %s\r\n", statusCode, reasonPhrase)

	// Copy Via headers (mandatory for routing responses)
	for _, v := range req.Via {
		fmt.Fprintf(&buf, "Via: %s\r\n", v)
	}

	// From, To, Call-ID, CSeq (mandatory in responses)
	fmt.Fprintf(&buf, "From: %s\r\n", req.From)

	// Add tag to To if not present (for dialog establishment)
	to := req.To
	if statusCode >= 200 && !strings.Contains(to, "tag=") {
		to = to + ";tag=mb-" + generateTag()
	}
	fmt.Fprintf(&buf, "To: %s\r\n", to)
	fmt.Fprintf(&buf, "Call-ID: %s\r\n", req.CallID)
	fmt.Fprintf(&buf, "CSeq: %s\r\n", req.CSeq)

	// Extra headers
	for k, v := range extraHeaders {
		fmt.Fprintf(&buf, "%s: %s\r\n", k, v)
	}

	// Content-Type and Content-Length
	if len(body) > 0 {
		ct := "application/sdp"
		if extraHeaders != nil {
			if ct2, ok := extraHeaders["Content-Type"]; ok {
				ct = ct2
			}
		}
		fmt.Fprintf(&buf, "Content-Type: %s\r\n", ct)
	}
	fmt.Fprintf(&buf, "Content-Length: %d\r\n", len(body))

	// End of headers
	buf.WriteString("\r\n")

	// Body
	if len(body) > 0 {
		buf.Write(body)
	}

	return buf.Bytes()
}

// BuildRequest creates a SIP request message.
func BuildRequest(method Method, requestURI string, headers map[string]string, body []byte) []byte {
	var buf bytes.Buffer

	// Request line
	fmt.Fprintf(&buf, "%s %s SIP/2.0\r\n", method, requestURI)

	// Headers
	for k, v := range headers {
		fmt.Fprintf(&buf, "%s: %s\r\n", k, v)
	}

	// Content-Length
	fmt.Fprintf(&buf, "Content-Length: %d\r\n", len(body))

	// End of headers
	buf.WriteString("\r\n")

	// Body
	if len(body) > 0 {
		buf.Write(body)
	}

	return buf.Bytes()
}

// generateTag returns a short random tag for SIP dialogs.
func generateTag() string {
	// Simple timestamp-based tag — sufficient for our use case.
	return fmt.Sprintf("%x", uint32(timeNow().UnixNano()&0xFFFFFFFF))
}
