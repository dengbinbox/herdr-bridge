package server

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"net/http"
	"net/url"
	"os"
	"path"
	"strconv"
	"strings"
	"time"
)

// Resolve once at startup; never include the secret in diagnostics.
func (g *EntryGateConfig) resolveSecret() error {
	if g.QueryValueEnv == "" {
		return nil
	}
	if g.QueryValue != "" {
		return errors.New("entry_gate: query_value and query_value_env are mutually exclusive")
	}
	if !g.Enabled {
		return nil
	}
	value := os.Getenv(g.QueryValueEnv)
	if strings.TrimSpace(value) == "" {
		return errors.New("entry_gate: query_value_env references an unset or empty environment variable")
	}
	g.QueryValue = value
	return nil
}

func (g EntryGateConfig) validate() error {
	if !g.Enabled {
		return nil
	}
	u, err := url.Parse(g.Path)
	if err != nil || !strings.HasPrefix(g.Path, "/") || strings.HasPrefix(g.Path, "//") || u.RawQuery != "" || u.Fragment != "" || u.Path != g.Path || path.Clean(g.Path) != g.Path || g.Path == "/" || g.QueryName == "" || g.QueryValue == "" || g.CookieTTL < time.Second || g.CookieTTL > 365*24*time.Hour {
		return errors.New("invalid entry_gate path, query or cookie_ttl")
	}
	c := &http.Cookie{Name: g.CookieName, Value: "valid"}
	if c.Valid() != nil || g.CookieName == "hb_session" {
		return errors.New("invalid entry_gate cookie_name")
	}
	return nil
}

func (s *Server) entrySignature(value string) string {
	mac := hmac.New(sha256.New, []byte(s.entrySecret))
	mac.Write([]byte(value))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// Runs before routing, including redirects, static files and WebSocket upgrades.
func (s *Server) entryGate(w http.ResponseWriter, r *http.Request) bool {
	g := s.cfg.EntryGate
	if !g.Enabled {
		return true
	}
	deny := func() bool {
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusNotFound)
		return false
	}
	if r.URL.Path == g.Path {
		q, err := url.ParseQuery(r.URL.RawQuery)
		values := q[g.QueryName]
		if r.Method != http.MethodGet || err != nil || len(q) != 1 || len(values) != 1 || subtle.ConstantTimeCompare([]byte(values[0]), []byte(g.QueryValue)) != 1 {
			return deny()
		}
		expires := time.Now().Add(g.CookieTTL)
		value := token(32) + "." + strconv.FormatInt(expires.Unix(), 10)
		http.SetCookie(w, &http.Cookie{Name: g.CookieName, Value: value + "." + s.entrySignature(value), Path: "/", HttpOnly: true, Secure: s.cfg.Auth.CookieSecure, SameSite: http.SameSiteLaxMode, Expires: expires, MaxAge: int(g.CookieTTL / time.Second)})
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Referrer-Policy", "no-referrer")
		http.Redirect(w, r, "/ui/", http.StatusFound)
		return false
	}
	c, err := r.Cookie(g.CookieName)
	if err != nil {
		return deny()
	}
	parts := strings.Split(c.Value, ".")
	if len(parts) != 3 {
		return deny()
	}
	expiry, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil || time.Now().Unix() >= expiry || !hmac.Equal([]byte(parts[2]), []byte(s.entrySignature(parts[0]+"."+parts[1]))) {
		return deny()
	}
	return true
}
