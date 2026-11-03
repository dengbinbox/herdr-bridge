package server

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"github.com/coder/websocket"
	"github.com/google/uuid"
	"herdr-bridge/internal/protocol"
	"herdr-bridge/internal/transport"
	"net/http"
	"strings"
	"time"
)

type agent struct {
	peer                  *transport.Peer
	user, key, connection string
	core                  bool
	tunnels               map[string]*tunnel
}
type tunnel struct {
	id, request string
	peer        *transport.Peer
	session     []byte
	ready       chan string
	opened      bool
}

func (s *Server) closeAll() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, a := range s.agents {
		a.peer.Close()
		for _, t := range a.tunnels {
			t.peer.Close()
		}
	}
}
func (s *Server) disconnectKeyLocked(key string) {
	for _, a := range s.agents {
		if a.key == key {
			a.peer.Close()
			for _, t := range a.tunnels {
				t.peer.Close()
			}
		}
	}
}
func (s *Server) disconnectSessions(user string, hash []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.disconnectSessionsLocked(user, hash)
}
func (s *Server) disconnectSessionsLocked(user string, hash []byte) {
	for _, a := range s.agents {
		if a.user == user {
			for _, t := range a.tunnels {
				if hash == nil || bytes.Equal(t.session, hash) {
					t.peer.Close()
				}
			}
		}
	}
}
func (s *Server) keyValid(ctx context.Context, key string) (user, id string, err error) {
	ctx, cancel := context.WithTimeout(ctx, s.cfg.Database.QueryTimeout)
	defer cancel()
	if !strings.HasPrefix(key, "hbk_") || len(key) > 256 {
		return "", "", errors.New("invalid_key")
	}
	rest := strings.TrimPrefix(key, "hbk_")
	if len(rest) < 14 || rest[12] != '_' {
		return "", "", errors.New("invalid_key")
	}
	public, secret := rest[:12], rest[13:]
	var hash []byte
	err = s.db.QueryRow(ctx, "SELECT k.user_id::text,k.id::text,k.secret_hash FROM api_keys k JOIN users u ON u.id=k.user_id WHERE k.public_id=$1 AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>now()) AND u.status='active' AND NOT u.must_change_password", public).Scan(&user, &id, &hash)
	if err != nil || subtle.ConstantTimeCompare(digest(secret), hash) != 1 {
		return "", "", errors.New("invalid_key")
	}
	return
}
func directControl(ctx context.Context, c *websocket.Conn, m protocol.Control) {
	m.Version = protocol.Version
	b, _ := json.Marshal(m)
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	c.Write(ctx, websocket.MessageText, b)
}
func (s *Server) connectAgent(w http.ResponseWriter, r *http.Request) {
	if r.URL.RawQuery != "" || r.Header.Get("Origin") != "" {
		fail(w, 400, "invalid_agent_request")
		return
	}
	auth := r.Header.Get("Authorization")
	if !strings.HasPrefix(auth, "Bearer ") {
		fail(w, 401, "invalid_key")
		return
	}
	key := strings.TrimPrefix(auth, "Bearer ")
	user, keyID, e := s.keyValid(r.Context(), key)
	if e != nil {
		fail(w, 401, "invalid_key")
		return
	}
	c, e := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if e != nil {
		return
	}
	defer c.CloseNow()
	c.SetReadLimit(int64(s.cfg.Connections.MaxWSMessageBytes))
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	kind, b, e := c.Read(ctx)
	cancel()
	if e != nil {
		return
	}
	m, e := protocol.DecodeControl(b)
	if kind != websocket.MessageText || e != nil || m.Type != "register" {
		directControl(r.Context(), c, protocol.Control{Type: "error", Code: "incompatible_version"})
		return
	}
	if !protocol.ValidID(m.BridgeID) || len(m.Name) < 1 || len(m.Name) > 128 || len(m.OS) > 64 || len(m.AgentVersion) > 64 {
		directControl(r.Context(), c, protocol.Control{Type: "error", Code: "invalid_registration"})
		return
	}
	capOK := false
	for _, v := range m.Capabilities {
		if v == "core-stream-v1" {
			capOK = true
		}
	}
	if !capOK {
		directControl(r.Context(), c, protocol.Control{Type: "error", Code: "unsupported_capabilities"})
		return
	}
	s.mu.Lock()
	if _, _, e = s.keyValid(r.Context(), key); e != nil {
		s.mu.Unlock()
		return
	}
	if s.agents[m.BridgeID] != nil {
		s.mu.Unlock()
		directControl(r.Context(), c, protocol.Control{Type: "error", Code: "identity_conflict"})
		return
	}
	// Serialize quota and ownership decisions across database clients as well as this server.
	dbctx, dbcancel := context.WithTimeout(r.Context(), s.cfg.Database.QueryTimeout)
	defer dbcancel()
	tx, e := s.db.Begin(dbctx)
	if e != nil {
		s.mu.Unlock()
		return
	}
	defer tx.Rollback(dbctx)
	var owner string
	online := 0
	for _, current := range s.agents {
		if current.user == user {
			online++
		}
	}
	if online >= s.cfg.Connections.MaxBridgesPerUser {
		tx.Rollback(dbctx)
		s.mu.Unlock()
		directControl(r.Context(), c, protocol.Control{Type: "error", Code: "quota_exceeded"})
		return
	}
	_, e = tx.Exec(dbctx, "SELECT id FROM users WHERE id=$1 FOR UPDATE", user)
	if e == nil {
		e = tx.QueryRow(dbctx, "INSERT INTO bridges(id,user_id,name,agent_version,os) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,agent_version=EXCLUDED.agent_version,os=EXCLUDED.os,last_connected_at=now() WHERE bridges.user_id=EXCLUDED.user_id RETURNING user_id::text", m.BridgeID, user, m.Name, m.AgentVersion, m.OS).Scan(&owner)
	}
	if e == nil {
		_, e = tx.Exec(dbctx, "UPDATE api_keys SET last_used_at=now() WHERE id=$1", keyID)
	}
	if e == nil {
		e = tx.Commit(dbctx)
	}
	if e != nil {
		s.mu.Unlock()
		directControl(r.Context(), c, protocol.Control{Type: "error", Code: "registration_rejected"})
		return
	}
	p := transport.New(r.Context(), c, s.cfg.Connections.MaxBufferBytesPerTunnel)
	a := &agent{peer: p, user: user, key: keyID, connection: uuid.NewString(), tunnels: map[string]*tunnel{}}
	s.agents[m.BridgeID] = a
	s.mu.Unlock()
	defer func() {
		p.Close()
		s.mu.Lock()
		if s.agents[m.BridgeID] == a {
			delete(s.agents, m.BridgeID)
		}
		for _, t := range a.tunnels {
			t.peer.Close()
		}
		s.mu.Unlock()
	}()
	p.Send(protocol.Control{Type: "registered", ConnectionID: a.connection, Capabilities: []string{"core-stream-v1"}, MaxMessageBytes: s.cfg.Connections.MaxWSMessageBytes, MaxBufferBytes: s.cfg.Connections.MaxBufferBytesPerTunnel, MaxTunnels: s.cfg.Connections.MaxTunnelsPerBridge, HeartbeatIntervalMS: int(s.cfg.Connections.HeartbeatInterval.Milliseconds()), HeartbeatTimeoutMS: int(s.cfg.Connections.HeartbeatTimeout.Milliseconds())})
	p.Heartbeat(s.cfg.Connections.HeartbeatInterval, s.cfg.Connections.HeartbeatTimeout)
	s.audit(user, "bridge.register", m.BridgeID, "ok")
	go func() {
		tick := time.NewTicker(time.Second)
		defer tick.Stop()
		for {
			select {
			case <-p.Done():
				return
			case <-tick.C:
				ctx, cancel := context.WithTimeout(r.Context(), s.cfg.Database.QueryTimeout)
				_, _, err := s.keyValid(ctx, key)
				cancel()
				if err != nil {
					p.Close()
					return
				}
			}
		}
	}()
	for {
		kind, b, e = c.Read(r.Context())
		if e != nil {
			return
		}
		if kind == websocket.MessageBinary {
			id, data, err := protocol.Decode(b)
			if err != nil {
				return
			}
			s.mu.Lock()
			t := a.tunnels[id]
			if t != nil && t.opened {
				if t.peer.Raw(id, data) != nil {
					t.peer.Close()
				}
			}
			s.mu.Unlock()
			continue
		}
		msg, err := protocol.DecodeControl(b)
		if err != nil || msg.ConnectionID != a.connection {
			return
		}
		s.mu.Lock()
		t := a.tunnels[msg.TunnelID]
		switch msg.Type {
		case "status":
			if msg.CoreAvailable != nil {
				a.core = *msg.CoreAvailable
			}
		case "tunnel_opened":
			if t != nil && t.request == msg.RequestID {
				t.opened = true
				select {
				case t.ready <- "":
				default:
				}
			}
		case "tunnel_closed", "error":
			if t != nil && t.request == msg.RequestID {
				select {
				case t.ready <- "core_unavailable":
				default:
				}
				if !t.opened || t.peer.Finish(t.id) != nil {
					t.peer.Close()
				}
			}
		default:
			s.mu.Unlock()
			return
		}
		s.mu.Unlock()
	}
}
func (s *Server) connectBrowser(w http.ResponseWriter, r *http.Request, u *session) {
	if !validID(w, r) {
		return
	}
	if !s.origin(r) || r.URL.RawQuery != "" {
		fail(w, 403, "origin_rejected")
		return
	}
	if !s.owns(r, u) {
		fail(w, 404, "not_found")
		return
	}
	s.mu.Lock()
	a := s.agents[r.PathValue("id")]
	if a == nil || a.user != u.ID {
		s.mu.Unlock()
		fail(w, 409, "bridge_offline")
		return
	}
	if len(a.tunnels) >= s.cfg.Connections.MaxTunnelsPerBridge {
		s.mu.Unlock()
		fail(w, 429, "quota_exceeded")
		return
	}
	// Revalidate while holding the same registry lock used by revocation.
	active, e := s.sessionActive(r.Context(), u.Hash)
	if e != nil || !active {
		s.mu.Unlock()
		fail(w, 401, "unauthorized")
		return
	}
	s.mu.Unlock()
	c, e := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if e != nil {
		return
	}
	c.SetReadLimit(int64(s.cfg.Connections.MaxWSMessageBytes - protocol.HeaderSize))
	s.mu.Lock()
	if s.agents[r.PathValue("id")] != a || len(a.tunnels) >= s.cfg.Connections.MaxTunnelsPerBridge {
		s.mu.Unlock()
		c.CloseNow()
		return
	}
	active, e = s.sessionActive(r.Context(), u.Hash)
	if e != nil || !active {
		s.mu.Unlock()
		c.CloseNow()
		return
	}
	p := transport.New(r.Context(), c, s.cfg.Connections.MaxBufferBytesPerTunnel)
	t := &tunnel{id: uuid.NewString(), request: uuid.NewString(), peer: p, session: u.Hash, ready: make(chan string, 1)}
	a.tunnels[t.id] = t
	s.mu.Unlock()
	defer func() {
		p.Close()
		s.mu.Lock()
		delete(a.tunnels, t.id)
		s.mu.Unlock()
		a.peer.Drop(t.id)
		if a.peer.Send(protocol.Control{Type: "close_tunnel", TunnelID: t.id, RequestID: t.request, ConnectionID: a.connection}) != nil {
			a.peer.Close()
		}
		s.audit(u.ID, "tunnel.close", t.id, "ok")
	}()
	p.Heartbeat(s.cfg.Connections.HeartbeatInterval, s.cfg.Connections.HeartbeatTimeout)
	expiry := time.AfterFunc(time.Until(u.Expires), p.Close)
	defer expiry.Stop()
	if a.peer.Send(protocol.Control{Type: "open_tunnel", TunnelID: t.id, RequestID: t.request, ConnectionID: a.connection}) != nil {
		return
	}
	select {
	case code := <-t.ready:
		if code != "" {
			return
		}
	case <-time.After(15 * time.Second):
		return
	case <-p.Done():
		return
	case <-a.peer.Done():
		return
	case <-r.Context().Done():
		return
	}
	s.audit(u.ID, "tunnel.open", t.id, "ok")
	// Browsers send only raw core bytes. No user-supplied routing identifiers are accepted.
	for {
		kind, b, e := c.Read(r.Context())
		if e != nil {
			return
		}
		if kind != websocket.MessageBinary {
			return
		}
		if a.peer.Data(t.id, b) != nil {
			return
		}
	}
}

func (s *Server) sessionActive(ctx context.Context, hash []byte) (bool, error) {
	ctx, cancel := context.WithTimeout(ctx, s.cfg.Database.QueryTimeout)
	defer cancel()
	var active bool
	e := s.db.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.session_token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND u.status='active' AND NOT u.must_change_password)", hash).Scan(&active)
	return active, e
}
