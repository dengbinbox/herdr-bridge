package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"herdr-bridge/internal/protocol"
)

// Each test creates its own PostgreSQL schema. SQLite is never substituted.
func integrationDB(t *testing.T) (*pgxpool.Pool, Config) {
	t.Helper()
	dsn := os.Getenv("HERDR_BRIDGE_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set HERDR_BRIDGE_TEST_DATABASE_URL to a disposable PostgreSQL test database")
	}
	u, e := url.Parse(dsn)
	if e != nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") {
		t.Fatal("test DSN must be a PostgreSQL URI")
	}
	if !strings.HasPrefix(strings.TrimPrefix(u.Path, "/"), "herdr_bridge_test") {
		t.Fatal("test database name must start with herdr_bridge_test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	root, e := pgxpool.New(ctx, dsn)
	if e != nil {
		t.Fatal(e)
	}
	schema := "hb_test_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	quoted := pgx.Identifier{schema}.Sanitize()
	if _, e = root.Exec(ctx, "CREATE SCHEMA "+quoted); e != nil {
		root.Close()
		t.Fatal(e)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		root.Exec(ctx, "DROP SCHEMA "+quoted+" CASCADE")
		root.Close()
	})
	q := u.Query()
	q.Set("search_path", schema)
	u.RawQuery = q.Encode()
	t.Setenv("HERDR_BRIDGE_TEST_DSN", u.String())
	t.Setenv("HERDR_BRIDGE_TEST_ADMIN_PASSWORD", "integration-test-password")
	c, e := LoadConfig(configFile(t, "server:\n  public_url: http://localhost\n  allowed_origins: [http://localhost]\ndatabase:\n  dsn_env: HERDR_BRIDGE_TEST_DSN\n  min_conns: 0\n  max_conns: 4\nauth:\n  cookie_secure: false\n  bootstrap_admin:\n    password_env: HERDR_BRIDGE_TEST_ADMIN_PASSWORD\n    require_password_change: false\n"))
	if e != nil {
		t.Fatal(e)
	}
	db, e := OpenDB(ctx, c)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(db.Close)
	return db, c
}

type testBrowser struct {
	cookie *http.Cookie
	csrf   string
}
type apiResult struct {
	status  int
	data    []byte
	cookies []*http.Cookie
}

func request(t *testing.T, base, method, path string, user *testBrowser, data any) apiResult {
	t.Helper()
	var body io.Reader
	if data != nil {
		b, e := json.Marshal(data)
		if e != nil {
			t.Fatal(e)
		}
		body = bytes.NewReader(b)
	}
	r, e := http.NewRequest(method, base+path, body)
	if e != nil {
		t.Fatal(e)
	}
	r.Header.Set("Origin", "http://localhost")
	r.Header.Set("Content-Type", "application/json")
	if user != nil {
		r.AddCookie(user.cookie)
		r.Header.Set("X-CSRF-Token", user.csrf)
	}
	client := &http.Client{Timeout: 10 * time.Second}
	res, e := client.Do(r)
	if e != nil {
		t.Fatal(e)
	}
	defer res.Body.Close()
	b, e := io.ReadAll(res.Body)
	if e != nil {
		t.Fatal(e)
	}
	return apiResult{res.StatusCode, b, res.Cookies()}
}
func status(t *testing.T, result apiResult, want int) {
	t.Helper()
	if result.status != want {
		t.Fatalf("status %d want %d: %s", result.status, want, result.data)
	}
}
func loginTest(t *testing.T, base, name, password string) *testBrowser {
	t.Helper()
	res := request(t, base, "POST", "/api/v1/auth/login", nil, map[string]string{"username": name, "password": password})
	status(t, res, 200)
	var u session
	if e := json.Unmarshal(res.data, &u); e != nil {
		t.Fatal(e)
	}
	if len(res.cookies) != 1 || !res.cookies[0].HttpOnly || res.cookies[0].SameSite != http.SameSiteLaxMode {
		t.Fatal("session cookie flags")
	}
	return &testBrowser{res.cookies[0], u.CSRF}
}
func newUser(t *testing.T, base string, admin *testBrowser, name string) *testBrowser {
	t.Helper()
	status(t, request(t, base, "POST", "/api/v1/admin/users", admin, map[string]string{"username": name, "password": "initial-test-password"}), 201)
	u := loginTest(t, base, name, "initial-test-password")
	status(t, request(t, base, "GET", "/api/v1/bridges", u, nil), 403)
	status(t, request(t, base, "POST", "/api/v1/auth/password", u, map[string]string{"current_password": "initial-test-password", "new_password": "changed-test-password"}), 200)
	status(t, request(t, base, "GET", "/api/v1/auth/me", u, nil), 401)
	return loginTest(t, base, name, "changed-test-password")
}
func keyTest(t *testing.T, base string, u *testBrowser) (string, string) {
	t.Helper()
	res := request(t, base, "POST", "/api/v1/keys", u, map[string]string{"name": "test"})
	status(t, res, 201)
	var out map[string]string
	json.Unmarshal(res.data, &out)
	return out["id"], out["key"]
}
func connectTestAgent(t *testing.T, base, key, id string) (*websocket.Conn, protocol.Control) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, e := websocket.Dial(ctx, strings.Replace(base, "http:", "ws:", 1)+"/bridge/v1/connect", &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": []string{"Bearer " + key}}})
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { c.CloseNow() })
	b, _ := json.Marshal(protocol.Control{Type: "register", Version: 1, BridgeID: id, Name: "test", OS: "test", AgentVersion: "test", Capabilities: []string{"core-stream-v1"}})
	if e = c.Write(ctx, websocket.MessageText, b); e != nil {
		t.Fatal(e)
	}
	_, b, e = c.Read(ctx)
	if e != nil {
		t.Fatal(e)
	}
	m, e := protocol.DecodeControl(b)
	if e != nil {
		t.Fatal(e)
	}
	return c, m
}
func testServer(t *testing.T) (*Server, *httptest.Server) {
	t.Helper()
	db, c := integrationDB(t)
	s := New(c, db)
	httpServer := httptest.NewServer(s.Handler())
	t.Cleanup(func() { s.closeAll(); httpServer.Close() })
	return s, httpServer
}

func TestIntegrationAuthorizationKeysAndLayouts(t *testing.T) {
	s, h := testServer(t)
	admin := loginTest(t, h.URL, "admin", "integration-test-password")
	a := newUser(t, h.URL, admin, "a")
	b := newUser(t, h.URL, admin, "b")
	_, key := keyTest(t, h.URL, a)
	id := uuid.NewString()
	agent, m := connectTestAgent(t, h.URL, key, id)
	if m.Type != "registered" {
		t.Fatalf("register: %+v", m)
	}
	status(t, request(t, h.URL, "GET", "/api/v1/bridges/"+id, a, nil), 200)
	status(t, request(t, h.URL, "GET", "/api/v1/bridges/"+id, b, nil), 404)
	status(t, request(t, h.URL, "GET", "/api/v1/bridges/"+id, admin, nil), 404)
	status(t, request(t, h.URL, "PUT", "/api/v1/layouts/"+id, a, map[string]any{"version": 0, "document": map[string]any{"tabs": []string{"t1"}}}), 200)
	status(t, request(t, h.URL, "PUT", "/api/v1/layouts/"+id, a, map[string]any{"version": 0, "document": nil}), 409)
	status(t, request(t, h.URL, "GET", "/api/v1/layouts/"+id, b, nil), 404)
	status(t, request(t, h.URL, "GET", "/api/v1/admin/users", a, nil), 403)
	noCSRF := *a
	noCSRF.csrf = "wrong"
	status(t, request(t, h.URL, "POST", "/api/v1/keys", &noCSRF, map[string]string{"name": "rejected"}), 403)
	list := request(t, h.URL, "GET", "/api/v1/keys", a, nil)
	status(t, list, 200)
	if bytes.Contains(list.data, []byte(key)) {
		t.Fatal("key leaked in list")
	}
	_, duplicate := connectTestAgent(t, h.URL, key, id)
	if duplicate.Code != "identity_conflict" {
		t.Fatalf("duplicate: %+v", duplicate)
	}
	agent.CloseNow()
	deadline := time.Now().Add(5 * time.Second)
	for {
		s.mu.Lock()
		offline := s.agents[id] == nil
		s.mu.Unlock()
		if offline {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("agent not removed")
		}
		time.Sleep(10 * time.Millisecond)
	}
	_, otherKey := keyTest(t, h.URL, b)
	_, reclaim := connectTestAgent(t, h.URL, otherKey, id)
	if reclaim.Type != "error" {
		t.Fatal("other user reclaimed offline UUID")
	}
}
func TestIntegrationTunnelRevocationAndMultipleBrowsers(t *testing.T) {
	_, h := testServer(t)
	admin := loginTest(t, h.URL, "admin", "integration-test-password")
	u := newUser(t, h.URL, admin, "owner")
	keyID, key := keyTest(t, h.URL, u)
	id := uuid.NewString()
	agent, registered := connectTestAgent(t, h.URL, key, id)
	if registered.Type != "registered" {
		t.Fatal(registered)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	agentDone := make(chan struct{})
	go func() {
		defer close(agentDone)
		for {
			kind, b, e := agent.Read(ctx)
			if e != nil {
				return
			}
			if kind == websocket.MessageText {
				m, e := protocol.DecodeControl(b)
				if e != nil {
					return
				}
				if m.Type == "open_tunnel" {
					m.Type = "tunnel_opened"
					reply, _ := json.Marshal(m)
					if agent.Write(ctx, websocket.MessageText, reply) != nil {
						return
					}
				}
			} else {
				if agent.Write(ctx, kind, b) != nil {
					return
				}
			}
		}
	}()
	sockets := []*websocket.Conn{}
	for i := 0; i < 2; i++ {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		c, _, e := websocket.Dial(ctx, strings.Replace(h.URL, "http:", "ws:", 1)+"/ws/v1/bridges/"+id, &websocket.DialOptions{HTTPHeader: http.Header{"Cookie": []string{u.cookie.String()}, "Origin": []string{"http://localhost"}}})
		cancel()
		if e != nil {
			t.Fatal(e)
		}
		sockets = append(sockets, c)
		t.Cleanup(func() { c.CloseNow() })
	}
	for i, c := range sockets {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		payload := []byte(fmt.Sprintf("browser-%d", i))
		if e := c.Write(ctx, websocket.MessageBinary, payload); e != nil {
			t.Fatal(e)
		}
		kind, got, e := c.Read(ctx)
		cancel()
		if e != nil || kind != websocket.MessageBinary || !bytes.Equal(payload, got) {
			t.Fatalf("crossed data: %s %v", got, e)
		}
	}
	status(t, request(t, h.URL, "DELETE", "/api/v1/keys/"+keyID, u, nil), 200)
	for _, c := range sockets {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		_, _, e := c.Read(ctx)
		cancel()
		if e == nil {
			t.Fatal("browser survived key revocation")
		}
	}
	select {
	case <-agentDone:
	case <-time.After(3 * time.Second):
		t.Fatal("agent survived key revocation")
	}
}
func TestIntegrationMigrationsConstraintsAndPoolTimeout(t *testing.T) {
	db, c := integrationDB(t)
	ctx := context.Background()
	var before string
	if e := db.QueryRow(ctx, "SELECT password_hash FROM users WHERE username='admin'").Scan(&before); e != nil {
		t.Fatal(e)
	}
	t.Setenv("HERDR_BRIDGE_TEST_ADMIN_PASSWORD", "")
	if e := migrate(ctx, db, c); e != nil {
		t.Fatal(e)
	}
	var after string
	db.QueryRow(ctx, "SELECT password_hash FROM users WHERE username='admin'").Scan(&after)
	if before != after {
		t.Fatal("bootstrap password reset")
	}
	var count int
	db.QueryRow(ctx, "SELECT count(*) FROM schema_migrations").Scan(&count)
	if count != 1 {
		t.Fatal("migration not idempotent")
	}
	tx, e := db.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	id := uuid.NewString()
	_, e = tx.Exec(ctx, "INSERT INTO users(id,username,password_hash,role) VALUES($1,'rollback','x','user')", id)
	if e != nil {
		t.Fatal(e)
	}
	tx.Rollback(ctx)
	db.QueryRow(ctx, "SELECT count(*) FROM users WHERE id=$1", id).Scan(&count)
	if count != 0 {
		t.Fatal("rollback failed")
	}
	if _, e = db.Exec(ctx, "INSERT INTO users(id,username,password_hash,role) VALUES($1,'admin','x','user')", uuid.NewString()); e == nil {
		t.Fatal("username uniqueness missing")
	}
	conns := []*pgxpool.Conn{}
	for i := 0; i < int(c.Database.MaxConns); i++ {
		conn, e := db.Acquire(ctx)
		if e != nil {
			t.Fatal(e)
		}
		conns = append(conns, conn)
	}
	defer func() {
		for _, conn := range conns {
			conn.Release()
		}
	}()
	limited, cancel := context.WithTimeout(ctx, 20*time.Millisecond)
	defer cancel()
	if _, e = db.Acquire(limited); e == nil {
		t.Fatal("pool ignored timeout")
	}
}
func TestIntegrationConcurrentRegistrationAndExpiry(t *testing.T) {
	s, h := testServer(t)
	admin := loginTest(t, h.URL, "admin", "integration-test-password")
	u := newUser(t, h.URL, admin, "owner")
	keyID, key := keyTest(t, h.URL, u)
	id := uuid.NewString()
	var wg sync.WaitGroup
	results := make(chan protocol.Control, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); _, m := connectTestAgent(t, h.URL, key, id); results <- m }()
	}
	wg.Wait()
	close(results)
	registered := 0
	for m := range results {
		if m.Type == "registered" {
			registered++
		}
	}
	if registered != 1 {
		t.Fatalf("registered %d connections with same identity", registered)
	}
	if _, e := s.db.Exec(context.Background(), "UPDATE api_keys SET expires_at=now()-interval '1 second' WHERE id=$1", keyID); e != nil {
		t.Fatal(e)
	}
	deadline := time.Now().Add(4 * time.Second)
	for {
		s.mu.Lock()
		offline := s.agents[id] == nil
		s.mu.Unlock()
		if offline {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("expired key stayed online")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestIntegrationQuotasAndDisabledUser(t *testing.T) {
	s, h := testServer(t)
	s.cfg.Connections.MaxBridgesPerUser = 1
	s.cfg.Connections.MaxTunnelsPerBridge = 1
	admin := loginTest(t, h.URL, "admin", "integration-test-password")
	u := newUser(t, h.URL, admin, "limited")
	_, key := keyTest(t, h.URL, u)
	me := request(t, h.URL, "GET", "/api/v1/auth/me", u, nil)
	var user session
	json.Unmarshal(me.data, &user)
	id := uuid.NewString()
	agent, registered := connectTestAgent(t, h.URL, key, id)
	if registered.Type != "registered" {
		t.Fatal(registered)
	}
	_, overQuota := connectTestAgent(t, h.URL, key, uuid.NewString())
	if overQuota.Code != "quota_exceeded" {
		t.Fatal("bridge quota not enforced")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	headers := http.Header{"Cookie": []string{u.cookie.String()}, "Origin": []string{"http://localhost"}}
	endpoint := strings.Replace(h.URL, "http:", "ws:", 1) + "/ws/v1/bridges/" + id
	browser, _, e := websocket.Dial(ctx, endpoint, &websocket.DialOptions{HTTPHeader: headers})
	if e != nil {
		t.Fatal(e)
	}
	defer browser.CloseNow()
	deadline := time.Now().Add(3 * time.Second)
	for {
		s.mu.Lock()
		count := len(s.agents[id].tunnels)
		s.mu.Unlock()
		if count == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("opening tunnel not registered")
		}
		time.Sleep(10 * time.Millisecond)
	}
	extra, res, e := websocket.Dial(ctx, endpoint, &websocket.DialOptions{HTTPHeader: headers})
	if e == nil {
		extra.CloseNow()
		t.Fatal("tunnel quota bypassed")
	}
	if res == nil || res.StatusCode != 429 {
		t.Fatal("expected quota HTTP response")
	}
	if res.Body != nil {
		res.Body.Close()
	}
	status(t, request(t, h.URL, "PATCH", "/api/v1/admin/users/"+user.ID, admin, map[string]string{"status": "disabled"}), 200)
	status(t, request(t, h.URL, "GET", "/api/v1/auth/me", u, nil), 401)
	closedCtx, closedCancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer closedCancel()
	for {
		if _, _, e = agent.Read(closedCtx); e != nil {
			break
		}
	}
	if closedCtx.Err() != nil {
		t.Fatal("disabled user's agent remained open")
	}
}
