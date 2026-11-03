package transport

import (
	"context"
	"herdr-bridge/internal/protocol"
	"testing"
)

func queuedPeer(limit int) *Peer {
	return &Peer{ctx: context.Background(), queues: map[string][]item{}, bytes: map[string]int{}, limit: limit, wake: make(chan struct{}, 1)}
}
func TestFairSchedulingAndControlPriority(t *testing.T) {
	p := queuedPeer(1024)
	for _, id := range []string{"a", "a", "b", "b"} {
		if e := p.Raw(id, []byte(id)); e != nil {
			t.Fatal(e)
		}
	}
	if e := p.Send(protocol.Control{Type: "status"}); e != nil {
		t.Fatal(e)
	}
	first, _ := p.next()
	if first.kind != 1 {
		t.Fatal("control not prioritized")
	}
	for _, want := range []string{"a", "b", "a", "b"} {
		v, ok := p.next()
		if !ok || string(v.data) != want {
			t.Fatalf("fair order want %s got %s", want, v.data)
		}
	}
}
func TestSlowTunnelDoesNotConsumeOtherQueue(t *testing.T) {
	p := queuedPeer(3)
	if p.Raw("slow", []byte("123")) != nil {
		t.Fatal("first write")
	}
	if p.Raw("slow", []byte("4")) != ErrFull {
		t.Fatal("unbounded queue")
	}
	if p.Raw("fast", []byte("ok")) != nil {
		t.Fatal("slow blocked fast")
	}
	p.Drop("slow")
	v, _ := p.next()
	if string(v.data) != "ok" {
		t.Fatal("drop affected another tunnel")
	}
}
func TestEndFollowsData(t *testing.T) {
	p := queuedPeer(1024)
	p.Raw("x", []byte("last output"))
	p.End("x", protocol.Control{Type: "tunnel_closed"})
	a, _ := p.next()
	b, _ := p.next()
	if a.kind != 2 || b.kind != 1 {
		t.Fatal("terminal close overtook final output")
	}
}
