package sip

import (
	"strings"
	"testing"
)

func TestParseSDP_BasicG711(t *testing.T) {
	sdp := "v=0\r\n" +
		"o=- 0 0 IN IP4 10.0.0.1\r\n" +
		"s=call\r\n" +
		"c=IN IP4 10.0.0.1\r\n" +
		"t=0 0\r\n" +
		"m=audio 4000 RTP/AVP 0\r\n" +
		"a=rtpmap:0 PCMU/8000\r\n" +
		"a=sendrecv\r\n"

	offer, err := ParseSDP([]byte(sdp))
	if err != nil {
		t.Fatalf("ParseSDP failed: %v", err)
	}

	if offer.IP != "10.0.0.1" {
		t.Fatalf("unexpected IP: %s", offer.IP)
	}
	if offer.Port != 4000 {
		t.Fatalf("unexpected port: %d", offer.Port)
	}
	if len(offer.Codecs) == 0 {
		t.Fatal("no codecs parsed")
	}

	found := false
	for _, c := range offer.Codecs {
		if c.Name == "PCMU" && c.ClockRate == 8000 {
			found = true
		}
	}
	if !found {
		t.Fatal("PCMU codec not found")
	}
}

func TestParseSDP_OpusAndG711(t *testing.T) {
	sdp := "v=0\r\n" +
		"o=- 1 1 IN IP4 10.0.0.2\r\n" +
		"s=-\r\n" +
		"c=IN IP4 10.0.0.2\r\n" +
		"t=0 0\r\n" +
		"m=audio 5000 RTP/AVP 111 0\r\n" +
		"a=rtpmap:111 opus/48000/2\r\n" +
		"a=rtpmap:0 PCMU/8000\r\n" +
		"a=sendrecv\r\n"

	offer, err := ParseSDP([]byte(sdp))
	if err != nil {
		t.Fatalf("ParseSDP failed: %v", err)
	}

	if offer.Port != 5000 {
		t.Fatalf("unexpected port: %d", offer.Port)
	}

	var hasOpus, hasPCMU bool
	for _, c := range offer.Codecs {
		if c.Name == "opus" && c.ClockRate == 48000 && c.Channels == 2 {
			hasOpus = true
		}
		if c.Name == "PCMU" && c.ClockRate == 8000 {
			hasPCMU = true
		}
	}
	if !hasOpus {
		t.Error("opus not found")
	}
	if !hasPCMU {
		t.Error("PCMU not found")
	}
}

func TestParseSDP_StaticPayloadType0(t *testing.T) {
	// Some providers only send m= line with PT 0, no rtpmap for static types.
	sdp := "v=0\r\n" +
		"o=- 0 0 IN IP4 10.0.0.3\r\n" +
		"s=-\r\n" +
		"c=IN IP4 10.0.0.3\r\n" +
		"t=0 0\r\n" +
		"m=audio 6000 RTP/AVP 0\r\n" +
		"a=sendrecv\r\n"

	offer, err := ParseSDP([]byte(sdp))
	if err != nil {
		t.Fatalf("ParseSDP failed: %v", err)
	}

	if offer.Port != 6000 {
		t.Fatalf("unexpected port: %d", offer.Port)
	}
	if len(offer.Codecs) == 0 {
		t.Fatal("expected at least one codec entry")
	}
	// PT 0 should be there (name may be empty if no rtpmap).
	if offer.Codecs[0].PayloadType != 0 {
		t.Fatalf("expected PT 0, got %d", offer.Codecs[0].PayloadType)
	}
}

func TestNegotiateCodec_PrefersPCMU(t *testing.T) {
	offer := &SDPOffer{
		Codecs: []Codec{
			{Name: "opus", PayloadType: 111, ClockRate: 48000, Channels: 2},
			{Name: "PCMU", PayloadType: 0, ClockRate: 8000, Channels: 1},
		},
	}

	codec, err := NegotiateCodec(offer)
	if err != nil {
		t.Fatalf("NegotiateCodec failed: %v", err)
	}
	if codec.Name != "PCMU" {
		t.Fatalf("expected PCMU, got %s", codec.Name)
	}
}

func TestNegotiateCodec_FallsBackToOpus(t *testing.T) {
	offer := &SDPOffer{
		Codecs: []Codec{
			{Name: "opus", PayloadType: 111, ClockRate: 48000, Channels: 2},
			{Name: "GSM", PayloadType: 3, ClockRate: 8000, Channels: 1},
		},
	}

	codec, err := NegotiateCodec(offer)
	if err != nil {
		t.Fatalf("NegotiateCodec failed: %v", err)
	}
	if codec.Name != "opus" {
		t.Fatalf("expected opus, got %s", codec.Name)
	}
}

func TestNegotiateCodec_StaticPT0(t *testing.T) {
	// PT 0 without explicit rtpmap should be treated as PCMU.
	offer := &SDPOffer{
		Codecs: []Codec{
			{Name: "", PayloadType: 0, ClockRate: 0, Channels: 0},
		},
	}

	codec, err := NegotiateCodec(offer)
	if err != nil {
		t.Fatalf("NegotiateCodec failed: %v", err)
	}
	if codec.Name != "PCMU" {
		t.Fatalf("expected PCMU, got %s", codec.Name)
	}
}

func TestNegotiateCodec_NoSupportedCodec(t *testing.T) {
	offer := &SDPOffer{
		Codecs: []Codec{
			{Name: "GSM", PayloadType: 3, ClockRate: 8000, Channels: 1},
			{Name: "G729", PayloadType: 18, ClockRate: 8000, Channels: 1},
		},
	}

	_, err := NegotiateCodec(offer)
	if err == nil {
		t.Fatal("expected error for unsupported codecs")
	}
}

func TestGenerateSDPAnswer(t *testing.T) {
	answer := SDPAnswer{
		Codec:     Codec{Name: "PCMU", PayloadType: 0, ClockRate: 8000, Channels: 1},
		LocalIP:   "192.168.1.100",
		LocalPort: 5062,
	}

	sdp := string(GenerateSDPAnswer(answer))

	if !strings.Contains(sdp, "v=0") {
		t.Error("missing version line")
	}
	if !strings.Contains(sdp, "c=IN IP4 192.168.1.100") {
		t.Error("missing connection line")
	}
	if !strings.Contains(sdp, "m=audio 5062 RTP/AVP 0") {
		t.Error("missing media line")
	}
	if !strings.Contains(sdp, "a=sendrecv") {
		t.Error("missing sendrecv attribute")
	}
}

func TestGenerateSDPAnswer_Opus(t *testing.T) {
	answer := SDPAnswer{
		Codec:     Codec{Name: "opus", PayloadType: 111, ClockRate: 48000, Channels: 2},
		LocalIP:   "10.0.0.5",
		LocalPort: 5062,
	}

	sdp := string(GenerateSDPAnswer(answer))

	if !strings.Contains(sdp, "m=audio 5062 RTP/AVP 111") {
		t.Error("missing media line with PT 111")
	}
	if !strings.Contains(sdp, "a=rtpmap:111 opus/48000/2") {
		t.Error("missing rtpmap for opus")
	}
}
