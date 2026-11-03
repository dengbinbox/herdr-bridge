package client

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestConfigurationAndEnvironment(t *testing.T) {
	exe, e := os.Executable()
	if e != nil {
		t.Fatal(e)
	}
	dir := t.TempDir()
	if e = protectState(dir); e != nil {
		t.Fatal(e)
	}
	path := filepath.Join(dir, "config.json")
	raw := map[string]any{"server_url": "https://example.com", "key": "hbk_placeholder", "name": "test", "core": map[string]any{"binary": exe, "session": "isolated", "socket": nil}}
	b, _ := json.Marshal(raw)
	if e = os.WriteFile(path, b, 0600); e != nil {
		t.Fatal(e)
	}
	c, e := LoadConfig(path, false)
	if e != nil {
		t.Fatal(e)
	}
	t.Setenv("HC_SOCKET", "wrong")
	t.Setenv("HC_SESSION", "wrong")
	t.Setenv("HC_TERMINAL_ID", "parent")
	env := strings.Join(c.environment(), "\n")
	if strings.Contains(env, "HC_SOCKET=") || strings.Contains(env, "HC_TERMINAL_ID=") || !strings.Contains(env, "HC_SESSION=isolated") {
		t.Fatal("inherited wrong core target")
	}
	s := "explicit"
	c.Core.Socket = &s
	if !strings.Contains(strings.Join(c.environment(), "\n"), "HC_SOCKET=explicit") {
		t.Fatal("explicit socket not applied")
	}
	raw["server_url"] = "http://localhost:8080"
	b, _ = json.Marshal(raw)
	os.WriteFile(path, b, 0600)
	if _, e = LoadConfig(path, false); e == nil {
		t.Fatal("HTTP without dev")
	}
	if _, e = LoadConfig(path, true); e != nil {
		t.Fatal(e)
	}
	raw["unknown"] = true
	b, _ = json.Marshal(raw)
	os.WriteFile(path, b, 0600)
	if _, e = LoadConfig(path, true); e == nil {
		t.Fatal("unknown field")
	}
	if runtime.GOOS != "windows" {
		delete(raw, "unknown")
		b, _ = json.Marshal(raw)
		os.WriteFile(path, b, 0600)
		os.Chmod(path, 0644)
		if _, e = LoadConfig(path, true); e == nil {
			t.Fatal("public config")
		}
	}
}
func TestIdentityStableExclusiveAndCorruption(t *testing.T) {
	dir := t.TempDir()
	id, release, e := Identity(dir)
	if e != nil {
		t.Fatal(e)
	}
	if _, _, e = Identity(dir); e == nil {
		t.Fatal("duplicate state lock allowed")
	}
	release()
	again, release, e := Identity(dir)
	if e != nil || id != again {
		t.Fatalf("identity changed: %v", e)
	}
	release()
	os.WriteFile(filepath.Join(dir, "identity.json"), []byte("bad"), 0600)
	if _, _, e = Identity(dir); e == nil {
		t.Fatal("corrupt state accepted")
	}
}
