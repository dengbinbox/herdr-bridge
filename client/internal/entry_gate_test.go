package client

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type gateTransport func(*http.Request) (*http.Response, error)

func (f gateTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func gateTestServer(t *testing.T, h http.Handler) string {
	t.Helper()
	old := http.DefaultTransport
	t.Cleanup(func() { http.DefaultTransport = old })
	http.DefaultTransport = gateTransport(func(r *http.Request) (*http.Response, error) {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		res := w.Result()
		res.Request = r
		res.Body = io.NopCloser(strings.NewReader(w.Body.String()))
		return res, nil
	})
	return "http://bridge.test"
}
func TestEntryCookieSentOnWebSocketHandshake(t *testing.T) {
	var entered, connected bool
	serverURL := gateTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/private" {
			entered = true
			if r.URL.Query().Get("secret") != "value" || r.Header.Get("Authorization") != "" {
				t.Error("invalid entrance request")
			}
			http.SetCookie(w, &http.Cookie{Name: "custom", Value: "random", Path: "/", HttpOnly: true})
			http.Redirect(w, r, "/ui/", 302)
			return
		}
		if r.URL.Path != "/bridge/v1/connect" {
			t.Error("unexpected redirect followed")
		}
		cookie, err := r.Cookie("custom")
		if !entered || err != nil || cookie.Value != "random" || r.Header.Get("Authorization") != "Bearer hbk_test" {
			t.Error("missing handshake credentials")
		}
		connected = true
		w.WriteHeader(401)
	}))

	c := Config{ServerURL: serverURL, EntryURL: serverURL + "/private?secret=value", Key: "hbk_test"}
	_ = connect(context.Background(), c, "test")
	if !connected {
		t.Fatal("did not attempt websocket")
	}
}

func TestEntryFailureDoesNotConnect(t *testing.T) {
	for _, code := range []int{200, 404, 302} {
		serverURL := gateTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/private" {
				t.Error("connected after gate failure")
			}
			w.Header().Set("Location", "https://elsewhere.example/")
			w.WriteHeader(code)
		}))
		_, err := entryClient(context.Background(), Config{ServerURL: serverURL, EntryURL: serverURL + "/private?k=v"})

		if err == nil {
			t.Fatal("accepted failure")
		}
	}
	for _, entry := range []string{"https://other.example/private?k=v", "http://example.com/private?k=v", "https://u:p@example.com/private?k=v"} {
		if validateEntryURL("https://example.com", entry) == nil {
			t.Fatal("unsafe entry accepted")
		}
	}
}
