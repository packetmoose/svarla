package modem

import (
	"fmt"
	"strconv"
	"strings"
)

// CLIPInfo holds parsed caller ID information from a +CLIP URC.
type CLIPInfo struct {
	// Number is the caller's phone number (may be in international format).
	Number string
	// Type is the numbering plan (145 = international, 129 = national/unknown).
	Type int
}

// CMTIInfo holds parsed SMS arrival notification data from a +CMTI URC.
type CMTIInfo struct {
	// Storage is the memory location (e.g. "ME", "SM").
	Storage string
	// Index is the message index in the storage.
	Index int
}

// CUSDInfo holds parsed USSD response data from a +CUSD URC.
type CUSDInfo struct {
	// Status: 0=no further action, 1=further action needed, 2=terminated, 3=other local client responded, 4=not supported, 5=timeout
	Status int
	// Text is the USSD response text (may be empty).
	Text string
	// DCS is the data coding scheme (default 15 = unspecified).
	DCS int
}

// CREGInfo holds parsed network registration status from a +CREG URC.
type CREGInfo struct {
	// Status: 0=not registered, 1=registered home, 2=searching, 3=denied, 4=unknown, 5=registered roaming
	Status int
}

// ParseCLIP extracts caller number and type from +CLIP URC data.
// Expected format: "<number>",<type>[,<subaddr>,<satype>[,<alpha>[,<CLI validity>]]]
// Example: "+15551234567",145,,,"",0
func ParseCLIP(data string) (CLIPInfo, error) {
	data = strings.TrimSpace(data)
	if data == "" {
		return CLIPInfo{}, fmt.Errorf("modem: empty +CLIP data")
	}

	// Find the number between quotes.
	start := strings.Index(data, "\"")
	if start < 0 {
		return CLIPInfo{}, fmt.Errorf("modem: +CLIP missing opening quote")
	}
	end := strings.Index(data[start+1:], "\"")
	if end < 0 {
		return CLIPInfo{}, fmt.Errorf("modem: +CLIP missing closing quote")
	}
	number := data[start+1 : start+1+end]

	// Parse the type field after the closing quote.
	remainder := data[start+1+end+1:]
	remainder = strings.TrimLeft(remainder, ",")
	numType := 129 // default: national/unknown
	if remainder != "" {
		parts := strings.SplitN(remainder, ",", 2)
		if t, err := strconv.Atoi(strings.TrimSpace(parts[0])); err == nil {
			numType = t
		}
	}

	return CLIPInfo{Number: number, Type: numType}, nil
}

// ParseCMTI extracts storage and index from +CMTI URC data.
// Expected format: "<storage>",<index>
// Example: "ME",3
func ParseCMTI(data string) (CMTIInfo, error) {
	data = strings.TrimSpace(data)
	if data == "" {
		return CMTIInfo{}, fmt.Errorf("modem: empty +CMTI data")
	}

	// Find storage between quotes.
	start := strings.Index(data, "\"")
	if start < 0 {
		return CMTIInfo{}, fmt.Errorf("modem: +CMTI missing opening quote")
	}
	end := strings.Index(data[start+1:], "\"")
	if end < 0 {
		return CMTIInfo{}, fmt.Errorf("modem: +CMTI missing closing quote")
	}
	storage := data[start+1 : start+1+end]

	// Parse the index after the closing quote.
	remainder := data[start+1+end+1:]
	remainder = strings.TrimLeft(remainder, ",")
	remainder = strings.TrimSpace(remainder)
	if remainder == "" {
		return CMTIInfo{}, fmt.Errorf("modem: +CMTI missing index")
	}
	index, err := strconv.Atoi(remainder)
	if err != nil {
		return CMTIInfo{}, fmt.Errorf("modem: +CMTI invalid index %q: %w", remainder, err)
	}

	return CMTIInfo{Storage: storage, Index: index}, nil
}

// ParseCUSD extracts status, text, and DCS from +CUSD URC data.
// Expected format: <status>[,"<text>"[,<dcs>]]
// Example: 0,"Balance: $5.00",15
func ParseCUSD(data string) (CUSDInfo, error) {
	data = strings.TrimSpace(data)
	if data == "" {
		return CUSDInfo{}, fmt.Errorf("modem: empty +CUSD data")
	}

	// Parse status (first field before comma or quote).
	statusEnd := strings.IndexAny(data, ",\"")
	statusStr := data
	if statusEnd >= 0 {
		statusStr = data[:statusEnd]
	}
	status, err := strconv.Atoi(strings.TrimSpace(statusStr))
	if err != nil {
		return CUSDInfo{}, fmt.Errorf("modem: +CUSD invalid status %q: %w", statusStr, err)
	}

	info := CUSDInfo{Status: status, DCS: 15}

	// Parse optional text between quotes.
	quoteStart := strings.Index(data, "\"")
	if quoteStart < 0 {
		return info, nil
	}
	quoteEnd := strings.Index(data[quoteStart+1:], "\"")
	if quoteEnd < 0 {
		return info, nil
	}
	info.Text = data[quoteStart+1 : quoteStart+1+quoteEnd]

	// Parse optional DCS after closing quote.
	remainder := data[quoteStart+1+quoteEnd+1:]
	remainder = strings.TrimLeft(remainder, ",")
	remainder = strings.TrimSpace(remainder)
	if remainder != "" {
		if dcs, err := strconv.Atoi(remainder); err == nil {
			info.DCS = dcs
		}
	}

	return info, nil
}

// ParseDTMF extracts the DTMF digit from +DTMF URC data.
// Expected format: <digit> (single character: 0-9, *, #, A-D)
// Example: 5
func ParseDTMF(data string) (string, error) {
	data = strings.TrimSpace(data)
	if data == "" {
		return "", fmt.Errorf("modem: empty +DTMF data")
	}

	// The digit is typically the first character.
	digit := string(data[0])

	// Validate it's a valid DTMF digit.
	valid := "0123456789*#ABCD"
	if !strings.Contains(valid, strings.ToUpper(digit)) {
		return "", fmt.Errorf("modem: +DTMF invalid digit %q", digit)
	}

	return strings.ToUpper(digit), nil
}

// ParseCREG extracts the registration status from +CREG URC data.
// Expected format: <stat> or <n>,<stat>[,<lac>,<ci>[,<AcT>]]
// Example: 1 or 2,1,"1A2B","0000CAFE",7
func ParseCREG(data string) (CREGInfo, error) {
	data = strings.TrimSpace(data)
	if data == "" {
		return CREGInfo{}, fmt.Errorf("modem: empty +CREG data")
	}

	parts := strings.SplitN(data, ",", 3)

	var statusStr string
	if len(parts) == 1 {
		// Unsolicited format: just <stat>
		statusStr = parts[0]
	} else {
		// Response format: <n>,<stat>[,...] — status is second field
		statusStr = strings.TrimSpace(parts[1])
	}

	status, err := strconv.Atoi(strings.TrimSpace(statusStr))
	if err != nil {
		return CREGInfo{}, fmt.Errorf("modem: +CREG invalid status %q: %w", statusStr, err)
	}

	return CREGInfo{Status: status}, nil
}

// ParseCDS extracts the delivery status report from +CDS URC data.
// The format varies by modem; in text mode it may be a multi-line response.
// We return the raw data for higher-level processing.
// Example: 6,3,"+15551234567",129,"24/01/15,10:30:00+00","24/01/15,10:30:05+00",0
func ParseCDS(data string) (string, error) {
	data = strings.TrimSpace(data)
	if data == "" {
		return "", fmt.Errorf("modem: empty +CDS data")
	}
	return data, nil
}
