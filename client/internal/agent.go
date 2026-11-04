package client

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"github.com/coder/websocket"
	"github.com/google/uuid"
	"herdr-bridge/internal/protocol"
	"herdr-bridge/internal/transport"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os/exec"
	"runtime"
	"sync"
	"time"
)

var errPermanent = errors.New("server rejected registration; check key, identity, quota and protocol version")

type child struct {
	cancel  context.CancelFunc
	in      *transport.Inbox
	request string
	opened  bool
}
type link struct {
	cfg                          Config
	peer                         *transport.Peer
	id                           string
	mu                           sync.Mutex
	children                     map[string]*child
	seen                         map[string]string
	requests                     map[string]string
	limit, maxMessage, maxBuffer int
	wg                           sync.WaitGroup
}

func Run(ctx context.Context, c Config, id string) error {
	delay := time.Duration(c.Connection.ReconnectMin) * time.Second
	max := time.Duration(c.Connection.ReconnectMax) * time.Second
	for {
		start := time.Now()
		e := connect(ctx, c, id)
		if ctx.Err() != nil {
			return nil
		}
		if errors.Is(e, errPermanent) {
			return e
		}
		if time.Since(start) > time.Minute {
			delay = time.Duration(c.Connection.ReconnectMin) * time.Second
		}
		slog.Warn("bridge disconnected; reconnect scheduled", "retry_in", delay)
		t := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			t.Stop()
			return nil
		case <-t.C:
		}
		delay = nextReconnectDelay(delay, max)
	}
}
func nextReconnectDelay(delay, max time.Duration) time.Duration {
	if delay > max/5 {
		return max
	}
	return delay * 5
}

func connect(ctx context.Context, c Config, id string) error {
	u, _ := url.Parse(c.ServerURL)
	if u.Scheme == "https" {
		u.Scheme = "wss"
	} else {
		u.Scheme = "ws"
	}
	u.Path = "/bridge/v1/connect"
	dial, cancel := context.WithTimeout(ctx, 15*time.Second)
	ws, res, e := websocket.Dial(dial, u.String(), &websocket.DialOptions{HTTPClient: &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, HTTPHeader: http.Header{"Authorization": []string{"Bearer " + c.Key}}})
	cancel()
	if e != nil {
		if res != nil && res.Body != nil {
			res.Body.Close()
		}
		if res != nil && (res.StatusCode == 401 || res.StatusCode == 403) {
			return errPermanent
		}
		return errors.New("connection unavailable")
	}
	defer ws.CloseNow()
	ws.SetReadLimit(16 << 20)
	hello := protocol.Control{Type: "register", Version: protocol.Version, BridgeID: id, Name: c.Name, AgentVersion: protocol.AgentVersion, OS: runtime.GOOS, Capabilities: []string{"core-stream-v1"}}
	b, _ := json.Marshal(hello)
	handshake, done := context.WithTimeout(ctx, 10*time.Second)
	defer done()
	if e = ws.Write(handshake, websocket.MessageText, b); e != nil {
		return e
	}
	kind, b, e := ws.Read(handshake)
	if e != nil {
		return e
	}
	m, e := protocol.DecodeControl(b)
	if e != nil || kind != websocket.MessageText || m.Type != "registered" {
		return errPermanent
	}
	capable := false
	for _, capability := range m.Capabilities {
		if capability == "core-stream-v1" {
			capable = true
		}
	}
	if !capable {
		return errPermanent
	}
	if _, e = uuid.Parse(m.ConnectionID); e != nil {
		return errPermanent
	}
	if m.MaxMessageBytes < 1024 || m.MaxMessageBytes > 16<<20 || m.MaxBufferBytes < m.MaxMessageBytes || m.MaxBufferBytes > 64<<20 || m.MaxTunnels < 1 || m.MaxTunnels > 1024 {
		return errPermanent
	}
	ws.SetReadLimit(int64(m.MaxMessageBytes))
	ctx, stop := context.WithCancel(ctx)
	defer stop()
	p := transport.New(ctx, ws, m.MaxBufferBytes)
	defer p.Close()
	l := &link{cfg: c, peer: p, id: m.ConnectionID, children: map[string]*child{}, seen: map[string]string{}, requests: map[string]string{}, limit: m.MaxTunnels, maxMessage: m.MaxMessageBytes, maxBuffer: m.MaxBufferBytes}
	defer func() {
		stop()
		l.mu.Lock()
		for _, ch := range l.children {
			ch.cancel()
		}
		l.mu.Unlock()
		l.wg.Wait()
	}()
	if m.HeartbeatIntervalMS < 100 || m.HeartbeatTimeoutMS < m.HeartbeatIntervalMS {
		return errPermanent
	}
	p.Heartbeat(time.Duration(m.HeartbeatIntervalMS)*time.Millisecond, time.Duration(m.HeartbeatTimeoutMS)*time.Millisecond)
	slog.Info("bridge registered", "bridge_id", id)
	l.wg.Add(1)
	go func() { defer l.wg.Done(); l.probe(ctx) }()
	for {
		kind, b, e = ws.Read(ctx)
		if e != nil {
			return e
		}
		if kind == websocket.MessageBinary {
			tid, data, err := protocol.Decode(b)
			if err != nil {
				return err
			}
			l.mu.Lock()
			ch := l.children[tid]
			if ch != nil && !ch.in.Push(data) {
				ch.cancel()
			}
			l.mu.Unlock()
			continue
		}
		m, e = protocol.DecodeControl(b)
		if e != nil || m.ConnectionID != l.id {
			return errors.New("invalid control")
		}
		switch m.Type {
		case "open_tunnel":
			if !protocol.ValidID(m.TunnelID) || !protocol.ValidID(m.RequestID) {
				return errors.New("invalid tunnel")
			}
			l.open(ctx, m)
		case "close_tunnel":
			l.mu.Lock()
			if ch := l.children[m.TunnelID]; ch != nil && ch.request == m.RequestID {
				ch.cancel()
			}
			l.mu.Unlock()
		case "error":
			return errPermanent
		default:
			return errors.New("unexpected control")
		}
	}
}
func (l *link) send(m protocol.Control) {
	m.ConnectionID = l.id
	if l.peer.Send(m) != nil {
		l.peer.Close()
	}
}
func (l *link) open(ctx context.Context, m protocol.Control) {
	l.mu.Lock()
	if previous, ok := l.requests[m.RequestID]; ok && previous != m.TunnelID {
		l.mu.Unlock()
		l.send(protocol.Control{Type: "error", Code: "identity_conflict", TunnelID: m.TunnelID, RequestID: m.RequestID})
		return
	}
	if ch := l.children[m.TunnelID]; ch != nil {
		same := ch.request == m.RequestID
		opened := ch.opened
		l.mu.Unlock()
		if same && opened {
			l.send(protocol.Control{Type: "tunnel_opened", TunnelID: m.TunnelID, RequestID: m.RequestID})
		}
		if !same {
			l.send(protocol.Control{Type: "error", TunnelID: m.TunnelID, RequestID: m.RequestID, Code: "identity_conflict"})
		}
		return
	}
	if _, ok := l.seen[m.TunnelID]; ok {
		l.mu.Unlock()
		l.send(protocol.Control{Type: "tunnel_closed", TunnelID: m.TunnelID, RequestID: m.RequestID})
		return
	}
	if len(l.children) >= l.limit || len(l.seen) >= 100000 {
		l.mu.Unlock()
		l.send(protocol.Control{Type: "error", TunnelID: m.TunnelID, RequestID: m.RequestID, Code: "quota_exceeded"})
		return
	}
	ctx, cancel := context.WithCancel(ctx)
	ch := &child{cancel: cancel, in: transport.NewInbox(l.maxBuffer), request: m.RequestID}
	l.children[m.TunnelID] = ch
	l.seen[m.TunnelID] = m.RequestID
	l.requests[m.RequestID] = m.TunnelID
	l.wg.Add(1)
	l.mu.Unlock()
	go func() {
		graceful := false
		defer l.wg.Done()
		defer cancel()
		defer func() {
			l.mu.Lock()
			delete(l.children, m.TunnelID)
			l.mu.Unlock()
			closed := protocol.Control{Type: "tunnel_closed", TunnelID: m.TunnelID, RequestID: m.RequestID, ConnectionID: l.id}
			if graceful {
				if l.peer.End(m.TunnelID, closed) != nil {
					l.peer.Drop(m.TunnelID)
					l.send(closed)
				}
			} else {
				l.peer.Drop(m.TunnelID)
				l.send(closed)
			}
		}()
		cmd := exec.CommandContext(ctx, l.cfg.Core.Binary, "connect")
		cmd.Env = l.cfg.environment()
		var diagnostics stderrSummary
		cmd.Stderr = &diagnostics
		cmd.WaitDelay = 2 * time.Second
		in, e := cmd.StdinPipe()
		if e != nil {
			return
		}
		defer in.Close()
		out, e := cmd.StdoutPipe()
		if e != nil {
			return
		}
		if e = cmd.Start(); e != nil {
			l.send(protocol.Control{Type: "error", TunnelID: m.TunnelID, RequestID: m.RequestID, Code: "core_unavailable"})
			return
		}
		stopPipes := context.AfterFunc(ctx, func() { in.Close(); out.Close() })
		defer stopPipes()
		defer func() {
			cancel()
			if e := cmd.Wait(); e != nil {
				slog.Debug("core connector closed", "stderr_bytes_capped", diagnostics.Bytes())
			}
		}()
		l.mu.Lock()
		ch.opened = true
		l.mu.Unlock()
		l.send(protocol.Control{Type: "tunnel_opened", TunnelID: m.TunnelID, RequestID: m.RequestID})
		written := make(chan struct{})
		go func() {
			defer close(written)
			for {
				select {
				case <-ctx.Done():
					return
				case data := <-ch.in.C:
					_, err := in.Write(data)
					ch.in.Consumed(len(data))
					if err != nil {
						cancel()
						return
					}
				}
			}
		}()
		defer func() { cancel(); in.Close(); <-written }()
		size := 32 * 1024
		if size > l.maxMessage-protocol.HeaderSize {
			size = l.maxMessage - protocol.HeaderSize
		}
		buf := make([]byte, size)
		for {
			n, e := out.Read(buf)
			if n > 0 {
				if l.peer.Data(m.TunnelID, buf[:n]) != nil {
					return
				}
			}
			if e != nil {
				graceful = ctx.Err() == nil
				return
			}
		}
	}()
}
func (l *link) probe(ctx context.Context) {
	for {
		ok := l.coreAvailable(ctx)
		l.send(protocol.Control{Type: "status", CoreAvailable: &ok})
		select {
		case <-ctx.Done():
			return
		case <-time.After(15 * time.Second):
		}
	}
}
func (l *link) coreAvailable(parent context.Context) bool {
	ctx, cancel := context.WithTimeout(parent, 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, l.cfg.Core.Binary, "connect")
	cmd.Env = l.cfg.environment()
	var diagnostics stderrSummary
	cmd.Stderr = &diagnostics
	cmd.WaitDelay = time.Second
	in, e := cmd.StdinPipe()
	if e != nil {
		return false
	}
	defer in.Close()
	out, e := cmd.StdoutPipe()
	if e != nil {
		return false
	}
	if cmd.Start() != nil {
		return false
	}
	stopPipes := context.AfterFunc(ctx, func() { in.Close(); out.Close() })
	defer stopPipes()
	defer func() {
		cancel()
		if e := cmd.Wait(); e != nil {
			slog.Debug("core connector closed", "stderr_bytes_capped", diagnostics.Bytes())
		}
	}()
	if _, e = io.WriteString(in, "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"hello\",\"params\":{\"generation\":1}}\n"); e != nil {
		return false
	}
	line, e := bufio.NewReader(io.LimitReader(out, 65536)).ReadBytes('\n')
	if e != nil {
		return false
	}
	var reply struct {
		ID     int             `json:"id"`
		Result json.RawMessage `json:"result"`
	}
	return json.Unmarshal(line, &reply) == nil && reply.ID == 1 && len(reply.Result) > 0
}
