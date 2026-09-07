package signaling

import "testing"

func TestCSQToPercent(t *testing.T) {
	tests := []struct {
		name string
		csq  int
		want int
	}{
		{"zero", 0, 0},
		{"max", 31, 100},
		{"mid", 16, 52}, // 16/31*100 = 51.6 -> 52
		{"low", 5, 16},  // 5/31*100 = 16.1 -> 16
		{"unknown_99", 99, 0},
		{"negative", -1, 0},
		{"out_of_range_high", 40, 0},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := csqToPercent(tt.csq); got != tt.want {
				t.Errorf("csqToPercent(%d) = %d, want %d", tt.csq, got, tt.want)
			}
		})
	}
}

func TestParseCPSI(t *testing.T) {
	tests := []struct {
		name     string
		resp     string
		wantTech string
		wantBand string
	}{
		{
			name:     "lte",
			resp:     "+CPSI: LTE,Online,240-01,0x000B,12345678,257,EUTRAN-BAND3,1300,5,0,-94,-850,-620,15\r\nOK",
			wantTech: "LTE",
			wantBand: "B3",
		},
		{
			name:     "lte_band_with_space",
			resp:     "+CPSI: LTE,Online,240-01,0x000B,12345678,257,LTE BAND 7,3100,5\r\nOK",
			wantTech: "LTE",
			wantBand: "B7",
		},
		{
			name:     "gsm_no_band_token",
			resp:     "+CPSI: GSM,Online,240-01,0x1234,5678,25,45,-70\r\nOK",
			wantTech: "GSM",
			wantBand: "",
		},
		{
			// Unrecognized band format (e.g. 5G NR) is passed through verbatim,
			// not dropped or uppercase-mangled.
			name:     "unknown_band_format_passthrough",
			resp:     "+CPSI: NR5G_SA,Online,240-01,0x0,123456,257,NR5G-Band78,...\r\nOK",
			wantTech: "NR5G_SA",
			wantBand: "NR5G-Band78",
		},
		{
			name:     "no_service",
			resp:     "+CPSI: NO SERVICE,Online\r\nOK",
			wantTech: "",
			wantBand: "",
		},
		{
			name:     "empty",
			resp:     "OK",
			wantTech: "",
			wantBand: "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tech, band := parseCPSI(tt.resp)
			if tech != tt.wantTech {
				t.Errorf("parseCPSI tech = %q, want %q", tech, tt.wantTech)
			}
			if band != tt.wantBand {
				t.Errorf("parseCPSI band = %q, want %q", band, tt.wantBand)
			}
		})
	}
}

