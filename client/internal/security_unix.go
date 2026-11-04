//go:build !windows

package client

import (
	"os"
)

func protectState(path string) error {
	st, e := os.Stat(path)
	if e != nil {
		return e
	}
	if st.IsDir() {
		return os.Chmod(path, 0700)
	}
	return os.Chmod(path, 0600)
}
