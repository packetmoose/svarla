package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/packetmoose/svarla/modem-gateway/internal/config"
	"github.com/packetmoose/svarla/modem-gateway/internal/shutdown"
)

// Build-time variables set via ldflags.
var (
	version   = "dev"
	commit    = "unknown"
	buildDate = "unknown"
)

func main() {
	showVersion := flag.Bool("version", false, "Print version information and exit")
	generateConfig := flag.Bool("generate-config", false, "Generate a default configuration file and exit")
	configPath := flag.String("config", "./modem-gateway.yaml", "Path to configuration file")
	flag.Parse()

	if *showVersion {
		fmt.Printf("modem-gateway %s (commit: %s, built: %s)\n", version, commit, buildDate)
		os.Exit(0)
	}

	if *generateConfig {
		if err := config.GenerateDefault(*configPath); err != nil {
			fmt.Fprintf(os.Stderr, "Error generating config: %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("Default configuration written to %s\n", *configPath)
		fmt.Println("Edit the file to set your connection endpoint and modem serial port, then start the binary.")
		os.Exit(0)
	}

	// Set up signal handling for graceful shutdown (SIGTERM, SIGINT).
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)

	go func() {
		sig := <-sigCh
		fmt.Printf("Received signal %s, initiating graceful shutdown...\n", sig)
		cancel()

		// Force-exit after 10 seconds if graceful shutdown does not complete.
		time.AfterFunc(10*time.Second, func() {
			fmt.Fprintln(os.Stderr, "Graceful shutdown timed out after 10s, forcing exit")
			os.Exit(1)
		})
	}()

	if err := run(ctx, *configPath); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}

// run is the main application entrypoint. It loads configuration, initializes
// subsystems, and blocks until the context is cancelled (via signal).
func run(ctx context.Context, configPath string) error {
	cfg, err := config.Load(configPath)
	if err != nil {
		return err
	}

	// Config loaded successfully - will be used by subsystems.
	_ = cfg

	// TODO: Initialize identity, modem, signaling, audio, buffers.

	// Set up the shutdown coordinator with subsystem references.
	// As subsystems are initialized, they should be passed to the coordinator.
	shutdownCoord := shutdown.NewCoordinator(shutdown.CoordinatorConfig{
		// CallTerminator:   callManager,    // TODO: wire when call manager is initialized
		// SMSBuffer:        smsBuffer,      // TODO: wire when SMS buffer is initialized
		// MissedCallBuffer: missedCallBuf,  // TODO: wire when missed call buffer is initialized
		// SignalingClient:   sigClient,     // TODO: wire when signaling client is initialized
		// Modem:            mdm,           // TODO: wire when modem is initialized
	})

	// Block until shutdown signal.
	<-ctx.Done()

	// Perform graceful shutdown with the remaining time before force-exit.
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 9*time.Second)
	defer shutdownCancel()

	if err := shutdownCoord.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("shutdown: %w", err)
	}

	return nil
}
