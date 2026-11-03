package server

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func configFile(t *testing.T, text string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "config.yaml")
	if e := os.WriteFile(p, []byte(text), 0600); e != nil {
		t.Fatal(e)
	}
	return p
}
func TestConfigStrictAndDefaults(t *testing.T) {
	valid := "server:\n  public_url: https://bridge.example.com\n"
	c, e := LoadConfig(configFile(t, valid))
	if e != nil {
		t.Fatal(e)
	}
	if c.Auth.SessionTTL != 24*time.Hour || c.Database.Driver != "postgres" || c.Connections.MaxWSMessageBytes != 1048576 {
		t.Fatal("defaults")
	}
	for _, bad := range []string{valid + "unknown: true\n", valid + "---\nserver: {}\n", valid + "database:\n  driver: sqlite\n", valid + "connections:\n  heartbeat_interval: 0s\n", strings.Replace(valid, "https://bridge.example.com", "https://bridge.example.com/path", 1)} {
		if _, e := LoadConfig(configFile(t, bad)); e == nil {
			t.Fatalf("accepted invalid config %s", bad)
		}
	}
}

func TestHTTPConfigAllowsLANAddresses(t *testing.T) {
	for _, tc := range []struct{ listen, origin string }{
		{"0.0.0.0:58182", "http://192.168.137.106:58182"},
		{"10.20.30.40:8080", "http://10.20.30.40:8080"},
		{":8080", "http://172.16.1.20:8080"},
		{"0.0.0.0:8080", "http://bridge.lan:8080"},
		{"[::]:8080", "http://[fd00::1234]:8080"},
	} {
		t.Run(tc.origin, func(t *testing.T) {
			text := "server:\n  listen: '" + tc.listen + "'\n  public_url: '" + tc.origin + "'\nauth:\n  cookie_secure: false\n"
			c, err := LoadConfig(configFile(t, text))
			if err != nil {
				t.Fatal(err)
			}
			if c.Auth.CookieSecure || c.Server.Listen != tc.listen {
				t.Fatal("HTTP listener configuration was not preserved")
			}
			if len(c.Server.AllowedOrigins) != 1 || c.Server.AllowedOrigins[0] != tc.origin {
				t.Fatal("allowed origin must default to the configured public URL")
			}
		})
	}
}
func TestLocalConfig(t *testing.T) {
	c, e := LoadConfig(configFile(t, "server:\n  listen: 127.0.0.1:8080\n  public_url: http://localhost:8080\nauth:\n  cookie_secure: false\n"))
	if e != nil || c.Auth.CookieSecure {
		t.Fatalf("local mode %v", e)
	}
}
