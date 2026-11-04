package client

import (
	"encoding/json"
	"errors"
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
		os.Chmod(dir, 0755)
		if _, e = LoadConfig(path, true); e != nil {
			t.Fatalf("readable config and directory should be accepted: %v", e)
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
	if runtime.GOOS != "windows" {
		if err := os.Chmod(filepath.Join(dir, "identity.json"), 0644); err != nil {
			t.Fatal(err)
		}
	}
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

func TestConfigErrorsIdentifyTheFailingPath(t *testing.T) {
	dir := t.TempDir()
	if err := protectState(dir); err != nil {
		t.Fatal(err)
	}
	missing := filepath.Join(dir, "missing", "config.json")
	if _, err := LoadConfig(missing, false); err == nil || !strings.Contains(err.Error(), "config file") || !strings.Contains(err.Error(), "--config") || !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("missing configuration must identify the file and preserve its cause: %v", err)
	}
	if _, err := LoadConfig(dir, false); err == nil || !strings.Contains(err.Error(), "regular JSON file") {
		t.Fatalf("directory used as configuration: %v", err)
	}
	path := filepath.Join(dir, "config.json")
	write := func(raw any) {
		t.Helper()
		b, err := json.Marshal(raw)
		if err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(path, b, 0600); err != nil {
			t.Fatal(err)
		}
	}
	binary := filepath.Join(dir, "missing-hc.exe")
	write(map[string]any{"server_url": "https://example.com", "key": "hbk_private-test-value", "name": "test", "core": map[string]any{"binary": binary}})
	if _, err := LoadConfig(path, false); err == nil || !strings.Contains(err.Error(), "core.binary executable") || !strings.Contains(err.Error(), "missing-hc.exe") || strings.Contains(err.Error(), "hbk_private-test-value") {
		t.Fatalf("missing core must be distinguished from missing config without logging credentials: %v", err)
	}
	if err := os.WriteFile(path, []byte("{broken"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadConfig(path, false); err == nil || !strings.Contains(err.Error(), "decode config JSON") {
		t.Fatalf("malformed configuration: %v", err)
	}
}
