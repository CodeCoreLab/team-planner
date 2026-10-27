//go:build darwin

package main

import (
	"os"
	"os/exec"
	"strings"
)

// browserInfo 描述一个可用的 Chromium 内核浏览器。
type browserInfo struct {
	name string
	path string
}

// browserCandidates 按优先级列出 Chromium 内核浏览器。
//
// 只认 Edge 与 Chrome：它们都支持 File System Access API
// （showDirectoryPicker），Safari 不支持 —— 这是「连接目录」功能的前提。
func browserCandidates() []browserInfo {
	return []browserInfo{
		{"Microsoft Edge", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"},
		{"Google Chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"},
		{"Microsoft Edge Beta", "/Applications/Microsoft Edge Beta.app/Contents/MacOS/Microsoft Edge Beta"},
		{"Google Chrome Beta", "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta"},
		{"Chromium", "/Applications/Chromium.app/Contents/MacOS/Chromium"},
	}
}

func pickBrowser() (browserInfo, bool) {
	for _, b := range browserCandidates() {
		if st, err := os.Stat(b.path); err == nil && !st.IsDir() {
			return b, true
		}
	}
	// 兜底：PATH 里找
	for _, name := range []string{"microsoft-edge", "google-chrome", "chromium"} {
		if p, err := exec.LookPath(name); err == nil {
			return browserInfo{name, p}, true
		}
	}
	return browserInfo{}, false
}

// browserRunning 判断指定 profile 目录是否仍被浏览器进程占用。
//
// 不用 cmd.Wait()：Chromium 启动器进程会先退出，真正干活的是另一个进程。
// 改用 ps 扫命令行，命中 --user-data-dir=<profileDir> 即认为仍在运行。
func browserRunning(profileDir string) bool {
	out, err := exec.Command("/bin/ps", "-ax", "-o", "command=").Output()
	if err != nil {
		// 探测失败时保守认为还在运行，避免服务被过早关掉
		return true
	}
	needle := "--user-data-dir=" + profileDir
	for _, line := range strings.Split(string(out), "\n") {
		if strings.Contains(line, needle) {
			return true
		}
	}
	return false
}
