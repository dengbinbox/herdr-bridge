package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestEntryGateProtectsAllRoutes(t *testing.T) {
	var c Config
	c.EntryGate = EntryGateConfig{Enabled: true, Path: "/hello/key", QueryName: "ttt", QueryValue: "123456", CookieName: "custom_entry", CookieTTL: time.Hour}
	s := New(c, nil)
	h := s.Handler()
	for _, target := range []string{"/", "/ui/", "/ui/a.js", "/api/v1/auth/login", "/bridge/v1/connect", "/ws/v1/bridges/x", "/unknown", "/ui", "/a/../ui/", "/hello/key", "/hello/key?ttt=wrong", "/hello/key?ttt=123456&ttt=wrong"} {
		for _, method := range []string{"GET", "POST", "HEAD", "OPTIONS"} {
			r := httptest.NewRequest(method, target, nil)
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != 404 || w.Body.Len() != 0 || w.Header().Get("Location") != "" {
				t.Fatalf("%s %s: %d %q", method, target, w.Code, w.Body.String())
			}
		}
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/hello/key?ttt=123456", nil))
	if w.Code != 302 || w.Header().Get("Location") != "/ui/" {
		t.Fatal(w)
	}
	cookies := w.Result().Cookies()
	if len(cookies) != 1 || cookies[0].Name != "custom_entry" || !cookies[0].HttpOnly || cookies[0].Path != "/" {
		t.Fatal(cookies)
	}
	cookie := cookies[0]
	for _, target := range []string{"/", "/bridge/v1/connect"} {
		r := httptest.NewRequest("GET", target, nil)
		r.AddCookie(cookie)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code == 404 {
			t.Fatalf("valid cookie rejected for %s", target)
		}
	}
	expired := "nonce." + "1"
	for _, value := range []string{"forged", cookie.Value + "x", expired + "." + s.entrySignature(expired)} {
		r := httptest.NewRequest("GET", "/", nil)
		r.AddCookie(&http.Cookie{Name: cookie.Name, Value: value})
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 404 || w.Body.Len() != 0 {
			t.Fatal("bad cookie accepted")
		}
	}
	r := httptest.NewRequest("GET", "/", nil)
	r.AddCookie(cookie)
	w = httptest.NewRecorder()
	New(c, nil).Handler().ServeHTTP(w, r)
	if w.Code != 404 {
		t.Fatal("old cookie survives restart")
	}
	w = httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/hello/key?ttt=123456", nil))
	if strings.Split(w.Result().Cookies()[0].Value, ".")[0] == strings.Split(cookie.Value, ".")[0] {
		t.Fatal("cookie nonce reused")
	}
}

func TestEntryGateConfig(t *testing.T) {
	base := "server:\n  public_url: https://example.com\nentry_gate:\n  enabled: true\n  path: /hello/key\n  query_name: ttt\n  query_value: '123456'\n"
	if _, err := LoadConfig(configFile(t, base)); err != nil {
		t.Fatal(err)
	}
	for _, suffix := range []string{"  cookie_name: hb_session\n", "  cookie_name: 'bad name'\n", "  cookie_ttl: 0s\n"} {
		if _, err := LoadConfig(configFile(t, base+suffix)); err == nil {
			t.Fatal("invalid config accepted")
		}
	}
}

func TestEntryGateEnvironmentSecret(t *testing.T) {
	const name = "HERDR_BRIDGE_TEST_ENTRY_SECRET"
	base := "server:\n  public_url: https://example.com\nentry_gate:\n  enabled: true\n  path: /access/entrance\n  query_name: token\n  query_value_env: " + name + "\n"
	for _, value := range []string{"", "  ", "\t\n"} {
		t.Setenv(name, value)
		if _, err := LoadConfig(configFile(t, base)); err == nil {
			t.Fatal("accepted empty environment secret")
		}
	}
	t.Setenv(name, "test-secret-must-not-be-logged")
	c, err := LoadConfig(configFile(t, base))
	if err != nil {
		t.Fatal(err)
	}
	if c.EntryGate.QueryValue != "test-secret-must-not-be-logged" {
		t.Fatal("environment secret not loaded")
	}
	w := httptest.NewRecorder()
	New(c, nil).Handler().ServeHTTP(w, httptest.NewRequest("GET", "/access/entrance?token=test-secret-must-not-be-logged", nil))
	if w.Code != 302 || len(w.Result().Cookies()) != 1 {
		t.Fatal("environment entrance rejected")
	}
	_, err = LoadConfig(configFile(t, base+"  query_value: plaintext\n"))
	if err == nil || strings.Contains(err.Error(), "plaintext") || strings.Contains(err.Error(), c.EntryGate.QueryValue) {
		t.Fatal("conflict not safely rejected")
	}
	t.Setenv(name, "")
	disabled := strings.Replace(base, "enabled: true", "enabled: false", 1)
	if _, err := LoadConfig(configFile(t, disabled)); err != nil {
		t.Fatal("disabled gate needs no secret", err)
	}
	missing := strings.Replace(base, name, "HERDR_BRIDGE_TEST_ENTRY_UNSET", 1)
	t.Setenv("HERDR_BRIDGE_TEST_ENTRY_UNSET", "")
	if _, err := LoadConfig(configFile(t, missing)); err == nil {
		t.Fatal("accepted missing secret")
	}
}
