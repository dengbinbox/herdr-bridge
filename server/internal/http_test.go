package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestStaticFallbackDoesNotCaptureAPI(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "index.html"), []byte("<html>bridge app</html>"), 0600)
	var c Config
	c.WebUI.Enabled = true
	c.WebUI.Directory = dir
	s := New(c, nil)
	h := s.Handler()
	for _, tc := range []struct {
		path   string
		status int
		html   bool
	}{{"/ui/login", 200, true}, {"/ui/assets/missing.js", 404, false}, {"/api/v1/missing", 404, false}, {"/bridge/v1/missing", 404, false}, {"/ws/v1/missing", 404, false}, {"/api/v1/bridges", 401, false}, {"/", 302, false}} {
		r := httptest.NewRequest("GET", tc.path, nil)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != tc.status || strings.Contains(w.Body.String(), "bridge app") != tc.html {
			t.Fatalf("%s: %d %s", tc.path, w.Code, w.Body.String())
		}
	}
}
func TestOriginsAndTrustedProxy(t *testing.T) {
	var c Config
	c.Server.AllowedOrigins = []string{"https://bridge.test"}
	c.Server.TrustedProxies = []string{"127.0.0.0/8"}
	s := New(c, nil)
	r := httptest.NewRequest("GET", "https://bridge.test/", nil)
	r.RemoteAddr = "127.0.0.1:9000"
	r.Header.Set("Origin", "https://bridge.test.evil")
	if s.origin(r) {
		t.Fatal("origin suffix accepted")
	}
	r.Header.Set("Origin", "https://bridge.test")
	if !s.origin(r) {
		t.Fatal("exact origin rejected")
	}
	r.Header.Set("X-Forwarded-For", "198.51.100.20, 127.0.0.2")
	if s.clientIP(r) != "198.51.100.20" {
		t.Fatal("trusted proxy chain")
	}
	r.RemoteAddr = "203.0.113.3:1234"
	if s.clientIP(r) != "203.0.113.3" {
		t.Fatal("untrusted forwarded address used")
	}
}
func TestOpenAPIResponseAndRouteContract(t *testing.T) {
	b, e := os.ReadFile("../../contracts/openapi.yaml")
	if e != nil {
		t.Fatal(e)
	}
	var contract struct {
		Paths      map[string]map[string]any `json:"paths"`
		Components struct {
			Schemas map[string]struct {
				Required   []string       `json:"required"`
				Properties map[string]any `json:"properties"`
			} `json:"schemas"`
		} `json:"components"`
	}
	if e = json.Unmarshal(b, &contract); e != nil {
		t.Fatal(e)
	}
	s := New(Config{}, nil)
	h := s.Handler()
	for path, methods := range contract.Paths {
		for method := range methods {
			w := httptest.NewRecorder()
			r := httptest.NewRequest(strings.ToUpper(method), strings.ReplaceAll(path, "{id}", "00112233-4455-6677-8899-aabbccddeeff"), nil)
			h.ServeHTTP(w, r)
			if w.Code == http.StatusNotFound || w.Code == http.StatusMethodNotAllowed {
				t.Fatalf("contract route not implemented: %s %s", method, path)
			}
			var errorBody map[string]any
			if json.Unmarshal(w.Body.Bytes(), &errorBody) != nil || errorBody["error"] == nil {
				t.Fatalf("error response not JSON: %s %s", method, path)
			}
		}
	}
	b, _ = json.Marshal(session{ID: "id", Username: "user", Role: "user", CSRF: "token"})
	var value map[string]any
	json.Unmarshal(b, &value)
	schema := contract.Components.Schemas["Session"]
	for _, field := range schema.Required {
		if _, ok := value[field]; !ok {
			t.Errorf("missing response field %s", field)
		}
	}
	for field := range value {
		if _, ok := schema.Properties[field]; !ok {
			t.Errorf("unexpected response field %s", field)
		}
	}
}
