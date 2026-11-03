package server

import (
	"github.com/google/uuid"
	"net/http"
	"time"
)

func (s *Server) keys(w http.ResponseWriter, r *http.Request, u *session) {
	rows, e := s.db.Query(r.Context(), "SELECT id::text,public_id,name,created_at,expires_at,revoked_at,last_used_at FROM api_keys WHERE user_id=$1 ORDER BY created_at DESC", u.ID)
	if e != nil {
		fail(w, 500, "storage_error")
		return
	}
	defer rows.Close()
	out := []any{}
	for rows.Next() {
		var id, p, n string
		var created time.Time
		var expires, revoked, used *time.Time
		if rows.Scan(&id, &p, &n, &created, &expires, &revoked, &used) != nil {
			fail(w, 500, "storage_error")
			return
		}
		out = append(out, map[string]any{"id": id, "mask": "hbk_" + p + "_••••••••", "name": n, "created_at": created, "expires_at": expires, "revoked_at": revoked, "last_used_at": used})
	}
	if rows.Err() != nil {
		fail(w, 500, "storage_error")
		return
	}
	jsonReply(w, 200, out)
}

type keyInput struct {
	Name    string     `json:"name"`
	Expires *time.Time `json:"expires_at"`
}

func (s *Server) createKey(w http.ResponseWriter, r *http.Request, u *session) {
	s.issueKey(w, r, u, false)
}
func (s *Server) rotateKey(w http.ResponseWriter, r *http.Request, u *session) {
	if !validID(w, r) {
		return
	}
	s.issueKey(w, r, u, true)
}
func (s *Server) issueKey(w http.ResponseWriter, r *http.Request, u *session, rotate bool) {
	var b keyInput
	if !body(w, r, &b) {
		return
	}
	if len(b.Name) < 1 || len(b.Name) > 128 || (b.Expires != nil && !b.Expires.After(time.Now())) {
		fail(w, 400, "invalid_key")
		return
	}
	id, p, secret := uuid.NewString(), token(9), token(32)
	s.mu.Lock()
	tx, e := s.db.Begin(r.Context())
	if e != nil {
		s.mu.Unlock()
		fail(w, 500, "storage_error")
		return
	}
	defer tx.Rollback(r.Context())
	if rotate {
		tag, err := tx.Exec(r.Context(), "UPDATE api_keys SET revoked_at=now() WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL", r.PathValue("id"), u.ID)
		if err != nil || tag.RowsAffected() != 1 {
			s.mu.Unlock()
			fail(w, 404, "not_found")
			return
		}
	}
	_, e = tx.Exec(r.Context(), "INSERT INTO api_keys(id,public_id,secret_hash,user_id,name,expires_at) VALUES($1,$2,$3,$4,$5,$6)", id, p, digest(secret), u.ID, b.Name, b.Expires)
	if e == nil {
		e = tx.Commit(r.Context())
	}
	if e == nil && rotate {
		s.disconnectKeyLocked(r.PathValue("id"))
	}
	s.mu.Unlock()
	if e != nil {
		fail(w, 500, "storage_error")
		return
	}
	s.audit(u.ID, "key.create", id, "ok")
	if rotate {
		s.audit(u.ID, "key.rotate", r.PathValue("id"), "ok")
	}
	jsonReply(w, 201, map[string]any{"id": id, "key": "hbk_" + p + "_" + secret, "name": b.Name, "expires_at": b.Expires})
}
func (s *Server) revokeKey(w http.ResponseWriter, r *http.Request, u *session) {
	if !validID(w, r) {
		return
	}
	s.mu.Lock()
	tag, e := s.db.Exec(r.Context(), "UPDATE api_keys SET revoked_at=now() WHERE id=$1 AND user_id=$2", r.PathValue("id"), u.ID)
	if e == nil {
		s.disconnectKeyLocked(r.PathValue("id"))
	}
	s.mu.Unlock()
	if e != nil {
		fail(w, 500, "storage_error")
		return
	}
	if tag.RowsAffected() == 0 {
		fail(w, 404, "not_found")
		return
	}
	s.audit(u.ID, "key.revoke", r.PathValue("id"), "ok")
	jsonReply(w, 200, map[string]bool{"ok": true})
}
func (s *Server) bridges(w http.ResponseWriter, r *http.Request, u *session) {
	s.listBridges(w, r, u, false)
}
func (s *Server) bridgeDetail(w http.ResponseWriter, r *http.Request, u *session) {
	if !validID(w, r) {
		return
	}
	s.listBridges(w, r, u, true)
}
func (s *Server) listBridges(w http.ResponseWriter, r *http.Request, u *session, one bool) {
	q := "SELECT id::text,name,agent_version,os,last_connected_at FROM bridges WHERE user_id=$1"
	args := []any{u.ID}
	if one {
		q += " AND id=$2"
		args = append(args, r.PathValue("id"))
	}
	rows, e := s.db.Query(r.Context(), q+" ORDER BY name", args...)
	if e != nil {
		fail(w, 500, "storage_error")
		return
	}
	out := []map[string]any{}
	for rows.Next() {
		var id, n, v, o string
		var last time.Time
		if e = rows.Scan(&id, &n, &v, &o, &last); e != nil {
			rows.Close()
			fail(w, 500, "storage_error")
			return
		}
		out = append(out, map[string]any{"id": id, "name": n, "agent_version": v, "os": o, "last_connected_at": last})
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		fail(w, 500, "storage_error")
		return
	}
	// Never hold a PostgreSQL connection while waiting for the registry lock.
	s.mu.Lock()
	for _, record := range out {
		a, online := s.agents[record["id"].(string)]
		core := false
		if online {
			core = a.core
		}
		record["online"] = online
		record["core_available"] = core
	}
	s.mu.Unlock()
	if one {
		if len(out) == 0 {
			fail(w, 404, "not_found")
			return
		}
		jsonReply(w, 200, out[0])
	} else {
		jsonReply(w, 200, out)
	}
}
func (s *Server) users(w http.ResponseWriter, r *http.Request, u *session) {
	rows, e := s.db.Query(r.Context(), "SELECT id::text,username,role,status,must_change_password FROM users ORDER BY username")
	if e != nil {
		fail(w, 500, "storage_error")
		return
	}
	defer rows.Close()
	out := []any{}
	for rows.Next() {
		var id, n, role, status string
		var must bool
		if rows.Scan(&id, &n, &role, &status, &must) != nil {
			fail(w, 500, "storage_error")
			return
		}
		out = append(out, map[string]any{"id": id, "username": n, "role": role, "status": status, "must_change_password": must})
	}
	if rows.Err() != nil {
		fail(w, 500, "storage_error")
		return
	}
	jsonReply(w, 200, out)
}
func (s *Server) createUser(w http.ResponseWriter, r *http.Request, u *session) {
	var b struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if !body(w, r, &b) {
		return
	}
	if len(b.Username) < 1 || len(b.Username) > 128 || !validPassword(b.Password) {
		fail(w, 400, "invalid_user")
		return
	}
	id := uuid.NewString()
	_, e := s.db.Exec(r.Context(), "INSERT INTO users(id,username,password_hash,role) VALUES($1,$2,$3,'user')", id, b.Username, passwordHash(b.Password))
	if e != nil {
		fail(w, 409, "user_create_failed")
		return
	}
	s.audit(u.ID, "user.create", id, "ok")
	jsonReply(w, 201, map[string]string{"id": id, "username": b.Username})
}
func (s *Server) updateUser(w http.ResponseWriter, r *http.Request, u *session) {
	if !validID(w, r) {
		return
	}
	id := r.PathValue("id")
	var b struct {
		Status   *string `json:"status"`
		Password *string `json:"password"`
	}
	if !body(w, r, &b) {
		return
	}
	if (b.Status == nil && b.Password == nil) || (b.Status != nil && *b.Status != "active" && *b.Status != "disabled") || (b.Password != nil && !validPassword(*b.Password)) {
		fail(w, 400, "invalid_user")
		return
	}
	if id == u.ID {
		fail(w, 400, "use_own_password_endpoint")
		return
	}
	var hash *string
	if b.Password != nil {
		v := passwordHash(*b.Password)
		hash = &v
	}
	s.mu.Lock()
	tx, e := s.db.Begin(r.Context())
	if e != nil {
		s.mu.Unlock()
		fail(w, 500, "storage_error")
		return
	}
	defer tx.Rollback(r.Context())
	tag, e := tx.Exec(r.Context(), "UPDATE users SET status=COALESCE($1,status),password_hash=COALESCE($2,password_hash),must_change_password=CASE WHEN $2::text IS NULL THEN must_change_password ELSE true END WHERE id=$3 AND role='user'", b.Status, hash, id)
	if e == nil && tag.RowsAffected() == 1 {
		_, e = tx.Exec(r.Context(), "UPDATE sessions SET revoked_at=now() WHERE user_id=$1", id)
	}
	if e == nil {
		e = tx.Commit(r.Context())
	}
	if e == nil && tag.RowsAffected() == 1 {
		for _, a := range s.agents {
			if a.user == id {
				a.peer.Close()
			}
		}
	}
	s.mu.Unlock()
	if e != nil {
		fail(w, 500, "storage_error")
		return
	}
	if tag.RowsAffected() == 0 {
		fail(w, 404, "not_found")
		return
	}
	s.disconnectSessions(id, nil)
	s.audit(u.ID, "user.update", id, "ok")
	jsonReply(w, 200, map[string]bool{"ok": true})
}
func (s *Server) connections(w http.ResponseWriter, r *http.Request, u *session) {
	s.mu.Lock()
	out := []any{}
	for id, a := range s.agents {
		out = append(out, map[string]any{"bridge_id": id, "user_id": a.user, "connection_id": a.connection, "tunnels": len(a.tunnels), "core_available": a.core})
	}
	s.mu.Unlock()
	jsonReply(w, 200, out)
}
