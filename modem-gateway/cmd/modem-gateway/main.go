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

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)

	go func() {
		sig := <-sigCh
		fmt.Printf("Received signal %s, initiating graceful shutdown...\n", sig)
		cancel()

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
