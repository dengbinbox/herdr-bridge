package main

import (
	"context"
	"flag"
	client "herdr-bridge/client/internal"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
)

func main() {
	config, state, e := client.DefaultPaths()
	if e != nil {
		slog.Error("home directory unavailable")
		os.Exit(1)
	}
	path := flag.String("config", config, "absolute path to agent JSON configuration")
	dir := flag.String("state-dir", state, "absolute path to identity state directory")
	dev := flag.Bool("dev", false, "explicitly allow insecure HTTP development server")
	flag.Parse()
	c, e := client.LoadConfig(*path, *dev)
	if e != nil {
		slog.Error("configuration rejected", "error", e)
		os.Exit(1)
	}
	id, release, e := client.Identity(*dir)
	if e != nil {
		slog.Error("identity unavailable", "error", e)
		os.Exit(1)
	}
	defer release()
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if e = client.Run(ctx, c, id); e != nil {
		slog.Error("agent stopped", "error", e)
		os.Exit(1)
	}
}
