// Package protocol defines version 1 of the bridge wire protocol.
package protocol

import (
	"encoding/json"
	"errors"
	"github.com/google/uuid"
)

const Version = 1
const HeaderSize = 18
const Data = 1
const AgentVersion = "0.1.0"

type Control struct {
	Type                string   `json:"type"`
	Version             int      `json:"version"`
	RequestID           string   `json:"request_id,omitempty"`
	BridgeID            string   `json:"bridge_id,omitempty"`
	TunnelID            string   `json:"tunnel_id,omitempty"`
	ConnectionID        string   `json:"connection_id,omitempty"`
	Name                string   `json:"name,omitempty"`
	AgentVersion        string   `json:"agent_version,omitempty"`
	OS                  string   `json:"os,omitempty"`
	Capabilities        []string `json:"capabilities,omitempty"`
	Code                string   `json:"code,omitempty"`
	CoreAvailable       *bool    `json:"core_available,omitempty"`
	MaxMessageBytes     int      `json:"max_message_bytes,omitempty"`
	MaxBufferBytes      int      `json:"max_buffer_bytes,omitempty"`
	MaxTunnels          int      `json:"max_tunnels,omitempty"`
	HeartbeatIntervalMS int      `json:"heartbeat_interval_ms,omitempty"`
	HeartbeatTimeoutMS  int      `json:"heartbeat_timeout_ms,omitempty"`
}

func DecodeControl(b []byte) (Control, error) {
	var m Control
	if len(b) > 16384 {
		return m, errors.New("control too large")
	}
	if err := json.Unmarshal(b, &m); err != nil {
		return m, err
	}
	if m.Version != Version {
		return m, errors.New("incompatible_version")
	}
	bad := func() (Control, error) { return m, errors.New("invalid control fields") }
	switch m.Type {
	case "register":
		if !ValidID(m.BridgeID) || len(m.Name) < 1 || len(m.Name) > 128 || len(m.OS) < 1 || len(m.OS) > 64 || len(m.AgentVersion) < 1 || len(m.AgentVersion) > 64 || len(m.Capabilities) == 0 {
			return bad()
		}
	case "registered":
		if !ValidID(m.ConnectionID) || len(m.Capabilities) == 0 || m.MaxMessageBytes < 1024 || m.MaxMessageBytes > 16<<20 || m.MaxBufferBytes < m.MaxMessageBytes || m.MaxBufferBytes > 64<<20 || m.MaxTunnels < 1 || m.MaxTunnels > 1024 || m.HeartbeatIntervalMS < 100 || m.HeartbeatTimeoutMS < m.HeartbeatIntervalMS {
			return bad()
		}
	case "open_tunnel", "tunnel_opened", "close_tunnel", "tunnel_closed":
		if !ValidID(m.ConnectionID) || !ValidID(m.TunnelID) || !ValidID(m.RequestID) {
			return bad()
		}
	case "status":
		if !ValidID(m.ConnectionID) || m.CoreAvailable == nil {
			return bad()
		}
	case "error":
		if m.Code == "" || len(m.Code) > 64 || (m.ConnectionID != "" && !ValidID(m.ConnectionID)) || (m.TunnelID != "" && !ValidID(m.TunnelID)) || (m.RequestID != "" && !ValidID(m.RequestID)) {
			return bad()
		}
	default:
		return m, errors.New("unknown control")
	}
	return m, nil
}
func Encode(id string, payload []byte) ([]byte, error) {
	u, e := uuid.Parse(id)
	if !ValidID(id) {
		return nil, errors.New("invalid tunnel UUID")
	}
	if e != nil {
		return nil, e
	}
	b := make([]byte, HeaderSize+len(payload))
	b[0] = Version
	b[1] = Data
	copy(b[2:18], u[:])
	copy(b[18:], payload)
	return b, nil
}
func Decode(b []byte) (string, []byte, error) {
	if len(b) < HeaderSize || b[0] != Version || b[1] != Data {
		return "", nil, errors.New("invalid envelope")
	}
	u, e := uuid.FromBytes(b[2:18])
	if u == uuid.Nil {
		return "", nil, errors.New("invalid tunnel UUID")
	}
	if e != nil {
		return "", nil, e
	}
	return u.String(), b[18:], nil
}

// UUID strings are canonical so alternate spellings cannot bypass the online registry.
func ValidID(id string) bool {
	u, e := uuid.Parse(id)
	return e == nil && u != uuid.Nil && u.String() == id
}
