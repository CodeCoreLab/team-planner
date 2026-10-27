//go:build darwin

package main

import "os/exec"

// 致命错误弹窗脚本。
//
// macOS 从 Finder 启动 .app 时没有终端，stderr 不可见，
// 直接打印错误等于什么都没告诉用户，必须弹原生对话框。
// 参数用 argv 传入，避免引号与转义问题。
const dialogScript = `on run argv
display alert (item 1 of argv) message (item 2 of argv) buttons {"好"} default button 1 with icon caution
end run`

func showNativeDialog(title, text string) {
	cmd := exec.Command("/usr/bin/osascript", "-e", dialogScript, title, text)
	_ = cmd.Run()
}
