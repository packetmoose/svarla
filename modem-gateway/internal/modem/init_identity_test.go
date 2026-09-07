package modem

import "testing"

func TestParseCNUM(t *testing.T) {
	tests := []struct {
		name string
		resp string
		want string
	}{
		{
			name: "standard",
			resp: "+CNUM: \"\",\"+15551234567\",145\r\nOK",
			want: "+15551234567",
		},
		{
			name: "with_alpha",
			resp: "+CNUM: \"Line 1\",\"+15550001111\",145\r\nOK",
			want: "+15550001111",
		},
		{
			name: "missing",
			resp: "OK",
			want: "",
		},
		{
			name: "malformed_single_field",
			resp: "+CNUM: \"\"\r\nOK",
			want: "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := parseCNUM(tt.resp); got != tt.want {
				t.Errorf("parseCNUM(%q) = %q, want %q", tt.resp, got, tt.want)
			}
		})
	}
}

func TestParseIdentityValue(t *testing.T) {
	tests := []struct {
		name   string
		resp   string
		prefix string
		want   string
	}{
		{
			name: "bare_imei",
			resp: "356938035643809\r\nOK",
			want: "356938035643809",
		},
		{
			name: "bare_imsi_skips_ok",
			resp: "\r\n240010000000000\r\nOK\r\n",
			want: "240010000000000",
		},
		{
			name:   "iccid_with_prefix",
			resp:   "+ICCID: 8946071234567890123\r\nOK",
			prefix: "+ICCID:",
			want:   "8946071234567890123",
		},
		{
			name:   "iccid_bare_no_prefix_line",
			resp:   "8946071234567890123\r\nOK",
			prefix: "+ICCID:",
			want:   "8946071234567890123",
		},
		{
			name: "only_status",
			resp: "OK",
			want: "",
		},
		{
			name: "error",
			resp: "ERROR",
			want: "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := parseIdentityValue(tt.resp, tt.prefix); got != tt.want {
				t.Errorf("parseIdentityValue(%q, %q) = %q, want %q", tt.resp, tt.prefix, got, tt.want)
			}
		})
	}
}
