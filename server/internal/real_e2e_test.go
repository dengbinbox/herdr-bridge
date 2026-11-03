package server

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
)

// This traverses browser WS -> server -> real outbound Go agent -> isolated hc.
// Enable only with both explicit test dependencies; it never selects default core state.
func TestIntegrationRealAgentAndCore(t *testing.T) {
	hc := os.Getenv("HERDR_BRIDGE_TEST_HC")
	if hc == "" {
		t.Skip("set HERDR_BRIDGE_TEST_HC and HERDR_BRIDGE_TEST_DATABASE_URL for the full core chain")
	}
	s, h := testServer(t)
	admin := loginTest(t, h.URL, "admin", "integration-test-password")
	owner := newUser(t, h.URL, admin, "core-owner")
	_, key := keyTest(t, h.URL, owner)
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
	sessionName := "hb" + uuid.NewString()[:8]
	socket := filepath.Join(dir, "c.sock")
	env := []string{}
	for _, v := range os.Environ() {
		name, _, _ := strings.Cut(v, "=")
		switch name {
		case "HC_SESSION", "HC_SOCKET", "HC_TERMINAL_ID", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR":
			continue
		}
		env = append(env, v)
	}
	env = append(env, "HC_SESSION="+sessionName, "HC_SOCKET="+socket, "XDG_STATE_HOME="+filepath.Join(dir, "state"), "XDG_CONFIG_HOME="+filepath.Join(dir, "config"), "XDG_RUNTIME_DIR="+filepath.Join(dir, "run"))
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		stop := exec.CommandContext(ctx, hc, "server", "stop")
		stop.Env = env
		stop.Run()
	})
	exe := filepath.Join(dir, "agent")
	build := exec.Command("go", "build", "-o", exe, "../../client")
	if output, e := build.CombinedOutput(); e != nil {
		t.Fatalf("agent build: %v\n%s", e, output)
	}
	config := map[string]any{"server_url": h.URL, "key": key, "name": "real-e2e", "core": map[string]any{"binary": hc, "session": sessionName, "socket": socket}, "connection": map[string]int{"reconnect_min_seconds": 1, "reconnect_max_seconds": 2}}
	b, _ := json.Marshal(config)
	path := filepath.Join(dir, "config.json")
	if e = os.WriteFile(path, b, 0600); e != nil {
		t.Fatal(e)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	t.Cleanup(cancel)
	agent := exec.CommandContext(ctx, exe, "--dev", "--config", path, "--state-dir", filepath.Join(dir, "identity"))
	agent.Env = env
	agent.Stderr = io.Discard
	if e = agent.Start(); e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { cancel(); agent.Wait() })
	bridgeID := ""
	deadline := time.Now().Add(15 * time.Second)
	for bridgeID == "" {
		s.mu.Lock()
		for id, a := range s.agents {
			if a.core {
				bridgeID = id
			}
		}
		s.mu.Unlock()
		if time.Now().After(deadline) {
			t.Fatal("real agent/core did not become available")
		}
		time.Sleep(20 * time.Millisecond)
	}
	open := func() (*websocket.Conn, *bufio.Reader, io.Writer) {
		c, _, e := websocket.Dial(ctx, strings.Replace(h.URL, "http:", "ws:", 1)+"/ws/v1/bridges/"+bridgeID, &websocket.DialOptions{HTTPHeader: http.Header{"Cookie": []string{owner.cookie.String()}, "Origin": []string{"http://localhost"}}})
		if e != nil {
			t.Fatal(e)
		}
		t.Cleanup(func() { c.CloseNow() })
		stream := websocket.NetConn(ctx, c, websocket.MessageBinary)
		return c, bufio.NewReader(stream), stream
	}
	c, reader, writer := open()
	nextID := 0
	plain := func(method string, params any) json.RawMessage {
		nextID++
		b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": nextID, "method": method, "params": params})
		if _, e = writer.Write(append(b, '\n')); e != nil {
			t.Fatal(e)
		}
		line, e := reader.ReadBytes('\n')
		if e != nil {
			t.Fatal(e)
		}
		return coreResult(t, line)
	}
	plain("hello", map[string]any{"generation": 1, "framed": true})
	sendFrame := func(channel uint32, kind byte, payload []byte) {
		frame := make([]byte, 9+len(payload))
		binary.LittleEndian.PutUint32(frame, channel)
		frame[4] = kind
		binary.LittleEndian.PutUint32(frame[5:], uint32(len(payload)))
		copy(frame[9:], payload)
		if _, e = writer.Write(frame); e != nil {
			t.Fatal(e)
		}
	}
	readFrame := func() (uint32, byte, []byte) {
		head := make([]byte, 9)
		if _, e = io.ReadFull(reader, head); e != nil {
			t.Fatal(e)
		}
		n := binary.LittleEndian.Uint32(head[5:])
		if n > 16<<20 {
			t.Fatal("oversized core frame")
		}
		payload := make([]byte, n)
		if _, e = io.ReadFull(reader, payload); e != nil {
			t.Fatal(e)
		}
		return binary.LittleEndian.Uint32(head), head[4], payload
	}
	call := func(method string, params any) json.RawMessage {
		nextID++
		b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": nextID, "method": method, "params": params})
		sendFrame(0, 0, b)
		for {
			channel, kind, payload := readFrame()
			if channel == 0 && kind == 0 {
				return coreResult(t, payload)
			}
			if channel != 0 && kind == 0 {
				credit := make([]byte, 4)
				binary.LittleEndian.PutUint32(credit, uint32(len(payload)))
				sendFrame(channel, 1, credit)
			}
		}
	}
	result := call("terminal.run", map[string]any{"no_parent": true, "cwd": dir, "argv": []string{"/bin/sh"}, "env": map[string]string{"TERM": "xterm-256color", "ENV": "", "HISTFILE": filepath.Join(dir, "history")}})
	var terminal struct {
		Address string `json:"address"`
	}
	json.Unmarshal(result, &terminal)
	if terminal.Address == "" {
		t.Fatal("terminal.run returned no address")
	}
	result = call("terminal.attach", map[string]any{"terminal": terminal.Address, "cols": 80, "rows": 24})
	var attached struct {
		Channel uint32 `json:"channel"`
	}
	json.Unmarshal(result, &attached)
	if attached.Channel == 0 {
		t.Fatal("missing attach channel")
	}
	size := make([]byte, 4)
	binary.LittleEndian.PutUint16(size, 100)
	binary.LittleEndian.PutUint16(size[2:], 30)
	sendFrame(attached.Channel, 3, size)
	sendFrame(attached.Channel, 0, []byte("printf '%s%s\\n' bridge- e2e\r"))
	var screen bytes.Buffer
	for !strings.Contains(screen.String(), "bridge-e2e") {
		channel, kind, payload := readFrame()
		if channel == attached.Channel && kind == 0 {
			screen.Write(payload)
			if screen.Len() > 1<<20 {
				t.Fatal("expected shell output missing")
			}
			credit := make([]byte, 4)
			binary.LittleEndian.PutUint32(credit, uint32(len(payload)))
			sendFrame(channel, 1, credit)
		}
	}
	c.CloseNow()
	c, reader, writer = open()
	_ = c
	result = plain("terminal.list", map[string]any{})
	var list struct {
		Terminals []struct {
			Address string `json:"address"`
			State   string `json:"state"`
			Cols    int    `json:"cols"`
			Rows    int    `json:"rows"`
		} `json:"terminals"`
	}
	json.Unmarshal(result, &list)
	found := false
	for _, term := range list.Terminals {
		if term.Address == terminal.Address {
			found = term.State == "live" && term.Cols == 100 && term.Rows == 30
		}
	}
	if !found {
		t.Fatal("disconnect killed shell or resize was lost")
	}
	plain("terminal.kill", map[string]any{"terminal": terminal.Address})
}
func coreResult(t *testing.T, b []byte) json.RawMessage {
	t.Helper()
	var reply struct {
		Result json.RawMessage `json:"result"`
		Error  any             `json:"error"`
	}
	if e := json.Unmarshal(b, &reply); e != nil || reply.Error != nil {
		t.Fatalf("core RPC failed: %s", b)
	}
	return reply.Result
}
