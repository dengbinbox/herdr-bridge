package client

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestReconnectBackoff(t *testing.T) {
	delay := time.Second
	for _, seconds := range []int{1, 5, 25, 125, 600, 600} {
		if delay != time.Duration(seconds)*time.Second {
			t.Fatalf("want %ds, got %s", seconds, delay)
		}
		delay = nextReconnectDelay(delay, 10*time.Minute)
	}
	if got := nextReconnectDelay(25*time.Second, 30*time.Second); got != 30*time.Second {
		t.Fatalf("custom maximum ignored: %s", got)
	}
}

func TestRunRetriesAndCancellationInterruptsBackoff(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	attempts := make(chan struct{}, 4)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts <- struct{}{}
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer server.Close()
	c := Config{ServerURL: server.URL}
	c.Connection.ReconnectMin = 1
	c.Connection.ReconnectMax = 600
	done := make(chan error, 1)
	go func() { done <- Run(ctx, c, "test") }()
	for i := 0; i < 2; i++ {
		select {
		case <-attempts:
		case <-time.After(4 * time.Second):
			t.Fatal("missing connection attempt")
		}
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("cancellation did not interrupt retry")
	}
}

func TestRunDoesNotRetryRejectedCredentials(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	c := Config{ServerURL: server.URL}
	if err := Run(ctx, c, "test"); !errors.Is(err, errPermanent) {
		t.Fatalf("want permanent rejection, got %v", err)
	}
}
