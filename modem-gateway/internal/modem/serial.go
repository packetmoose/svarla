package modem

import (
	"time"

	"go.bug.st/serial"
)

// SerialPort abstracts read/write/close operations on a serial port.
// This allows the modem manager to be tested without a real hardware device.
type SerialPort interface {
	Read(p []byte) (n int, err error)
	Write(p []byte) (n int, err error)
	Close() error
}

// serialPortWrapper wraps go.bug.st/serial.Port to satisfy SerialPort.
type serialPortWrapper struct {
	port serial.Port
}

// OpenSerialPort opens a serial port at the given device path with
// the specified baud rate, 8 data bits, no parity, 1 stop bit (8N1).
// If baudRate is 0, defaults to 9600.
// The port's input/output buffers are flushed on open to clear any
// stale data from previous sessions.
func OpenSerialPort(device string, baudRate int) (SerialPort, error) {
	if baudRate == 0 {
		baudRate = 9600
	}
	mode := &serial.Mode{
		BaudRate: baudRate,
		DataBits: 8,
		Parity:   serial.NoParity,
		StopBits: serial.OneStopBit,
	}

	port, err := serial.Open(device, mode)
	if err != nil {
		return nil, err
	}

	// Flush any stale data left in the serial buffers from previous sessions.
	_ = port.ResetInputBuffer()
	_ = port.ResetOutputBuffer()

	return &serialPortWrapper{port: port}, nil
}

// OpenSerialPortWithTimeout opens a serial port with a read timeout.
// Use this for AT command ports where reads should not block forever.
// For streaming ports (PCM audio), use OpenSerialPort without timeout.
func OpenSerialPortWithTimeout(device string, baudRate int, timeout time.Duration) (SerialPort, error) {
	if baudRate == 0 {
		baudRate = 9600
	}
	mode := &serial.Mode{
		BaudRate: baudRate,
		DataBits: 8,
		Parity:   serial.NoParity,
		StopBits: serial.OneStopBit,
	}

	port, err := serial.Open(device, mode)
	if err != nil {
		return nil, err
	}

	if err := port.SetReadTimeout(timeout); err != nil {
		port.Close()
		return nil, err
	}

	// Flush any stale data left in the serial buffers from previous sessions.
	_ = port.ResetInputBuffer()
	_ = port.ResetOutputBuffer()

	return &serialPortWrapper{port: port}, nil
}

func (s *serialPortWrapper) Read(p []byte) (int, error) {
	return s.port.Read(p)
}

func (s *serialPortWrapper) Write(p []byte) (int, error) {
	return s.port.Write(p)
}

func (s *serialPortWrapper) Close() error {
	return s.port.Close()
}
