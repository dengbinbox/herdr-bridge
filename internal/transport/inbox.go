package transport

import "sync"

// Inbox bounds pending writes into a subprocess, so one blocked stdin never stalls the shared reader.
type Inbox struct {
	C           chan []byte
	mu          sync.Mutex
	size, limit int
}

func NewInbox(limit int) *Inbox { return &Inbox{C: make(chan []byte, 128), limit: limit} }
func (q *Inbox) Push(b []byte) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.size+len(b) > q.limit {
		return false
	}
	select {
	case q.C <- append([]byte(nil), b...):
		q.size += len(b)
		return true
	default:
		return false
	}
}
func (q *Inbox) Consumed(n int) { q.mu.Lock(); q.size -= n; q.mu.Unlock() }
