package client

import (
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

type Config struct {
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
	c.Connection.ReconnectMax = 30
	c.Core.Session = "default"
	if !filepath.IsAbs(path) {
		return c, errors.New("config path must be absolute")
	}
	if e := checkPrivate(path); e != nil {
		return c, e
	}
	if e := checkPrivate(filepath.Dir(path)); e != nil {
		return c, e
	}
	f, e := os.Open(path)
	if e != nil {
		return c, e
	}
	defer f.Close()
	d := json.NewDecoder(f)
	d.DisallowUnknownFields()
	if e = d.Decode(&c); e != nil {
		return c, e
	}
	var x any
	if d.Decode(&x) != io.EOF {
		return c, errors.New("trailing config data")
	}
	u, e := url.Parse(c.ServerURL)
	if e != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") || (u.Scheme != "https" && !(dev && u.Scheme == "http")) {
		return c, errors.New("server_url requires HTTPS origin; HTTP requires --dev")
	}
	if !strings.HasPrefix(c.Key, "hbk_") || len(c.Name) < 1 || len(c.Name) > 128 || c.Core.Binary == "" || c.Core.Session == "" || c.Connection.ReconnectMin < 1 || c.Connection.ReconnectMax < c.Connection.ReconnectMin || c.Connection.ReconnectMax > 300 {
		return c, errors.New("invalid client configuration")
	}
	if !filepath.IsAbs(c.Core.Binary) {
		return c, errors.New("core.binary must be an absolute executable path")
	}
	if _, e = exec.LookPath(c.Core.Binary); e != nil {
		return c, errors.New("core executable unavailable")
	}
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
