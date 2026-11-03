//go:build !windows

package client

import (
	"errors"
	"os"
)

func checkPrivate(path string) error {
	st, e := os.Stat(path)
	if e != nil {
		return e
	}
	if st.Mode().Perm()&0077 != 0 {
		return errors.New("private files and directories must not be accessible to group or others")
	}
	return nil
}
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
