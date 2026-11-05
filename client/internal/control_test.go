package client

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

func TestControlStoppedAndStaleState(t *testing.T) {
	state := t.TempDir()
	if err := os.WriteFile(filepath.Join(state, "runtime.json"), []byte(`{"pid":1,"address":"127.0.0.1:1","token":"stale"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := Status(state); !errors.Is(err, ErrNotRunning) {
		t.Fatalf("status: %v", err)
	}
	if err := Stop(state); err != nil {
		t.Fatal(err)
	}
}

func TestControlLifecycle(t *testing.T) {
	state := t.TempDir()
	_, release, err := Identity(state)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	closeControl, err := StartControl(state, "/original/config.json", true, true, cancel)
	if err != nil {
		release()
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() { <-ctx.Done(); closeControl(); release(); close(done) }()
	defer func() { cancel(); <-done }()
	info, err := Status(state)
	if err != nil {
		t.Fatal(err)
	}
	if info.PID != os.Getpid() || info.Config != "/original/config.json" || !info.Dev {
		t.Fatalf("unexpected runtime metadata: %+v", info)
	}
	wrong := info
	wrong.Token = "wrong"
	if err := controlRequest(wrong, http.MethodPost, "/stop"); err == nil {
		t.Fatal("unauthenticated stop succeeded")
	}
	if ctx.Err() != nil {
		t.Fatal("unauthenticated stop cancelled the process")
	}
	if err := Stop(state); err != nil {
		t.Fatal(err)
	}
	<-done
	if _, err := os.Stat(filepath.Join(state, "runtime.json")); !os.IsNotExist(err) {
		t.Fatalf("runtime state not removed: %v", err)
	}
	if _, err := Status(state); !errors.Is(err, ErrNotRunning) {
		t.Fatalf("status after stop: %v", err)
	}
}

func TestControlRejectsNonLoopbackEndpoint(t *testing.T) {
	if err := controlRequest(RuntimeInfo{Address: "192.0.2.1:80", Token: "secret"}, http.MethodPost, "/stop"); err == nil {
		t.Fatal("accepted non-loopback endpoint")
	}
}
