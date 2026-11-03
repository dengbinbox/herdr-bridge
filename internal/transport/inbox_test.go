package transport

import (
	"sync"
	"testing"
)

func TestInboxBoundIncludesInFlight(t *testing.T) {
	q := NewInbox(5)
	b := []byte("12345")
	if !q.Push(b) {
		t.Fatal("push")
	}
	b[0] = 'x'
	got := <-q.C
	if string(got) != "12345" {
		t.Fatal("borrowed mutable memory")
	}
	if q.Push([]byte("x")) {
		t.Fatal("in-flight bytes weren't counted")
	}
	q.Consumed(len(got))
	if !q.Push([]byte("x")) {
		t.Fatal("credit not released")
	}
}
func TestInboxConcurrency(t *testing.T) {
	q := NewInbox(1024)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 1000; j++ {
				q.Push([]byte("payload"))
				select {
				case b := <-q.C:
					q.Consumed(len(b))
				default:
				}
			}
		}()
	}
	wg.Wait()
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.size < 0 || q.size > q.limit {
		t.Fatalf("size=%d", q.size)
	}
}
