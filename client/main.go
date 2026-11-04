package main

import (
	"context"
	"flag"
	"fmt"
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
	background := flag.Bool("background", false, "run in background and write logs to state-dir/bridge.log")
	backgroundChild := flag.Bool("background-child", false, "internal background startup handshake")
	flag.Parse()
	c, e := client.LoadConfig(*path, *dev)
	if e != nil {
		slog.Error("configuration rejected", "config", *path, "error", e)
		os.Exit(1)
	}
	if *background && !*backgroundChild {
		pid, logPath, err := client.StartBackground(*path, *dir, *dev)
		if err != nil {
			slog.Error("background startup failed", "error", err)
			os.Exit(1)
		}
		slog.Info("bridge running in background", "pid", pid, "log", logPath)
		return
	}
	id, release, e := client.Identity(*dir)
	if e != nil {
		slog.Error("identity unavailable", "error", e)
		os.Exit(1)
	}
	defer release()
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if *backgroundChild {
		if _, err := fmt.Fprintln(os.Stdout, "ready"); err != nil {
			return
		}
		os.Stdout.Close()
	}
	if e = client.Run(ctx, c, id); e != nil {
		slog.Error("agent stopped", "error", e)
		os.Exit(1)
	}
}
