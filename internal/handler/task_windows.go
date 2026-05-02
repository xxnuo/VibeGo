//go:build windows

package handler

import (
	"os/exec"
	"strconv"
)

func newTaskCommand(command string) *exec.Cmd {
	return exec.Command("cmd.exe", "/d", "/s", "/c", command)
}
func killTaskProcess(cmd *exec.Cmd) error {
	return exec.Command("taskkill", "/F", "/T", "/PID", strconv.Itoa(cmd.Process.Pid)).Run()
}
