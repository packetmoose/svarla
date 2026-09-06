package main

import (
	"fmt"
	"strings"
	"time"

	"github.com/packetmoose/svarla/modem-gateway/internal/config"
	"github.com/packetmoose/svarla/modem-gateway/internal/modem"
)

// atCommandList is a flag.Value that collects a repeatable -at flag into an
// ordered slice, so several AT commands can be run in one invocation.
type atCommandList []string

func (a *atCommandList) String() string { return strings.Join(*a, ", ") }

func (a *atCommandList) Set(v string) error {
	*a = append(*a, v)
	return nil
}

// runATCommands opens the modem's AT serial port, sends one or more AT
// commands, prints each response, and exits. It is a self-contained
// diagnostic helper for environments without a serial terminal (screen,
// microcom, etc.) — useful for inspecting modem state such as the PCM
// audio subsystem (AT+CPCMREG?).
//
// It reuses the same serial and AT-command primitives as the running gateway
// (echo filtering, result-code parsing), so responses match what the gateway
// itself would see.
//
// IMPORTANT: the modem-gateway service must NOT be running at the same time —
// it holds the AT port open, and two readers on one serial port produce
// garbled, interleaved output. Stop the service before running this.
//
// portPath is the AT serial device path; if empty, the value from the config
// file (modem.serialPort) is used. cmds is one or more AT command strings
// (without trailing CR/LF).
func runATCommands(portPath, configPath string, cmds []string) error {
	// Resolve the serial port: explicit flag wins, otherwise read the config.
	if strings.TrimSpace(portPath) == "" {
		cfg, err := config.Load(configPath)
		if err != nil {
			return fmt.Errorf("could not determine AT port: %w\n"+
				"Provide one explicitly with -at-port, e.g. -at-port /dev/ttyUSB2", err)
		}
		portPath = cfg.Modem.SerialPort
	}

	fmt.Printf("Opening AT port %s ...\n", portPath)

	// Read timeout keeps reads from blocking forever; baud 0 => 9600 default,
	// matching the gateway's own AT port settings.
	sp, err := modem.OpenSerialPortWithTimeout(portPath, 0, 1*time.Second)
	if err != nil {
		return fmt.Errorf("open AT port %q: %w\n"+
			"Is the modem-gateway service still running? Stop it first so this "+
			"tool can open the port exclusively.", portPath, err)
	}

	m := modem.New(sp)
	m.Open()
	defer func() { _ = m.Close() }()

	// Disable command echo so responses aren't cluttered. Best-effort; some
	// firmware returns ERROR here but still behaves, so ignore the result.
	_, _ = m.SendCommand("ATE0", 3*time.Second)

	for _, cmd := range cmds {
		cmd = strings.TrimSpace(cmd)
		if cmd == "" {
			continue
		}
		fmt.Printf("\n>>> %s\n", cmd)
		resp, err := m.SendCommand(cmd, 5*time.Second)
		if resp = strings.TrimSpace(resp); resp != "" {
			fmt.Println(resp)
		}
		if err != nil {
			// Modem-level errors (ERROR, +CME ERROR, timeout) are printed as
			// the meaningful result of the diagnostic, not treated as fatal —
			// e.g. AT+CPCMREG=0 returning ERROR while idle is itself the signal
			// we want to observe. Keep going through the remaining commands.
			fmt.Printf("[result: %v]\n", err)
		} else {
			fmt.Println("[result: OK]")
		}
	}

	fmt.Println()
	return nil
}
