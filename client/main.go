package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	client "herdr-bridge/client/internal"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		slog.Error("bridge command failed", "error", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	config, state, err := client.DefaultPaths()
	if err != nil {
		return err
	}
	command := "start"
	if len(args) > 0 && len(args[0]) > 0 && args[0][0] != '-' {
		command, args = args[0], args[1:]
	}
	switch command {
	case "start", "stop", "restart", "status":
	default:
		return fmt.Errorf("unknown command %q (use start, stop, restart, status)", command)
	}
	flags := flag.NewFlagSet("herdr-bridge", flag.ContinueOnError)
	flags.Usage = func() {
		fmt.Fprintln(flags.Output(), "Usage: herdr-bridge [start|stop|restart|status] [options]\nDefaults to start in background; use --foreground to run in the terminal.")
		flags.PrintDefaults()
	}
	path := flags.String("config", config, "absolute path to agent JSON configuration")
	dir := flags.String("state-dir", state, "absolute path to identity state directory")
	dev := flags.Bool("dev", false, "explicitly allow insecure HTTP development server")
	background := flags.Bool("background", false, "run in background (default; compatibility option)")
	foreground := flags.Bool("foreground", false, "run in foreground instead of background")
	backgroundChild := flags.Bool("background-child", false, "internal background startup handshake")
	if err = flags.Parse(args); errors.Is(err, flag.ErrHelp) {
		return nil
	} else if err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return fmt.Errorf("unexpected arguments: %v; put the command before options", flags.Args())
	}
	if *foreground && *background {
		return errors.New("--foreground and --background cannot be combined")
	}
	if !filepath.IsAbs(*dir) {
		return errors.New("state directory must be absolute")
	}
	if command == "stop" {
		if err = client.Stop(*dir); err != nil {
			return err
		}
		fmt.Println("bridge stopped")
		return nil
	}
	if command == "status" {
		info, err := client.Status(*dir)
		if errors.Is(err, client.ErrNotRunning) {
			fmt.Println("bridge stopped")
			return nil
		}
		if err != nil {
			return err
		}
		fmt.Printf("bridge running\npid: %d\nconfig: %s\n", info.PID, info.Config)
		if info.Background {
			fmt.Printf("mode: background\nlog: %s\n", filepath.Join(*dir, "bridge.log"))
		} else {
			fmt.Println("mode: foreground\nlog: terminal")
		}
		return nil
	}
	if command == "restart" {
		info, err := client.Status(*dir)
		if err != nil && !errors.Is(err, client.ErrNotRunning) {
			return err
		}
		if err == nil {
			explicit := map[string]bool{}
			flags.Visit(func(f *flag.Flag) { explicit[f.Name] = true })
			if !explicit["config"] {
				*path = info.Config
			}
			if !explicit["dev"] {
				*dev = info.Dev
			}
		}
	}
	c, err := client.LoadConfig(*path, *dev)
	if err != nil {
		return fmt.Errorf("configuration rejected (%s): %w", *path, err)
	}
	if command == "restart" {
		if err = client.Stop(*dir); err != nil {
			return err
		}
	}
	if !*foreground && !*backgroundChild {
		pid, logPath, err := client.StartBackground(*path, *dir, *dev)
		if err != nil {
			return err
		}
		slog.Info("bridge running in background", "pid", pid, "log", logPath)
		return nil
	}
	id, release, err := client.Identity(*dir)
	if err != nil {
		return err
	}
	defer release()
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	closeControl, err := client.StartControl(*dir, *path, *dev, *backgroundChild, cancel)
	if err != nil {
		return err
	}
	defer closeControl()
	if *backgroundChild {
		if _, err = fmt.Fprintln(os.Stdout, "ready"); err != nil {
			return err
		}
		os.Stdout.Close()
	}
	return client.Run(ctx, c, id)
}
