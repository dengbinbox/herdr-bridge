package server

import (
	"context"
	"embed"
	"errors"
	"fmt"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"os"
	"time"
)

//go:embed migrations/*.sql
var migrations embed.FS

func OpenDB(ctx context.Context, c Config) (*pgxpool.Pool, error) {
	dsn := os.Getenv(c.Database.DSNEnv)
	if dsn == "" {
		return nil, errors.New("database environment variable is empty")
	}
	pc, e := pgxpool.ParseConfig(dsn)
	if e != nil {
		return nil, errors.New("invalid database DSN")
	}
	pc.MaxConns = c.Database.MaxConns
	pc.MinConns = c.Database.MinConns
	pc.MaxConnLifetime = c.Database.MaxConnLifetime
	pc.ConnConfig.ConnectTimeout = c.Database.ConnectTimeout
	pc.ConnConfig.RuntimeParams["statement_timeout"] = fmt.Sprint(c.Database.QueryTimeout.Milliseconds())
	db, e := pgxpool.NewWithConfig(ctx, pc)
	if e != nil {
		return nil, errors.New("database pool initialization failed")
	}
	ctx, cancel := context.WithTimeout(ctx, c.Database.ConnectTimeout+c.Database.QueryTimeout)
	defer cancel()
	if e = db.Ping(ctx); e != nil {
		db.Close()
		return nil, errors.New("database connection failed")
	}
	if e = migrate(ctx, db, c); e != nil {
		db.Close()
		return nil, e
	}
	return db, nil
}
func migrate(ctx context.Context, db *pgxpool.Pool, c Config) error {
	tx, e := db.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(7149823501)"); e != nil {
		return e
	}
	if _, e = tx.Exec(ctx, "CREATE TABLE IF NOT EXISTS schema_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"); e != nil {
		return e
	}
	var version int
	if e = tx.QueryRow(ctx, "SELECT COALESCE(max(version),0) FROM schema_migrations").Scan(&version); e != nil {
		return e
	}
	if version > 1 {
		return errors.New("database schema is newer than server")
	}
	if version == 0 {
		b, _ := migrations.ReadFile("migrations/001_initial.sql")
		if _, e = tx.Exec(ctx, string(b)); e != nil {
			return e
		}
		if _, e = tx.Exec(ctx, "INSERT INTO schema_migrations(version) VALUES(1)"); e != nil {
			return e
		}
	}
	var count int
	if e = tx.QueryRow(ctx, "SELECT count(*) FROM users").Scan(&count); e != nil {
		return e
	}
	if count == 0 {
		p := os.Getenv(c.Auth.BootstrapAdmin.PasswordEnv)
		if !validPassword(p) {
			return errors.New("initial admin password must contain 12 to 1024 bytes")
		}
		_, e = tx.Exec(ctx, "INSERT INTO users(id,username,password_hash,role,must_change_password) VALUES($1,$2,$3,'admin',$4)", uuid.NewString(), c.Auth.BootstrapAdmin.Username, passwordHash(p), c.Auth.BootstrapAdmin.RequirePasswordChange)
		if e != nil {
			return e
		}
	}
	return tx.Commit(ctx)
}
func (s *Server) audit(actor, action, target, result string) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	var a any
	if actor != "" {
		a = actor
	}
	if _, e := s.db.Exec(ctx, "INSERT INTO audit_events(actor,action,target,result) VALUES($1,$2,$3,$4)", a, action, target, result); e != nil {
		s.log.Warn("audit write failed", "action", action)
	}
}
