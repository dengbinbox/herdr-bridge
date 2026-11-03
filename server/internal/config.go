package server

import (
	"errors"
	"go.yaml.in/yaml/v3"
	"io"
	"net/netip"
	"net/url"
	"os"
	"time"
)

type Config struct {
	Server struct {
		Listen         string   `yaml:"listen"`
		PublicURL      string   `yaml:"public_url"`
		AllowedOrigins []string `yaml:"allowed_origins"`
		TrustedProxies []string `yaml:"trusted_proxies"`
	} `yaml:"server"`
	Database struct {
		Driver          string        `yaml:"driver"`
		DSNEnv          string        `yaml:"dsn_env"`
		MaxConns        int32         `yaml:"max_conns"`
		MinConns        int32         `yaml:"min_conns"`
		ConnectTimeout  time.Duration `yaml:"connect_timeout"`
		QueryTimeout    time.Duration `yaml:"query_timeout"`
		MaxConnLifetime time.Duration `yaml:"max_conn_lifetime"`
	} `yaml:"database"`
	Auth struct {
		SessionTTL     time.Duration `yaml:"session_ttl"`
		CookieSecure   bool          `yaml:"cookie_secure"`
		BootstrapAdmin struct {
			Username              string `yaml:"username"`
			PasswordEnv           string `yaml:"password_env"`
			RequirePasswordChange bool   `yaml:"require_password_change"`
		} `yaml:"bootstrap_admin"`
	} `yaml:"auth"`
	WebUI struct {
		Enabled   bool   `yaml:"enabled"`
		Directory string `yaml:"directory"`
	} `yaml:"web_ui"`
	Connections struct {
		HeartbeatInterval       time.Duration `yaml:"heartbeat_interval"`
		HeartbeatTimeout        time.Duration `yaml:"heartbeat_timeout"`
		MaxBridgesPerUser       int           `yaml:"max_bridges_per_user"`
		MaxTunnelsPerBridge     int           `yaml:"max_tunnels_per_bridge"`
		MaxWSMessageBytes       int           `yaml:"max_ws_message_bytes"`
		MaxBufferBytesPerTunnel int           `yaml:"max_buffer_bytes_per_tunnel"`
	} `yaml:"connections"`
}

func LoadConfig(path string) (Config, error) {
	var c Config
	c.Server.Listen = "127.0.0.1:8080"
	c.Database.Driver = "postgres"
	c.Database.DSNEnv = "HERDR_BRIDGE_DATABASE_URL"
	c.Database.MaxConns = 20
	c.Database.MinConns = 2
	c.Database.ConnectTimeout = 5 * time.Second
	c.Database.QueryTimeout = 10 * time.Second
	c.Database.MaxConnLifetime = time.Hour
	c.Auth.SessionTTL = 24 * time.Hour
	c.Auth.CookieSecure = true
	c.Auth.BootstrapAdmin.Username = "admin"
	c.Auth.BootstrapAdmin.PasswordEnv = "HERDR_BRIDGE_ADMIN_PASSWORD"
	c.Auth.BootstrapAdmin.RequirePasswordChange = true
	c.Connections.HeartbeatInterval = 20 * time.Second
	c.Connections.HeartbeatTimeout = 60 * time.Second
	c.Connections.MaxBridgesPerUser = 20
	c.Connections.MaxTunnelsPerBridge = 16
	c.Connections.MaxWSMessageBytes = 1048576
	c.Connections.MaxBufferBytesPerTunnel = 4194304
	f, e := os.Open(path)
	if e != nil {
		return c, e
	}
	defer f.Close()
	d := yaml.NewDecoder(f)
	d.KnownFields(true)
	if e = d.Decode(&c); e != nil {
		return c, e
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		return c, errors.New("only one YAML document allowed")
	}
	u, e := url.Parse(c.Server.PublicURL)
	if e != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return c, errors.New("invalid public_url")
	}
	if len(c.Server.AllowedOrigins) == 0 {
		c.Server.AllowedOrigins = []string{u.Scheme + "://" + u.Host}
	}
	for _, o := range c.Server.AllowedOrigins {
		v, e := url.Parse(o)
		if e != nil || v.Host == "" || (v.Scheme != "https" && v.Scheme != "http") || v.Path != "" || v.RawQuery != "" || v.Fragment != "" || v.User != nil {
			return c, errors.New("invalid allowed origin")
		}
	}
	for _, proxy := range c.Server.TrustedProxies {
		if _, e := netip.ParsePrefix(proxy); e != nil {
			return c, errors.New("trusted_proxies must contain CIDR prefixes")
		}
	}
	if c.Auth.BootstrapAdmin.Username == "" || len(c.Auth.BootstrapAdmin.Username) > 128 || c.Auth.BootstrapAdmin.PasswordEnv == "" || c.Database.Driver != "postgres" || c.Database.DSNEnv == "" || c.Database.MinConns < 0 || c.Database.MaxConns < 1 || c.Database.MinConns > c.Database.MaxConns || c.Database.QueryTimeout <= 0 || c.Database.ConnectTimeout <= 0 || c.Database.MaxConnLifetime <= 0 || c.Auth.SessionTTL <= 0 || c.Connections.HeartbeatInterval < 100*time.Millisecond || c.Connections.HeartbeatTimeout < c.Connections.HeartbeatInterval || c.Connections.MaxBridgesPerUser < 1 || c.Connections.MaxTunnelsPerBridge < 1 || c.Connections.MaxTunnelsPerBridge > 1024 || c.Connections.MaxBufferBytesPerTunnel > 64<<20 || c.Connections.MaxWSMessageBytes < 1024 || c.Connections.MaxWSMessageBytes > 16<<20 || c.Connections.MaxBufferBytesPerTunnel < c.Connections.MaxWSMessageBytes {
		return c, errors.New("invalid configuration limits")
	}
	if c.WebUI.Enabled {
		if _, e := os.Stat(c.WebUI.Directory + "/index.html"); e != nil {
			return c, errors.New("web UI index.html missing")
		}
	}
	return c, nil
}
