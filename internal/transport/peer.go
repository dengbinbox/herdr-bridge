// Package transport owns bounded, fair WebSocket output scheduling.
package transport

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/coder/websocket"
	"herdr-bridge/internal/protocol"
	"sync"
	"time"
)

var ErrFull = errors.New("queue limit exceeded")

type item struct {
	kind  websocket.MessageType
	data  []byte
	close bool
}
type Peer struct {
	Conn    *websocket.Conn
	ctx     context.Context
	cancel  context.CancelFunc
	mu      sync.Mutex
	control []item
	queues  map[string][]item
	bytes   map[string]int
	order   []string
	limit   int
	wake    chan struct{}
}

func New(ctx context.Context, c *websocket.Conn, limit int) *Peer {
	ctx, cancel := context.WithCancel(ctx)
	p := &Peer{Conn: c, ctx: ctx, cancel: cancel, queues: map[string][]item{}, bytes: map[string]int{}, limit: limit, wake: make(chan struct{}, 1)}
	go p.write()
	return p
}
func (p *Peer) Done() <-chan struct{} { return p.ctx.Done() }
func (p *Peer) Close()                { p.cancel(); p.Conn.CloseNow() }
func (p *Peer) Send(m protocol.Control) error {
	m.Version = protocol.Version
	b, e := json.Marshal(m)
	if e != nil {
		return e
	}
	return p.enqueue("", item{kind: websocket.MessageText, data: b})
}
func (p *Peer) Data(id string, b []byte) error {
	data, e := protocol.Encode(id, b)
	if e != nil {
		return e
	}
	return p.enqueue(id, item{kind: websocket.MessageBinary, data: data})
}
func (p *Peer) Raw(id string, b []byte) error {
	return p.enqueue(id, item{kind: websocket.MessageBinary, data: append([]byte(nil), b...)})
}
func (p *Peer) enqueue(id string, v item) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.ctx.Err() != nil {
		return p.ctx.Err()
	}
	if id == "" {
		if len(p.control) >= 128 {
			return ErrFull
		}
		p.control = append(p.control, v)
	} else {
		if p.bytes[id]+len(v.data) > p.limit || len(p.queues[id]) >= 1024 {
			return ErrFull
		}
		if len(p.queues[id]) == 0 {
			p.order = append(p.order, id)
		}
		p.queues[id] = append(p.queues[id], v)
		p.bytes[id] += len(v.data)
	}
	select {
	case p.wake <- struct{}{}:
	default:
	}
	return nil
}
func (p *Peer) Drop(id string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	delete(p.queues, id)
	delete(p.bytes, id)
	for i, s := range p.order {
		if s == id {
			p.order = append(p.order[:i], p.order[i+1:]...)
			break
		}
	}
}
func (p *Peer) next() (item, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.control) > 0 {
		v := p.control[0]
		p.control = p.control[1:]
		return v, true
	}
	if len(p.order) == 0 {
		return item{}, false
	}
	id := p.order[0]
	p.order = p.order[1:]
	q := p.queues[id]
	v := q[0]
	q = q[1:]
	p.bytes[id] -= len(v.data)
	if len(q) > 0 {
		p.queues[id] = q
		p.order = append(p.order, id)
	} else {
		delete(p.queues, id)
		delete(p.bytes, id)
	}
	return v, true
}
func (p *Peer) write() {
	defer p.Close()
	for {
		v, ok := p.next()
		if !ok {
			select {
			case <-p.ctx.Done():
				return
			case <-p.wake:
				continue
			}
		}
		if v.close {
			return
		}
		ctx, cancel := context.WithTimeout(p.ctx, 10*time.Second)
		err := p.Conn.Write(ctx, v.kind, v.data)
		cancel()
		if err != nil {
			return
		}
	}
}
func (p *Peer) Heartbeat(interval, timeout time.Duration) {
	go func() {
		t := time.NewTicker(interval)
		defer t.Stop()
		for {
			select {
			case <-p.ctx.Done():
				return
			case <-t.C:
				ctx, cancel := context.WithTimeout(p.ctx, timeout)
				err := p.Conn.Ping(ctx)
				cancel()
				if err != nil {
					p.Close()
					return
				}
			}
		}
	}()
}

// End preserves DATA-before-CLOSE ordering for a completed subprocess.
func (p *Peer) End(id string, m protocol.Control) error {
	m.Version = protocol.Version
	b, e := json.Marshal(m)
	if e != nil {
		return e
	}
	return p.enqueue(id, item{kind: websocket.MessageText, data: b})
}

// Finish closes a browser socket only after its already accepted output has drained.
func (p *Peer) Finish(id string) error { return p.enqueue(id, item{close: true}) }
