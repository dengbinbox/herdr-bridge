package client

import (
	"bufio"
	"context"
	"encoding/json"
	"github.com/google/uuid"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestRealCoreDisconnectDoesNotKill(t *testing.T) {
	binary := os.Getenv("HERDR_BRIDGE_TEST_HC")
	if binary == "" {
		t.Skip("set HERDR_BRIDGE_TEST_HC to a pinned hc executable")
	}
	// Use short paths for Unix socket limits and keep all core state inside this module.
	dir, e := os.MkdirTemp("../..", ".core-test-")
	if e != nil {
		t.Fatal(e)
	}
	dir, e = filepath.Abs(dir)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	for _, name := range []string{"state", "config", "run"} {
		if e = os.Mkdir(filepath.Join(dir, name), 0700); e != nil {
			t.Fatal(e)
		}
	}
	t.Setenv("XDG_STATE_HOME", filepath.Join(dir, "state"))
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(dir, "config"))
	t.Setenv("XDG_RUNTIME_DIR", filepath.Join(dir, "run"))
	var cfg Config
	cfg.Core.Binary = binary
	cfg.Core.Session = "hb" + uuid.NewString()[:8]
	socket := filepath.Join(dir, "core.sock")
	cfg.Core.Socket = &socket
	stop := func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, binary, "server", "stop")
		cmd.Env = cfg.environment()
		cmd.Run()
	}
	t.Cleanup(stop)
	open := func() (func(string, any) json.RawMessage, func()) {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		cmd := exec.CommandContext(ctx, binary, "connect")
		cmd.Env = cfg.environment()
		cmd.Stderr = io.Discard
		in, e := cmd.StdinPipe()
		if e != nil {
			t.Fatal(e)
		}
		out, e := cmd.StdoutPipe()
		if e != nil {
			t.Fatal(e)
		}
		if e = cmd.Start(); e != nil {
			t.Fatal(e)
		}
		reader := bufio.NewReader(out)
		nextID := 0
		call := func(method string, params any) json.RawMessage {
			nextID++
			b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": nextID, "method": method, "params": params})
			if _, e = in.Write(append(b, '\n')); e != nil {
				t.Fatal(e)
			}
			line, e := reader.ReadBytes('\n')
			if e != nil {
				t.Fatal(e)
			}
			var reply struct {
				Result json.RawMessage `json:"result"`
				Error  any             `json:"error"`
			}
			if e = json.Unmarshal(line, &reply); e != nil || reply.Error != nil {
				t.Fatalf("core call %s failed", method)
			}
			return reply.Result
		}
		close := func() { in.Close(); cancel(); cmd.Wait() }
		return call, close
	}
	call, close := open()
	call("hello", map[string]any{"generation": 1})
	result := call("terminal.run", map[string]any{"argv": []string{"/bin/sh"}, "env": map[string]string{"ENV": "", "HISTFILE": filepath.Join(dir, "history")}, "no_parent": true, "cwd": dir})
	var terminal struct {
		Address string `json:"address"`
	}
	json.Unmarshal(result, &terminal)
	if terminal.Address == "" {
		close()
		t.Fatal("missing terminal address")
	}
	close()
	call, close = open()
	defer close()
	list := call("terminal.list", map[string]any{})
	var terminals struct {
		Terminals []struct {
			Address string `json:"address"`
			State   string `json:"state"`
		} `json:"terminals"`
	}
	json.Unmarshal(list, &terminals)
	alive := false
	for _, record := range terminals.Terminals {
		if record.Address == terminal.Address && record.State == "live" {
			alive = true
		}
	}
	if !alive {
		t.Fatal("closing hc connect killed the terminal")
	}
	call("terminal.kill", map[string]any{"terminal": terminal.Address})
}
