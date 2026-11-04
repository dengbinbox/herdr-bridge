package server

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"herdr-bridge/internal/protocol"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type Server struct {
	entrySecret string
	cfg         Config
	db          *pgxpool.Pool
	log         *slog.Logger
	mu          sync.Mutex
	agents      map[string]*agent
	loginSlots  chan struct{}
	attempts    map[string]attempt
}
type attempt struct {
	n     int
	until time.Time
}
type session struct {
	ID         string    `json:"id"`
	Username   string    `json:"username"`
	Role       string    `json:"role"`
	MustChange bool      `json:"must_change_password"`
	CSRF       string    `json:"csrf_token"`
	Hash       []byte    `json:"-"`
	Expires    time.Time `json:"-"`
}
type handler func(http.ResponseWriter, *http.Request, *session)

func Run(ctx context.Context, c Config) error {
	db, e := OpenDB(ctx, c)
	if e != nil {
		return e
	}
	defer db.Close()
	s := New(c, db)
	h := &http.Server{Addr: c.Server.Listen, Handler: s.Handler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16384}
	go func() {
		<-ctx.Done()
		s.closeAll()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		h.Shutdown(shutdown)
	}()
	s.log.Info("server listening", "address", c.Server.Listen)
	e = h.ListenAndServe()
	if errors.Is(e, http.ErrServerClosed) {
		return nil
	}
	return e
}
func New(c Config, db *pgxpool.Pool) *Server {
	return &Server{entrySecret: token(32), cfg: c, db: db, log: slog.Default(), agents: map[string]*agent{}, loginSlots: make(chan struct{}, 4), attempts: map[string]attempt{}}
}
func jsonReply(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
func fail(w http.ResponseWriter, status int, code string) {
	jsonReply(w, status, map[string]string{"error": code})
}
func body(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if d.Decode(v) != nil {
		fail(w, 400, "invalid_body")
		return false
	}
	var x any
	if d.Decode(&x) != io.EOF {
		fail(w, 400, "invalid_body")
		return false
	}
	return true
}
func (s *Server) origin(r *http.Request) bool {
	for _, v := range s.cfg.Server.AllowedOrigins {
		if r.Header.Get("Origin") == v {
			return true
		}
	}
	return false
}
func (s *Server) Handler() http.Handler {
	m := http.NewServeMux()
	m.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, "/ui/", 302) })
	m.HandleFunc("POST /api/v1/auth/login", s.login)
	m.HandleFunc("GET /api/v1/auth/me", s.auth(false, func(w http.ResponseWriter, r *http.Request, u *session) { jsonReply(w, 200, u) }))
	m.HandleFunc("POST /api/v1/auth/logout", s.auth(false, s.logout))
	m.HandleFunc("POST /api/v1/auth/password", s.auth(false, s.password))
	m.HandleFunc("GET /api/v1/keys", s.auth(false, s.keys))
	m.HandleFunc("POST /api/v1/keys", s.auth(false, s.createKey))
	m.HandleFunc("DELETE /api/v1/keys/{id}", s.auth(false, s.revokeKey))
	m.HandleFunc("POST /api/v1/keys/{id}/rotate", s.auth(false, s.rotateKey))
	m.HandleFunc("GET /api/v1/bridges", s.auth(false, s.bridges))
	m.HandleFunc("GET /api/v1/bridges/{id}", s.auth(false, s.bridgeDetail))
	m.HandleFunc("GET /api/v1/layouts/{id}", s.auth(false, s.getLayout))
	m.HandleFunc("PUT /api/v1/layouts/{id}", s.auth(false, s.putLayout))
	m.HandleFunc("GET /api/v1/admin/users", s.auth(true, s.users))
	m.HandleFunc("POST /api/v1/admin/users", s.auth(true, s.createUser))
	m.HandleFunc("PATCH /api/v1/admin/users/{id}", s.auth(true, s.updateUser))
	m.HandleFunc("GET /api/v1/admin/connections", s.auth(true, s.connections))
	m.HandleFunc("GET /bridge/v1/connect", s.connectAgent)
	m.HandleFunc("GET /ws/v1/bridges/{id}", s.auth(false, s.connectBrowser))
	m.HandleFunc("GET /ui/", s.static)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.entryGate(w, r) {
			return
		}
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "same-origin")
		w.Header().Set("X-Frame-Options", "DENY")
		if !strings.HasPrefix(r.URL.Path, "/ui/") {
			w.Header().Set("Cache-Control", "no-store")
		}
		if strings.HasPrefix(r.URL.Path, "/api/") {
			ctx, cancel := context.WithTimeout(r.Context(), s.cfg.Database.QueryTimeout)
			defer cancel()
			r = r.WithContext(ctx)
		}
		m.ServeHTTP(w, r)
	})
}
func (s *Server) auth(admin bool, h handler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cookie, e := r.Cookie("hb_session")
		if e != nil {
			fail(w, 401, "unauthorized")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), s.cfg.Database.QueryTimeout)
		defer cancel()
		var u session
		u.Hash = digest(cookie.Value)
		e = s.db.QueryRow(ctx, "SELECT u.id::text,u.username,u.role,u.must_change_password,s.csrf_token,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.session_token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND u.status='active'", u.Hash).Scan(&u.ID, &u.Username, &u.Role, &u.MustChange, &u.CSRF, &u.Expires)
		if e != nil {
			fail(w, 401, "unauthorized")
			return
		}
		if admin && u.Role != "admin" {
			fail(w, 403, "forbidden")
			return
		}
		if u.MustChange && !strings.HasPrefix(r.URL.Path, "/api/v1/auth/") {
			fail(w, 403, "password_change_required")
			return
		}
		if r.Method != "GET" && r.Method != "HEAD" {
			if !s.origin(r) || subtle.ConstantTimeCompare([]byte(r.Header.Get("X-CSRF-Token")), []byte(u.CSRF)) != 1 {
				fail(w, 403, "csrf_failed")
				return
			}
		}
		if r.Method != "GET" && (r.URL.Path == "/api/v1/auth/password" || strings.HasPrefix(r.URL.Path, "/api/v1/admin/users")) {
			select {
			case s.loginSlots <- struct{}{}:
				defer func() { <-s.loginSlots }()
			default:
				fail(w, 429, "busy")
				return
			}
		}
		h(w, r, &u)
	}
}
func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	if !s.origin(r) {
		fail(w, 403, "origin_rejected")
		return
	}
	host := s.clientIP(r)
	now := time.Now()
	s.mu.Lock()
	for k, v := range s.attempts {
		if now.After(v.until) {
			delete(s.attempts, k)
		}
	}
	a := s.attempts[host]
	if a.n >= 10 || len(s.attempts) >= 10000 {
		s.mu.Unlock()
		fail(w, 429, "rate_limited")
		return
	}
	if a.n == 0 {
		a.until = now.Add(time.Minute)
	}
	a.n++
	s.attempts[host] = a
	s.mu.Unlock()
	select {
	case s.loginSlots <- struct{}{}:
		defer func() { <-s.loginSlots }()
	default:
		fail(w, 429, "busy")
		return
	}
	var b struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if !body(w, r, &b) {
		return
	}
	if len(b.Password) > 1024 || len(b.Username) > 128 {
		fail(w, 401, "invalid_credentials")
		return
	}
	var u session
	var hash, status string
	e := s.db.QueryRow(r.Context(), "SELECT id::text,username,password_hash,role,status,must_change_password FROM users WHERE username=$1", b.Username).Scan(&u.ID, &u.Username, &hash, &u.Role, &status, &u.MustChange)
	if e != nil {
		passwordHash(b.Password)
	}
	if e != nil || !passwordOK(b.Password, hash) || status != "active" {
		s.audit("", "login", "", "denied")
		fail(w, 401, "invalid_credentials")
		return
	}
	raw := token(32)
	u.CSRF = token(32)
	u.Expires = time.Now().Add(s.cfg.Auth.SessionTTL)
	s.mu.Lock()
	tag, e := s.db.Exec(r.Context(), "INSERT INTO sessions(session_token_hash,user_id,csrf_token,expires_at) SELECT $1,id,$3,$4 FROM users WHERE id=$2 AND password_hash=$5 AND status='active'", digest(raw), u.ID, u.CSRF, u.Expires, hash)
	s.mu.Unlock()
	if e == nil && tag.RowsAffected() != 1 {
		fail(w, 401, "invalid_credentials")
		return
	}
	if e != nil {
		fail(w, 500, "storage_error")
		return
	}
	http.SetCookie(w, &http.Cookie{Name: "hb_session", Value: raw, Path: "/", Expires: u.Expires, HttpOnly: true, Secure: s.cfg.Auth.CookieSecure, SameSite: http.SameSiteLaxMode})
	s.audit(u.ID, "login", u.ID, "ok")
	jsonReply(w, 200, u)
}
func (s *Server) logout(w http.ResponseWriter, r *http.Request, u *session) {
	if _, e := s.db.Exec(r.Context(), "UPDATE sessions SET revoked_at=now() WHERE session_token_hash=$1", u.Hash); e != nil {
		fail(w, 500, "storage_error")
		return
	}
	s.disconnectSessions(u.ID, u.Hash)
	http.SetCookie(w, &http.Cookie{Name: "hb_session", Path: "/", Value: "", MaxAge: -1, HttpOnly: true, Secure: s.cfg.Auth.CookieSecure, SameSite: http.SameSiteLaxMode})
	jsonReply(w, 200, map[string]bool{"ok": true})
}
func (s *Server) password(w http.ResponseWriter, r *http.Request, u *session) {
	var b struct {
		Current string `json:"current_password"`
		New     string `json:"new_password"`
	}
	if !body(w, r, &b) {
		return
	}
	var h string
	if !validPassword(b.New) || len(b.Current) > 1024 {
		fail(w, 400, "invalid_password")
		return
	}
	if s.db.QueryRow(r.Context(), "SELECT password_hash FROM users WHERE id=$1", u.ID).Scan(&h) != nil || !passwordOK(b.Current, h) {
		fail(w, 403, "invalid_credentials")
		return
	}
	newHash := passwordHash(b.New)
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, e := s.db.Begin(r.Context())
	if e != nil {
		fail(w, 500, "storage_error")
		return
	}
	defer tx.Rollback(r.Context())
	tag, e := tx.Exec(r.Context(), "UPDATE users SET password_hash=$1,must_change_password=false WHERE id=$2 AND password_hash=$3", newHash, u.ID, h)
	if e == nil && tag.RowsAffected() != 1 {
		fail(w, 409, "password_changed")
		return
	}
	if e == nil {
		_, e = tx.Exec(r.Context(), "UPDATE sessions SET revoked_at=now() WHERE user_id=$1", u.ID)
	}
	if e == nil {
		e = tx.Commit(r.Context())
	}
	if e != nil {
		fail(w, 500, "storage_error")
		return
	}
	s.disconnectSessionsLocked(u.ID, nil)
	s.audit(u.ID, "password.change", u.ID, "ok")
	jsonReply(w, 200, map[string]bool{"ok": true})
}
func (s *Server) static(w http.ResponseWriter, r *http.Request) {
	if !s.cfg.WebUI.Enabled {
		http.NotFound(w, r)
		return
	}
	rel := strings.TrimPrefix(r.URL.Path, "/ui/")
	clean := filepath.Clean(rel)
	if !filepath.IsLocal(clean) {
		http.NotFound(w, r)
		return
	}
	p := filepath.Join(s.cfg.WebUI.Directory, clean)
	st, e := os.Stat(p)
	if e != nil || st.IsDir() {
		if strings.HasPrefix(rel, "assets/") || filepath.Ext(rel) != "" {
			http.NotFound(w, r)
			return
		}
		p = filepath.Join(s.cfg.WebUI.Directory, "index.html")
	}
	http.ServeFile(w, r, p)
}
func validID(w http.ResponseWriter, r *http.Request) bool {
	if !protocol.ValidID(r.PathValue("id")) {
		fail(w, 404, "not_found")
		return false
	}
	return true
}
func (s *Server) owns(r *http.Request, u *session) bool {
	ctx, cancel := context.WithTimeout(r.Context(), s.cfg.Database.QueryTimeout)
	defer cancel()
	var yes bool
	return s.db.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM bridges WHERE id=$1 AND user_id=$2)", r.PathValue("id"), u.ID).Scan(&yes) == nil && yes
}
func (s *Server) getLayout(w http.ResponseWriter, r *http.Request, u *session) {
	if !validID(w, r) {
		return
	}
	if !s.owns(r, u) {
		fail(w, 404, "not_found")
		return
	}
	var version int64
	var doc json.RawMessage
	e := s.db.QueryRow(r.Context(), "SELECT version,document FROM layouts WHERE user_id=$1 AND bridge_id=$2", u.ID, r.PathValue("id")).Scan(&version, &doc)
	if errors.Is(e, pgx.ErrNoRows) {
		doc = json.RawMessage("null")
	} else if e != nil {
		fail(w, 500, "storage_error")
		return
	}
	jsonReply(w, 200, map[string]any{"version": version, "document": doc})
}
func (s *Server) putLayout(w http.ResponseWriter, r *http.Request, u *session) {
	if !validID(w, r) {
		return
	}
	if !s.owns(r, u) {
		fail(w, 404, "not_found")
		return
	}
	var b struct {
		Version  int64           `json:"version"`
		Document json.RawMessage `json:"document"`
	}
	if !body(w, r, &b) {
		return
	}
	if b.Version < 0 || len(b.Document) == 0 {
		fail(w, 400, "invalid_layout")
		return
	}
	var v int64
	var e error
	if b.Version == 0 {
		e = s.db.QueryRow(r.Context(), "INSERT INTO layouts(user_id,bridge_id,version,document) VALUES($1,$2,1,$3) ON CONFLICT DO NOTHING RETURNING version", u.ID, r.PathValue("id"), b.Document).Scan(&v)
	} else {
		e = s.db.QueryRow(r.Context(), "UPDATE layouts SET document=$1,version=version+1 WHERE user_id=$2 AND bridge_id=$3 AND version=$4 RETURNING version", b.Document, u.ID, r.PathValue("id"), b.Version).Scan(&v)
	}
	if errors.Is(e, pgx.ErrNoRows) {
		fail(w, 409, "layout_conflict")
		return
	}
	if e != nil {
		fail(w, 500, "storage_error")
		return
	}
	jsonReply(w, 200, map[string]any{"version": v, "document": b.Document})
}

// Forwarded addresses influence rate limiting only when every proxy hop is trusted.
func (s *Server) clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	ip, err := netip.ParseAddr(host)
	if err != nil {
		return host
	}
	trusted := func(ip netip.Addr) bool {
		for _, raw := range s.cfg.Server.TrustedProxies {
			p, e := netip.ParsePrefix(raw)
			if e == nil && p.Contains(ip) {
				return true
			}
		}
		return false
	}
	if !trusted(ip) {
		return ip.String()
	}
	chain := strings.Split(r.Header.Get("X-Forwarded-For"), ",")
	for i := len(chain) - 1; i >= 0; i-- {
		next, e := netip.ParseAddr(strings.TrimSpace(chain[i]))
		if e != nil {
			break
		}
		ip = next
		if !trusted(ip) {
			break
		}
	}
	return ip.String()
}
