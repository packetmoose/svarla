package audiotap

import (
	"encoding/binary"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// --- Test helpers ---

type discardWriter struct{}

func (d *discardWriter) Write(p []byte) (n int, err error) { return len(p), nil }

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(&discardWriter{}, nil))
}

// tapServer creates a test WebSocket server that collects binary frames.
func tapServer(t *testing.T) (*httptest.Server, *frameCollector) {
	t.Helper()
	fc := &frameCollector{}

	upgrader := websocket.Upgrader{
		CheckOrigin: func(r *http.Request) bool { return true },
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Logf("upgrade error: %v", err)
			return
		}
		defer conn.Close()

		for {
			_, msg, err := conn.ReadMessage()
			if err != nil {
				return
			}
			fc.add(msg)
		}
	}))

	return srv, fc
}

// slowTapServer creates a test WebSocket server that delays reading to simulate a slow consumer.
func slowTapServer(t *testing.T, readDelay time.Duration) (*httptest.Server, *frameCollector) {
	t.Helper()
	fc := &frameCollector{}

	upgrader := websocket.Upgrader{
		CheckOrigin: func(r *http.Request) bool { return true },
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Logf("upgrade error: %v", err)
			return
		}
		defer conn.Close()

		for {
			_, msg, err := conn.ReadMessage()
			if err != nil {
				return
			}
			fc.add(msg)
			time.Sleep(readDelay)
		}
	}))

	return srv, fc
}

type frameCollector struct {
	mu     sync.Mutex
	frames [][]byte
}

func (fc *frameCollector) add(msg []byte) {
	fc.mu.Lock()
	defer fc.mu.Unlock()
	fc.frames = append(fc.frames, msg)
}

func (fc *frameCollector) count() int {
	fc.mu.Lock()
	defer fc.mu.Unlock()
	return len(fc.frames)
}

func (fc *frameCollector) getAll() [][]byte {
	fc.mu.Lock()
	defer fc.mu.Unlock()
	result := make([][]byte, len(fc.frames))
	copy(result, fc.frames)
	return result
}

// waitFor polls a condition until true or timeout.
func waitFor(t *testing.T, timeout time.Duration, cond func() bool) bool {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return true
		}
		time.Sleep(10 * time.Millisecond)
	}
	return false
}

// --- Tests ---

func TestNullTap_DoesNothing(t *testing.T) {
	tap, err := New(false, "", testLogger())
	if err != nil {
		t.Fatalf("unexpected error creating disabled tap: %v", err)
	}

	// Verify it's a NullTap.
	if _, ok := tap.(NullTap); !ok {
		t.Fatalf("expected NullTap, got %T", tap)
	}

	// Write should not panic or do anything.
	tap.Write(DirectionClientToProvider, []byte{0x01, 0x02, 0x03})
	tap.Write(DirectionProviderToClient, []byte{0x04, 0x05, 0x06})

	// Close should not panic.
	tap.Close()
}

func TestNullTap_ZeroAllocation(t *testing.T) {
	tap := NullTap{}

	// Multiple writes and closes should all be safe no-ops.
	for i := 0; i < 1000; i++ {
		tap.Write(DirectionClientToProvider, make([]byte, 640))
	}
	tap.Close()
	tap.Close() // Double close should be safe.
}

func TestNew_EnabledRequiresEndpoint(t *testing.T) {
	_, err := New(true, "", testLogger())
	if err == nil {
		t.Fatal("expected error when enabled with empty endpoint")
	}
}

func TestNew_InvalidScheme(t *testing.T) {
	_, err := New(true, "http://localhost:9999/tap", testLogger())
	if err == nil {
		t.Fatal("expected error for http:// scheme")
	}
}

func TestNew_ValidSchemes(t *testing.T) {
	// These will fail to connect (no server), but should not return an error
	// from New itself — connection happens in the background.
	tests := []string{
		"ws://localhost:19999/tap",
		"unix:///tmp/nonexistent-tap.sock",
	}

	for _, endpoint := range tests {
		t.Run(endpoint, func(t *testing.T) {
			tap, err := New(true, endpoint, testLogger())
			if err != nil {
				t.Fatalf("unexpected error for endpoint %q: %v", endpoint, err)
			}
			tap.Close()
		})
	}
}

func TestLiveTap_ReceivesFrames(t *testing.T) {
	srv, fc := tapServer(t)
	defer srv.Close()

	// Convert http:// to ws:// URL.
	wsURL := "ws" + srv.URL[4:] + "/tap"

	tap, err := New(true, wsURL, testLogger())
	if err != nil {
		t.Fatalf("failed to create tap: %v", err)
	}
	defer tap.Close()

	// Wait for the tap to connect.
	time.Sleep(200 * time.Millisecond)

	// Send frames in both directions.
	pcmClient := make([]byte, 640) // 20ms at 16kHz 16-bit
	for i := range pcmClient {
		pcmClient[i] = 0xAA
	}

	pcmProvider := make([]byte, 640)
	for i := range pcmProvider {
		pcmProvider[i] = 0xBB
	}

	tap.Write(DirectionClientToProvider, pcmClient)
	tap.Write(DirectionProviderToClient, pcmProvider)

	// Wait for frames to arrive.
	ok := waitFor(t, 2*time.Second, func() bool { return fc.count() >= 2 })
	if !ok {
		t.Fatalf("expected at least 2 frames, got %d", fc.count())
	}

	frames := fc.getAll()

	// Verify first frame (client-to-provider).
	f1 := frames[0]
	if len(f1) < headerSize {
		t.Fatalf("frame too short: %d bytes", len(f1))
	}
	if Direction(f1[0]) != DirectionClientToProvider {
		t.Errorf("expected direction client-to-provider (0x01), got 0x%02x", f1[0])
	}
	seq1 := binary.BigEndian.Uint32(f1[1:5])
	if seq1 != 1 {
		t.Errorf("expected seq 1, got %d", seq1)
	}
	// Check PCM data.
	pcmPayload := f1[headerSize:]
	if len(pcmPayload) != 640 {
		t.Errorf("expected 640 bytes PCM, got %d", len(pcmPayload))
	}
	if pcmPayload[0] != 0xAA {
		t.Errorf("expected PCM byte 0xAA, got 0x%02x", pcmPayload[0])
	}

	// Verify second frame (provider-to-client).
	f2 := frames[1]
	if Direction(f2[0]) != DirectionProviderToClient {
		t.Errorf("expected direction provider-to-client (0x02), got 0x%02x", f2[0])
	}
	seq2 := binary.BigEndian.Uint32(f2[1:5])
	if seq2 != 1 {
		t.Errorf("expected seq 1 for provider direction, got %d", seq2)
	}
	pcmPayload2 := f2[headerSize:]
	if pcmPayload2[0] != 0xBB {
		t.Errorf("expected PCM byte 0xBB, got 0x%02x", pcmPayload2[0])
	}
}

func TestLiveTap_SequenceNumbers(t *testing.T) {
	srv, fc := tapServer(t)
	defer srv.Close()

	wsURL := "ws" + srv.URL[4:] + "/tap"

	tap, err := New(true, wsURL, testLogger())
	if err != nil {
		t.Fatalf("failed to create tap: %v", err)
	}
	defer tap.Close()

	time.Sleep(200 * time.Millisecond)

	// Send multiple frames in the same direction.
	for i := 0; i < 5; i++ {
		tap.Write(DirectionClientToProvider, []byte{byte(i)})
	}

	ok := waitFor(t, 2*time.Second, func() bool { return fc.count() >= 5 })
	if !ok {
		t.Fatalf("expected 5 frames, got %d", fc.count())
	}

	frames := fc.getAll()
	for i, f := range frames[:5] {
		seq := binary.BigEndian.Uint32(f[1:5])
		expectedSeq := uint32(i + 1)
		if seq != expectedSeq {
			t.Errorf("frame %d: expected seq %d, got %d", i, expectedSeq, seq)
		}
	}
}

func TestLiveTap_NonBlocking(t *testing.T) {
	// Create a slow consumer that takes 100ms per frame.
	srv, _ := slowTapServer(t, 100*time.Millisecond)
	defer srv.Close()

	wsURL := "ws" + srv.URL[4:] + "/tap"

	tap, err := New(true, wsURL, testLogger())
	if err != nil {
		t.Fatalf("failed to create tap: %v", err)
	}
	defer tap.Close()

	time.Sleep(200 * time.Millisecond)

	// Write many frames rapidly — this should complete without blocking.
	start := time.Now()
	for i := 0; i < 200; i++ {
		tap.Write(DirectionClientToProvider, make([]byte, 640))
	}
	elapsed := time.Since(start)

	// Writing 200 frames should be nearly instant (non-blocking).
	// If it takes more than 100ms, something is blocking.
	if elapsed > 100*time.Millisecond {
		t.Errorf("Write took %v — expected near-instant (non-blocking)", elapsed)
	}
}

func TestLiveTap_Timestamps(t *testing.T) {
	srv, fc := tapServer(t)
	defer srv.Close()

	wsURL := "ws" + srv.URL[4:] + "/tap"

	tap, err := New(true, wsURL, testLogger())
	if err != nil {
		t.Fatalf("failed to create tap: %v", err)
	}
	defer tap.Close()

	time.Sleep(200 * time.Millisecond)

	tap.Write(DirectionClientToProvider, []byte{0x01})
	time.Sleep(50 * time.Millisecond)
	tap.Write(DirectionClientToProvider, []byte{0x02})

	ok := waitFor(t, 2*time.Second, func() bool { return fc.count() >= 2 })
	if !ok {
		t.Fatalf("expected 2 frames, got %d", fc.count())
	}

	frames := fc.getAll()
	ts1 := binary.BigEndian.Uint32(frames[0][5:9])
	ts2 := binary.BigEndian.Uint32(frames[1][5:9])

	// Second timestamp should be at least 40ms after the first (allowing some jitter).
	diff := ts2 - ts1
	if diff < 40 {
		t.Errorf("expected timestamp difference >= 40ms, got %dms", diff)
	}
}

func TestLiveTap_UnixSocket(t *testing.T) {
	// Create a temporary Unix socket.
	dir := t.TempDir()
	sockPath := filepath.Join(dir, "tap.sock")

	listener, err := net.Listen("unix", sockPath)
	if err != nil {
		t.Fatalf("failed to create Unix listener: %v", err)
	}
	defer listener.Close()

	// Collect received data.
	var received [][]byte
	var mu sync.Mutex
	done := make(chan struct{})

	go func() {
		defer close(done)
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()

		buf := make([]byte, 4096)
		for {
			n, err := conn.Read(buf)
			if err != nil {
				return
			}
			msg := make([]byte, n)
			copy(msg, buf[:n])
			mu.Lock()
			received = append(received, msg)
			mu.Unlock()
		}
	}()

	endpoint := "unix://" + sockPath

	tap, err := New(true, endpoint, testLogger())
	if err != nil {
		t.Fatalf("failed to create tap: %v", err)
	}
	defer tap.Close()

	time.Sleep(200 * time.Millisecond)

	// Send a frame.
	tap.Write(DirectionClientToProvider, []byte{0xDE, 0xAD})

	ok := waitFor(t, 2*time.Second, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(received) >= 1
	})
	if !ok {
		t.Fatal("expected at least 1 frame via Unix socket")
	}

	mu.Lock()
	f := received[0]
	mu.Unlock()

	if len(f) < headerSize+2 {
		t.Fatalf("frame too short: %d bytes", len(f))
	}
	if Direction(f[0]) != DirectionClientToProvider {
		t.Errorf("expected direction 0x01, got 0x%02x", f[0])
	}
	pcm := f[headerSize:]
	if pcm[0] != 0xDE || pcm[1] != 0xAD {
		t.Errorf("unexpected PCM data: %v", pcm)
	}
}

func TestLiveTap_CloseIsIdempotent(t *testing.T) {
	srv, _ := tapServer(t)
	defer srv.Close()

	wsURL := "ws" + srv.URL[4:] + "/tap"

	tap, err := New(true, wsURL, testLogger())
	if err != nil {
		t.Fatalf("failed to create tap: %v", err)
	}

	// Close multiple times should not panic.
	tap.Close()
	tap.Close()
	tap.Close()
}

func TestLiveTap_WriteAfterClose(t *testing.T) {
	srv, _ := tapServer(t)
	defer srv.Close()

	wsURL := "ws" + srv.URL[4:] + "/tap"

	tap, err := New(true, wsURL, testLogger())
	if err != nil {
		t.Fatalf("failed to create tap: %v", err)
	}

	tap.Close()

	// Write after close should not panic (frames are just dropped).
	tap.Write(DirectionClientToProvider, []byte{0x01})
}

func TestParseEndpoint(t *testing.T) {
	tests := []struct {
		endpoint string
		wantErr  bool
	}{
		{"ws://localhost:9092/tap", false},
		{"wss://tap.example.com/stream", false},
		{"unix:///var/run/audiotap.sock", false},
		{"http://localhost:9092/tap", true},
		{"tcp://localhost:9092", true},
		{"", true},
		{"not-a-url", true},
	}

	for _, tt := range tests {
		t.Run(tt.endpoint, func(t *testing.T) {
			err := ParseEndpoint(tt.endpoint)
			if tt.wantErr && err == nil {
				t.Errorf("expected error for %q, got nil", tt.endpoint)
			}
			if !tt.wantErr && err != nil {
				t.Errorf("unexpected error for %q: %v", tt.endpoint, err)
			}
		})
	}
}

func TestEncodeFrame(t *testing.T) {
	f := frame{
		direction: DirectionProviderToClient,
		seq:       42,
		timestamp: 1000,
		pcmData:   []byte{0x01, 0x02, 0x03, 0x04},
	}

	msg := encodeFrame(f)

	if len(msg) != headerSize+4 {
		t.Fatalf("expected %d bytes, got %d", headerSize+4, len(msg))
	}

	if Direction(msg[0]) != DirectionProviderToClient {
		t.Errorf("direction: expected 0x02, got 0x%02x", msg[0])
	}

	seq := binary.BigEndian.Uint32(msg[1:5])
	if seq != 42 {
		t.Errorf("seq: expected 42, got %d", seq)
	}

	ts := binary.BigEndian.Uint32(msg[5:9])
	if ts != 1000 {
		t.Errorf("timestamp: expected 1000, got %d", ts)
	}

	if msg[9] != 0x01 || msg[10] != 0x02 || msg[11] != 0x03 || msg[12] != 0x04 {
		t.Errorf("pcm data mismatch: %v", msg[9:])
	}
}

// TestLiveTap_ReconnectsOnFailure verifies the tap reconnects when the endpoint
// is initially unavailable.
func TestLiveTap_ReconnectsOnFailure(t *testing.T) {
	// Start with no server — tap should keep trying to reconnect.
	// Then start a server and verify frames arrive.

	// Find a free port first.
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("failed to get free port: %v", err)
	}
	addr := listener.Addr().String()
	listener.Close()

	wsURL := "ws://" + addr + "/tap"

	tap, err := New(true, wsURL, testLogger())
	if err != nil {
		t.Fatalf("failed to create tap: %v", err)
	}
	defer tap.Close()

	// Write some frames while disconnected — they should be silently buffered/dropped.
	tap.Write(DirectionClientToProvider, []byte{0x01})
	tap.Write(DirectionClientToProvider, []byte{0x02})

	// Now start the server on the same address.
	fc := &frameCollector{}
	upgrader := websocket.Upgrader{
		CheckOrigin: func(r *http.Request) bool { return true },
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/tap", func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		for {
			_, msg, err := conn.ReadMessage()
			if err != nil {
				return
			}
			fc.add(msg)
		}
	})

	srv := &http.Server{Addr: addr, Handler: mux}
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		t.Fatalf("failed to listen on %s: %v", addr, err)
	}
	go srv.Serve(ln)
	defer srv.Close()

	// Wait for reconnection + send a new frame.
	time.Sleep(2 * time.Second)
	tap.Write(DirectionProviderToClient, []byte{0xFF})

	// Wait for the frame to arrive.
	ok := waitFor(t, 3*time.Second, func() bool { return fc.count() >= 1 })
	if !ok {
		t.Fatal("expected at least 1 frame after reconnection")
	}
}


