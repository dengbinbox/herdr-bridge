package client

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

// StartBackground waits until the child has loaded its configuration and locked
// its identity. Network connectivity is not required for startup.
func StartBackground(config, state string, dev bool) (int, string, error) {
	_, release, err := Identity(state)
	if err != nil {
		return 0, "", err
	}
	logPath := filepath.Join(state, "bridge.log")
	log, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		release()
		return 0, logPath, err
	}
	defer log.Close()
	err = protectState(logPath)
	release()
	if err != nil {
		return 0, logPath, err
	}
	executable, err := os.Executable()
	if err != nil {
		return 0, logPath, err
	}
	args := []string{"--background-child", "--config", config, "--state-dir", state}
	if dev {
		args = append(args, "--dev")
	}
	cmd := exec.Command(executable, args...)
	detach(cmd)
	cmd.Stderr = log
	reader, writer, err := os.Pipe()
	if err != nil {
		return 0, logPath, err
	}
	defer reader.Close()
	cmd.Stdout = writer
	err = cmd.Start()
	writer.Close()
	if err != nil {
		return 0, logPath, err
	}
	ready := make(chan bool, 1)
	go func() {
		scanner := bufio.NewScanner(reader)
		ready <- scanner.Scan() && scanner.Text() == "ready"
	}()
	timer := time.NewTimer(15 * time.Second)
	defer timer.Stop()
	select {
	case ok := <-ready:
		if ok {
			pid := cmd.Process.Pid
			return pid, logPath, cmd.Process.Release()
		}
	case <-timer.C:
	}
	cmd.Process.Kill()
	cmd.Wait()
	return 0, logPath, fmt.Errorf("child did not become ready; see %s", logPath)
}
