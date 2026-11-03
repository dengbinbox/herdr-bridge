package main

import (
	"context"
	"flag"
	server "herdr-bridge/server/internal"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
)

func main() {
	path := flag.String("config", "config.yaml", "server YAML configuration")
	flag.Parse()
	c, e := server.LoadConfig(*path)
	if e != nil {
		slog.Error("configuration rejected", "error", e)
		os.Exit(1)
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if e = server.Run(ctx, c); e != nil {
		slog.Error("server stopped", "error", e)
		os.Exit(1)
	}
}
