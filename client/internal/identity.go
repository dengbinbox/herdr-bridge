package client

import (
	"encoding/json"
	"errors"
	"github.com/google/uuid"
	"os"
	"path/filepath"
)

func Identity(dir string) (string, func(), error) {
	if !filepath.IsAbs(dir) {
		return "", nil, errors.New("state directory must be absolute")
	}
	if e := os.MkdirAll(dir, 0700); e != nil {
		return "", nil, e
	}
	if e := protectState(dir); e != nil {
		return "", nil, e
	}
	release, e := lockState(filepath.Join(dir, "instance.lock"))
	if e != nil {
		return "", nil, e
	}
	path := filepath.Join(dir, "identity.json")
	var state struct {
		ID string `json:"bridge_id"`
	}
	b, e := os.ReadFile(path)
	if e == nil {
		if e = checkPrivate(path); e != nil {
			release()
			return "", nil, e
		}
		if json.Unmarshal(b, &state) != nil {
			release()
			return "", nil, errors.New("invalid identity state")
		}
		u, err := uuid.Parse(state.ID)
		if err != nil || u == uuid.Nil || u.String() != state.ID {
			release()
			return "", nil, errors.New("invalid identity UUID")
		}
		return state.ID, release, nil
	}
	if !os.IsNotExist(e) {
		release()
		return "", nil, e
	}
	state.ID = uuid.NewString()
	b, _ = json.Marshal(state)
	f, e := os.CreateTemp(dir, ".identity-*.tmp")
	if e == nil {
		temp := f.Name()
		defer os.Remove(temp)
		if e = protectState(temp); e != nil {
			f.Close()
			release()
			return "", nil, e
		}
		_, e = f.Write(b)
		if e == nil {
			e = f.Sync()
		}
		ce := f.Close()
		if e == nil {
			e = ce
		}
		if e == nil {
			e = os.Rename(temp, path)
		}
	}
	if e != nil {
		release()
		return "", nil, e
	}
	return state.ID, release, nil
}
