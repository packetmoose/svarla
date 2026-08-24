package modem

import "go.bug.st/serial"

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
// 115200 baud, 8 data bits, no parity, 1 stop bit (8N1).
func OpenSerialPort(device string) (SerialPort, error) {
	mode := &serial.Mode{
		BaudRate: 115200,
		DataBits: 8,
		Parity:   serial.NoParity,
		StopBits: serial.OneStopBit,
	}

	port, err := serial.Open(device, mode)
	if err != nil {
		return nil, err
	}

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
