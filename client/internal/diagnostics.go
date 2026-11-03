package client

import "sync/atomic"

// stderrSummary drains stderr separately from stdout, retaining only a capped
// byte count. Raw hc diagnostics may contain paths, arguments or credentials.
type stderrSummary struct{ bytes atomic.Uint64 }

func (s *stderrSummary) Write(b []byte) (int, error) {
	for {
		old := s.bytes.Load()
		next := old + uint64(len(b))
		if next > 65536 {
			next = 65536
		}
		if s.bytes.CompareAndSwap(old, next) {
			return len(b), nil
		}
	}
}
func (s *stderrSummary) Bytes() uint64 { return s.bytes.Load() }
