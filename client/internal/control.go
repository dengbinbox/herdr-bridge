package client

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

var ErrNotRunning = errors.New("bridge is not running")

// RuntimeInfo identifies the authenticated local control endpoint, not a PID to kill.
type RuntimeInfo struct {
	PID        int    `json:"pid"`
	Address    string `json:"address"`
	Token      string `json:"token"`
	Config     string `json:"config"`
	Dev        bool   `json:"dev"`
	Background bool   `json:"background"`
}

// StartControl must be called while holding the instance lock. Close it before
// releasing that lock so a replacement instance cannot lose its state file.
func StartControl(state, config string, dev, background bool, cancel context.CancelFunc) (func(), error) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	token := make([]byte, 32)
	if _, err = rand.Read(token); err != nil {
		listener.Close()
		return nil, err
	}
	info := RuntimeInfo{PID: os.Getpid(), Address: listener.Addr().String(), Token: hex.EncodeToString(token), Config: config, Dev: dev, Background: background}
	server := &http.Server{ReadHeaderTimeout: 2 * time.Second, IdleTimeout: 5 * time.Second}
	server.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+info.Token)) != 1 {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/status":
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(info)
		case r.Method == http.MethodPost && r.URL.Path == "/stop":
			w.WriteHeader(http.StatusOK)
			if f, ok := w.(http.Flusher); ok {
				f.Flush()
			}
			cancel()
		default:
			http.NotFound(w, r)
		}
	})
	path := filepath.Join(state, "runtime.json")
	data, _ := json.Marshal(info)
	f, err := os.CreateTemp(state, ".runtime-*.tmp")
	if err != nil {
		listener.Close()
		return nil, err
	}
	temp := f.Name()
	defer os.Remove(temp)
	if err = protectState(temp); err == nil {
		_, err = f.Write(data)
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	// A stale file can remain after a crash; the instance lock makes removal safe.
	if err == nil {
		err = os.Remove(path)
		if os.IsNotExist(err) {
			err = nil
		}
	}
	if err == nil {
		err = os.Rename(temp, path)
	}
	if err != nil {
		listener.Close()
		return nil, err
	}
	go server.Serve(listener)
	return func() { server.Close(); os.Remove(path) }, nil
}

func instanceStopped(state string) (bool, error) {
	if !filepath.IsAbs(state) {
		return false, errors.New("state directory must be absolute")
	}
	if _, err := os.Stat(state); os.IsNotExist(err) {
		return true, nil
	} else if err != nil {
		return false, err
	}
	release, err := lockState(filepath.Join(state, "instance.lock"))
	if err != nil {
		return false, nil
	}
	release()
	return true, nil
}

func controlRequest(info RuntimeInfo, method, path string) error {
	host, _, err := net.SplitHostPort(info.Address)
	if err != nil || host != "127.0.0.1" || info.Token == "" {
		return errors.New("invalid local control endpoint")
	}
	req, err := http.NewRequest(method, "http://"+info.Address+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+info.Token)
	transport := &http.Transport{Proxy: nil}
	defer transport.CloseIdleConnections()
	c := &http.Client{Timeout: 2 * time.Second, Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := c.Do(req)
	if err != nil {
		return fmt.Errorf("local control unavailable: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("local control returned HTTP %d", res.StatusCode)
	}
	return nil
}

func Status(state string) (RuntimeInfo, error) {
	var info RuntimeInfo
	stopped, err := instanceStopped(state)
	if err != nil {
		return info, err
	}
	if stopped {
		return info, ErrNotRunning
	}
	data, err := os.ReadFile(filepath.Join(state, "runtime.json"))
	if err != nil {
		return info, fmt.Errorf("instance is locked but local control is unavailable (starting, stopping, or older client): %w", err)
	}
	if err = json.Unmarshal(data, &info); err != nil {
		return info, err
	}
	return info, controlRequest(info, http.MethodGet, "/status")
}

func Stop(state string) error {
	info, err := Status(state)
	if errors.Is(err, ErrNotRunning) {
		return nil
	}
	if err != nil {
		return err
	}
	if err = controlRequest(info, http.MethodPost, "/stop"); err != nil {
		return err
	}
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		stopped, err := instanceStopped(state)
		if err != nil {
			return err
		}
		if stopped {
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	return errors.New("timed out waiting for bridge to stop; no process was forcibly killed")
}
