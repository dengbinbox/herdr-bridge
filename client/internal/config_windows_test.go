//go:build windows

package client

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWindowsConfigPaths(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "中文 config with spaces")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	binary := filepath.Join(dir, "hc.exe")
	// LoadConfig checks the executable path; this test never starts the file.
	if err := os.WriteFile(binary, []byte("path lookup fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "config.json")
	for _, forwardSlashes := range []bool{false, true} {
		name := "backslashes"
		configPath, corePath := path, binary
		if forwardSlashes {
			name = "forward-slashes"
			configPath = filepath.ToSlash(path)
			corePath = filepath.ToSlash(binary)
		}
		t.Run(name, func(t *testing.T) {
			b, err := json.Marshal(map[string]any{"server_url": "https://example.com", "key": "hbk_test", "name": "test", "core": map[string]any{"binary": corePath}})
			if err != nil {
				t.Fatal(err)
			}
			if err = os.WriteFile(path, b, 0600); err != nil {
				t.Fatal(err)
			}
			config, err := LoadConfig(configPath, false)
			if err != nil {
				t.Fatal(err)
			}
			if !strings.EqualFold(config.Core.Binary, binary) {
				t.Fatalf("unexpected executable path: %q", config.Core.Binary)
			}
		})
	}
}
