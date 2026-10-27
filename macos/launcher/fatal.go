package main

import "os"

// fatal 报告致命错误：写日志 + 弹原生对话框 + 退出进程。
//
// macOS 从 Finder 启动 .app 时没有终端，stderr 不可见，
// 不弹对话框等于什么都没告诉用户。
func fatal(title, detail string) {
	logf("FATAL %s: %s", title, detail)
	showNativeDialog(title, detail)
	os.Exit(1)
}
