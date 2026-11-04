package client

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

type Config struct {
	EntryURL  string `json:"entry_url"`
	ServerURL string `json:"server_url"`
	Key       string `json:"key"`
	Name      string `json:"name"`
	Core      struct {
		Binary  string  `json:"binary"`
		Session string  `json:"session"`
		Socket  *string `json:"socket"`
	} `json:"core"`
	Connection struct {
		ReconnectMin int `json:"reconnect_min_seconds"`
		ReconnectMax int `json:"reconnect_max_seconds"`
	} `json:"connection"`
}

func DefaultPaths() (string, string, error) {
	h, e := os.UserHomeDir()
	return filepath.Join(h, ".herdr-bridge", "auth", "config.json"), filepath.Join(h, ".herdr-bridge", "state"), e
}
func LoadConfig(path string, dev bool) (Config, error) {
	var c Config
	c.Connection.ReconnectMin = 1
	c.Connection.ReconnectMax = 600
	c.Core.Session = "default"
	if !filepath.IsAbs(path) {
		return c, fmt.Errorf("config path must be absolute: %q", path)
	}
	// Normalize separators for native file operations.
	path = filepath.Clean(path)
	st, e := os.Stat(path)
	if e != nil {
		if errors.Is(e, os.ErrNotExist) {
			return c, fmt.Errorf("config file %q not found; create this file or select its absolute path with --config: %w", path, e)
		}
		return c, fmt.Errorf("inspect config file %q: %w", path, e)
	}
	if !st.Mode().IsRegular() {
		return c, fmt.Errorf("config path %q must be a regular JSON file", path)
	}
	f, e := os.Open(path)
	if e != nil {
		return c, fmt.Errorf("open config file %q: %w", path, e)
	}
	defer f.Close()
	d := json.NewDecoder(f)
	d.DisallowUnknownFields()
	if e = d.Decode(&c); e != nil {
		return c, fmt.Errorf("decode config JSON %q: %w", path, e)
	}
	var x any
	if d.Decode(&x) != io.EOF {
		return c, fmt.Errorf("decode config JSON %q: trailing config data", path)
	}
	u, e := url.Parse(c.ServerURL)
	if e != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") || (u.Scheme != "https" && !(dev && u.Scheme == "http")) {
		return c, errors.New("server_url requires HTTPS origin; HTTP requires --dev")
	}
	if e := validateEntryURL(c.ServerURL, c.EntryURL); e != nil {
		return c, e
	}
	if !strings.HasPrefix(c.Key, "hbk_") || len(c.Name) < 1 || len(c.Name) > 128 || c.Core.Binary == "" || c.Core.Session == "" || c.Connection.ReconnectMin < 1 || c.Connection.ReconnectMax < c.Connection.ReconnectMin || c.Connection.ReconnectMax > 600 {
		return c, errors.New("invalid client configuration")
	}
	if !filepath.IsAbs(c.Core.Binary) {
		return c, fmt.Errorf("core.binary must be an absolute executable path: %q", c.Core.Binary)
	}
	c.Core.Binary = filepath.Clean(c.Core.Binary)
	binary, e := exec.LookPath(c.Core.Binary)
	if e != nil {
		return c, fmt.Errorf("core.binary executable %q unavailable: %w", c.Core.Binary, e)
	}
	// On Windows LookPath may resolve an omitted .exe extension.
	c.Core.Binary = binary
	return c, nil
}
func (c Config) environment() []string {
	out := []string{}
	for _, v := range os.Environ() {
		k, _, _ := strings.Cut(v, "=")
		switch strings.ToUpper(k) {
		case "HC_SESSION", "HC_SOCKET", "HC_TERMINAL_ID":
			continue
		}
		out = append(out, v)
	}
	out = append(out, "HC_SESSION="+c.Core.Session)
	if c.Core.Socket != nil && *c.Core.Socket != "" {
		out = append(out, "HC_SOCKET="+*c.Core.Socket)
	}
	return out
}
