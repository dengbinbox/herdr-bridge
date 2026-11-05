package client

import (
	"os/exec"
	"syscall"
)

func configureCoreProcess(cmd *exec.Cmd) {
	// Connect exchanges RPC over pipes and must not allocate a console when
	// launched by the detached bridge, including during health checks.
	const createNoWindow = 0x08000000
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: createNoWindow,
		HideWindow:    true,
	}
}
