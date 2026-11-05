package main

import (
	"testing"
)

func TestCommandsWithoutConfig(t *testing.T) {
	for _, command := range []string{"status", "stop"} {
		t.Run(command, func(t *testing.T) {
			if err := run([]string{command, "--state-dir", t.TempDir(), "--config", "/missing/config.json"}); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestInvalidCommandArguments(t *testing.T) {
	for _, args := range [][]string{{"unknown"}, {"start", "unexpected"}, {"--foreground", "--background"}, {"status", "--state-dir", "relative"}} {
		if err := run(args); err == nil {
			t.Fatalf("accepted %v", args)
		}
	}
}
