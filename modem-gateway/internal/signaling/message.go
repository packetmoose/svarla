package signaling

import "encoding/json"

// Message type constants for the signaling protocol.
const (
	// Authentication
	TypeAuthPair      = "auth_pair"
	TypeAuthChallenge = "auth_challenge"
	TypeAuthResponse  = "auth_response"
	TypeAuthSuccess   = "auth_success"
	TypeAuthError     = "auth_error"

	// Call signaling
	TypeMakeCall    = "make_call"
	TypeAnswerCall  = "answer_call"
	TypeEndCall     = "end_call"
	TypeIncomingCall = "incoming_call"
	TypeCallState   = "call_state"

	// SMS
	TypeSendSMS     = "send_sms"
	TypeIncomingSMS  = "incoming_sms"
	TypeSMSResult   = "sms_result"
	TypeBufferedSMS  = "buffered_sms"
	TypeDeliveryReport = "delivery_report"

	// DTMF
	TypeSendDTMF     = "send_dtmf"
	TypeDTMFReceived = "dtmf_received"
	TypeDTMFResult   = "dtmf_result"

	// USSD
	TypeUSSDRequest  = "ussd_request"
	TypeUSSDResponse = "ussd_response"
	TypeUSSDError    = "ussd_error"

	// Status
	TypeStatus       = "status"
	TypeNumberReport = "number_report"
	TypeMissedCalls  = "missed_calls"
)

// Message represents a signaling message with a type field and arbitrary JSON payload.
// The Type field is used for dispatch; Payload contains the full raw JSON of the message.
type Message struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"-"`
}

// MarshalJSON marshals the Message by embedding the type into the payload.
// If Payload is nil or empty, it produces {"type":"..."}.
// If Payload already contains data, it merges the type field into it.
func (m Message) MarshalJSON() ([]byte, error) {
	if len(m.Payload) == 0 {
		return json.Marshal(struct {
			Type string `json:"type"`
		}{Type: m.Type})
	}

	// Unmarshal existing payload into a map, set the type, re-marshal.
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(m.Payload, &obj); err != nil {
		// Payload isn't a JSON object; wrap it with type.
		return json.Marshal(struct {
			Type string `json:"type"`
		}{Type: m.Type})
	}

	typeBytes, err := json.Marshal(m.Type)
	if err != nil {
		return nil, err
	}
	obj["type"] = typeBytes

	return json.Marshal(obj)
}

// UnmarshalJSON extracts the type field and stores the full payload.
func (m *Message) UnmarshalJSON(data []byte) error {
	// Extract just the type field.
	var envelope struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(data, &envelope); err != nil {
		return err
	}
	m.Type = envelope.Type
	m.Payload = json.RawMessage(data)
	return nil
}

// NewMessage creates a Message with the given type and a payload marshaled from v.
// If v is nil, the message will only contain the type field.
func NewMessage(msgType string, v any) (Message, error) {
	msg := Message{Type: msgType}
	if v == nil {
		return msg, nil
	}

	data, err := json.Marshal(v)
	if err != nil {
		return Message{}, err
	}
	msg.Payload = data
	return msg, nil
}

// ParsePayload unmarshals the message payload into the provided struct.
func (m *Message) ParsePayload(v any) error {
	if len(m.Payload) == 0 {
		return nil
	}
	return json.Unmarshal(m.Payload, v)
}
