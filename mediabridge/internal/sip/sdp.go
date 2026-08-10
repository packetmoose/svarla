package sip

import (
	"fmt"
	"strings"
)

// Codec represents a negotiated audio codec.
type Codec struct {
	Name       string // e.g. "PCMU", "opus"
	PayloadType int   // RTP payload type number
	ClockRate  int    // e.g. 8000 for G.711, 48000 for Opus
	Channels   int   // 1 for mono, 2 for stereo
}

// SDPOffer represents a parsed SDP from an INVITE.
type SDPOffer struct {
	Raw          string
	Codecs       []Codec
	IP           string // Connection IP (c= line)
	Port         int    // Media port (m= line)
	SessionName  string
}

// SDPAnswer represents the SDP answer we generate.
type SDPAnswer struct {
	Codec       Codec
	LocalIP     string
	LocalPort   int
	UseSRTP     bool   // When true, use RTP/SAVP profile instead of RTP/AVP
	CryptoLine  string // a=crypto answer line (e.g., "a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:<key>")
}

// ParseSDP performs minimal SDP parsing to extract audio codecs offered.
func ParseSDP(body []byte) (*SDPOffer, error) {
	offer := &SDPOffer{
		Raw: string(body),
	}

	lines := strings.Split(string(body), "\n")
	var inAudioMedia bool

	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}

		switch {
		case strings.HasPrefix(line, "c=IN IP4 "):
			offer.IP = strings.TrimPrefix(line, "c=IN IP4 ")
		case strings.HasPrefix(line, "c=IN IP6 "):
			offer.IP = strings.TrimPrefix(line, "c=IN IP6 ")
		case strings.HasPrefix(line, "s="):
			offer.SessionName = line[2:]
		case strings.HasPrefix(line, "m=audio "):
			inAudioMedia = true
			parts := strings.Fields(line)
			if len(parts) >= 2 {
				fmt.Sscanf(parts[1], "%d", &offer.Port)
			}
			// Extract payload types from m= line
			if len(parts) >= 4 {
				for _, ptStr := range parts[3:] {
					var pt int
					if _, err := fmt.Sscanf(ptStr, "%d", &pt); err == nil {
						offer.Codecs = append(offer.Codecs, Codec{PayloadType: pt})
					}
				}
			}
		case strings.HasPrefix(line, "m=") && !strings.HasPrefix(line, "m=audio"):
			inAudioMedia = false
		case strings.HasPrefix(line, "a=rtpmap:") && inAudioMedia:
			// a=rtpmap:0 PCMU/8000
			// a=rtpmap:111 opus/48000/2
			rest := strings.TrimPrefix(line, "a=rtpmap:")
			parts := strings.SplitN(rest, " ", 2)
			if len(parts) == 2 {
				var pt int
				fmt.Sscanf(parts[0], "%d", &pt)
				codecParts := strings.Split(parts[1], "/")
				name := codecParts[0]
				clockRate := 8000
				channels := 1
				if len(codecParts) >= 2 {
					fmt.Sscanf(codecParts[1], "%d", &clockRate)
				}
				if len(codecParts) >= 3 {
					fmt.Sscanf(codecParts[2], "%d", &channels)
				}
				// Update existing codec entry or add new.
				found := false
				for i := range offer.Codecs {
					if offer.Codecs[i].PayloadType == pt {
						offer.Codecs[i].Name = name
						offer.Codecs[i].ClockRate = clockRate
						offer.Codecs[i].Channels = channels
						found = true
						break
					}
				}
				if !found {
					offer.Codecs = append(offer.Codecs, Codec{
						Name:        name,
						PayloadType: pt,
						ClockRate:   clockRate,
						Channels:    channels,
					})
				}
			}
		}
	}

	return offer, nil
}

// NegotiateCodec selects the best codec from an SDP offer.
// Prefers G.711 µ-law (PCMU) as primary; also supports Opus if offered.
func NegotiateCodec(offer *SDPOffer) (*Codec, error) {
	var pcmu, opus *Codec

	for i := range offer.Codecs {
		c := &offer.Codecs[i]
		switch {
		case strings.EqualFold(c.Name, "PCMU"):
			pcmu = c
		case strings.EqualFold(c.Name, "opus"):
			opus = c
		case c.PayloadType == 0 && c.Name == "":
			// Static payload type 0 is PCMU/8000
			c.Name = "PCMU"
			c.ClockRate = 8000
			c.Channels = 1
			pcmu = c
		}
	}

	// Prefer PCMU as primary codec (per requirement 4.9)
	if pcmu != nil {
		return pcmu, nil
	}
	// Fall back to Opus if provider supports it
	if opus != nil {
		return opus, nil
	}

	return nil, fmt.Errorf("no supported codec in offer (need PCMU or Opus)")
}

// GenerateSDPAnswer builds an SDP answer body with the negotiated codec.
func GenerateSDPAnswer(answer SDPAnswer) []byte {
	var sb strings.Builder

	sb.WriteString("v=0\r\n")
	sb.WriteString(fmt.Sprintf("o=mediabridge 0 0 IN IP4 %s\r\n", answer.LocalIP))
	sb.WriteString("s=MediaBridge\r\n")
	sb.WriteString(fmt.Sprintf("c=IN IP4 %s\r\n", answer.LocalIP))
	sb.WriteString("t=0 0\r\n")

	// Audio media line — use RTP/SAVP when SRTP is negotiated, RTP/AVP otherwise.
	profile := "RTP/AVP"
	if answer.UseSRTP {
		profile = "RTP/SAVP"
	}
	sb.WriteString(fmt.Sprintf("m=audio %d %s %d\r\n", answer.LocalPort, profile, answer.Codec.PayloadType))

	// rtpmap (skip for well-known static types like PT 0)
	if answer.Codec.PayloadType >= 96 || answer.Codec.Name != "PCMU" {
		if answer.Codec.Channels > 1 {
			sb.WriteString(fmt.Sprintf("a=rtpmap:%d %s/%d/%d\r\n",
				answer.Codec.PayloadType, answer.Codec.Name,
				answer.Codec.ClockRate, answer.Codec.Channels))
		} else {
			sb.WriteString(fmt.Sprintf("a=rtpmap:%d %s/%d\r\n",
				answer.Codec.PayloadType, answer.Codec.Name,
				answer.Codec.ClockRate))
		}
	}

	// Include a=crypto answer line when SRTP is negotiated.
	if answer.UseSRTP && answer.CryptoLine != "" {
		sb.WriteString(answer.CryptoLine + "\r\n")
	}

	sb.WriteString("a=sendrecv\r\n")
	sb.WriteString("a=ptime:20\r\n")

	return []byte(sb.String())
}
