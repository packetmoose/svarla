package modem

import (
	"testing"
)

func TestParseCLIP(t *testing.T) {
	tests := []struct {
		name    string
		data    string
		want    CLIPInfo
		wantErr bool
	}{
		{
			name: "international number with type",
			data: `"+15551234567",145,,,"",0`,
			want: CLIPInfo{Number: "+15551234567", Type: 145},
		},
		{
			name: "national number",
			data: `"5551234567",129`,
			want: CLIPInfo{Number: "5551234567", Type: 129},
		},
		{
			name: "number only",
			data: `"+4412345678",145`,
			want: CLIPInfo{Number: "+4412345678", Type: 145},
		},
		{
			name:    "empty data",
			data:    "",
			wantErr: true,
		},
		{
			name:    "no quotes",
			data:    "15551234567,145",
			wantErr: true,
		},
		{
			name:    "unclosed quote",
			data:    `"+15551234567`,
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ParseCLIP(tt.data)
			if tt.wantErr {
				if err == nil {
					t.Errorf("ParseCLIP(%q) expected error, got nil", tt.data)
				}
				return
			}
			if err != nil {
				t.Errorf("ParseCLIP(%q) unexpected error: %v", tt.data, err)
				return
			}
			if got.Number != tt.want.Number {
				t.Errorf("ParseCLIP(%q) number = %q, want %q", tt.data, got.Number, tt.want.Number)
			}
			if got.Type != tt.want.Type {
				t.Errorf("ParseCLIP(%q) type = %d, want %d", tt.data, got.Type, tt.want.Type)
			}
		})
	}
}

func TestParseCMTI(t *testing.T) {
	tests := []struct {
		name    string
		data    string
		want    CMTIInfo
		wantErr bool
	}{
		{
			name: "ME storage index 3",
			data: `"ME",3`,
			want: CMTIInfo{Storage: "ME", Index: 3},
		},
		{
			name: "SM storage index 0",
			data: `"SM",0`,
			want: CMTIInfo{Storage: "SM", Index: 0},
		},
		{
			name: "large index",
			data: `"ME",255`,
			want: CMTIInfo{Storage: "ME", Index: 255},
		},
		{
			name:    "empty data",
			data:    "",
			wantErr: true,
		},
		{
			name:    "missing index",
			data:    `"ME"`,
			wantErr: true,
		},
		{
			name:    "non-numeric index",
			data:    `"ME",abc`,
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ParseCMTI(tt.data)
			if tt.wantErr {
				if err == nil {
					t.Errorf("ParseCMTI(%q) expected error, got nil", tt.data)
				}
				return
			}
			if err != nil {
				t.Errorf("ParseCMTI(%q) unexpected error: %v", tt.data, err)
				return
			}
			if got.Storage != tt.want.Storage {
				t.Errorf("ParseCMTI(%q) storage = %q, want %q", tt.data, got.Storage, tt.want.Storage)
			}
			if got.Index != tt.want.Index {
				t.Errorf("ParseCMTI(%q) index = %d, want %d", tt.data, got.Index, tt.want.Index)
			}
		})
	}
}

func TestParseCUSD(t *testing.T) {
	tests := []struct {
		name    string
		data    string
		want    CUSDInfo
		wantErr bool
	}{
		{
			name: "full response with text and DCS",
			data: `0,"Balance: $5.00",15`,
			want: CUSDInfo{Status: 0, Text: "Balance: $5.00", DCS: 15},
		},
		{
			name: "further action needed",
			data: `1,"Enter option:",0`,
			want: CUSDInfo{Status: 1, Text: "Enter option:", DCS: 0},
		},
		{
			name: "status only",
			data: `2`,
			want: CUSDInfo{Status: 2, Text: "", DCS: 15},
		},
		{
			name: "text without DCS",
			data: `0,"Done"`,
			want: CUSDInfo{Status: 0, Text: "Done", DCS: 15},
		},
		{
			name:    "empty data",
			data:    "",
			wantErr: true,
		},
		{
			name:    "non-numeric status",
			data:    "abc",
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ParseCUSD(tt.data)
			if tt.wantErr {
				if err == nil {
					t.Errorf("ParseCUSD(%q) expected error, got nil", tt.data)
				}
				return
			}
			if err != nil {
				t.Errorf("ParseCUSD(%q) unexpected error: %v", tt.data, err)
				return
			}
			if got.Status != tt.want.Status {
				t.Errorf("ParseCUSD(%q) status = %d, want %d", tt.data, got.Status, tt.want.Status)
			}
			if got.Text != tt.want.Text {
				t.Errorf("ParseCUSD(%q) text = %q, want %q", tt.data, got.Text, tt.want.Text)
			}
			if got.DCS != tt.want.DCS {
				t.Errorf("ParseCUSD(%q) dcs = %d, want %d", tt.data, got.DCS, tt.want.DCS)
			}
		})
	}
}

func TestParseDTMF(t *testing.T) {
	tests := []struct {
		name    string
		data    string
		want    string
		wantErr bool
	}{
		{name: "digit 0", data: "0", want: "0"},
		{name: "digit 5", data: "5", want: "5"},
		{name: "digit 9", data: "9", want: "9"},
		{name: "star", data: "*", want: "*"},
		{name: "hash", data: "#", want: "#"},
		{name: "letter A", data: "A", want: "A"},
		{name: "letter D", data: "D", want: "D"},
		{name: "lowercase a", data: "a", want: "A"},
		{name: "with trailing space", data: "5 ", want: "5"},
		{name: "empty", data: "", wantErr: true},
		{name: "invalid char", data: "X", wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ParseDTMF(tt.data)
			if tt.wantErr {
				if err == nil {
					t.Errorf("ParseDTMF(%q) expected error, got nil", tt.data)
				}
				return
			}
			if err != nil {
				t.Errorf("ParseDTMF(%q) unexpected error: %v", tt.data, err)
				return
			}
			if got != tt.want {
				t.Errorf("ParseDTMF(%q) = %q, want %q", tt.data, got, tt.want)
			}
		})
	}
}

func TestParseCREG(t *testing.T) {
	tests := []struct {
		name    string
		data    string
		want    CREGInfo
		wantErr bool
	}{
		{
			name: "registered home (unsolicited)",
			data: "1",
			want: CREGInfo{Status: 1},
		},
		{
			name: "registered roaming (unsolicited)",
			data: "5",
			want: CREGInfo{Status: 5},
		},
		{
			name: "response format with location",
			data: `2,1,"1A2B","0000CAFE",7`,
			want: CREGInfo{Status: 1},
		},
		{
			name: "searching (response format)",
			data: "0,2",
			want: CREGInfo{Status: 2},
		},
		{
			name: "not registered",
			data: "0,0",
			want: CREGInfo{Status: 0},
		},
		{
			name:    "empty data",
			data:    "",
			wantErr: true,
		},
		{
			name:    "non-numeric",
			data:    "abc",
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ParseCREG(tt.data)
			if tt.wantErr {
				if err == nil {
					t.Errorf("ParseCREG(%q) expected error, got nil", tt.data)
				}
				return
			}
			if err != nil {
				t.Errorf("ParseCREG(%q) unexpected error: %v", tt.data, err)
				return
			}
			if got.Status != tt.want.Status {
				t.Errorf("ParseCREG(%q) status = %d, want %d", tt.data, got.Status, tt.want.Status)
			}
		})
	}
}

func TestParseCDS(t *testing.T) {
	tests := []struct {
		name    string
		data    string
		want    string
		wantErr bool
	}{
		{
			name: "delivery report data",
			data: `6,3,"+15551234567",129,"24/01/15,10:30:00+00","24/01/15,10:30:05+00",0`,
			want: `6,3,"+15551234567",129,"24/01/15,10:30:00+00","24/01/15,10:30:05+00",0`,
		},
		{
			name: "simple report",
			data: "1,2",
			want: "1,2",
		},
		{
			name:    "empty data",
			data:    "",
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ParseCDS(tt.data)
			if tt.wantErr {
				if err == nil {
					t.Errorf("ParseCDS(%q) expected error, got nil", tt.data)
				}
				return
			}
			if err != nil {
				t.Errorf("ParseCDS(%q) unexpected error: %v", tt.data, err)
				return
			}
			if got != tt.want {
				t.Errorf("ParseCDS(%q) = %q, want %q", tt.data, got, tt.want)
			}
		})
	}
}
