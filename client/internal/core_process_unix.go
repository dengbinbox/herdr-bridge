//go:build !windows

package client

import "os/exec"

func configureCoreProcess(cmd *exec.Cmd) {}
