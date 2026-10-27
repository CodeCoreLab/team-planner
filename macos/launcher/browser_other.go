//go:build !darwin

package main

import "os/exec"

// browserInfo 描述一个可用的 Chromium 内核浏览器。
type browserInfo struct {
	name string
	path string
}

// browserCandidates 非 macOS 平台不提供浏览器探测（仅用于交叉编译回归验证）。
func browserCandidates() []browserInfo { return nil }

func pickBrowser() (browserInfo, bool) {
	for _, name := range []string{"microsoft-edge", "google-chrome", "chromium"} {
		if p, err := exec.LookPath(name); err == nil {
			return browserInfo{name, p}, true
		}
	}
	return browserInfo{}, false
}

// browserRunning 非 macOS 平台的进程探测桩。
func browserRunning(profileDir string) bool { return false }
