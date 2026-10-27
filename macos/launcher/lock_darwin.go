//go:build darwin

package main

import (
	"os"
	"path/filepath"
	"syscall"
)

// acquireInstanceLock 取得单实例锁。
//
// macOS 没有 Windows 的 CreateMutexW 等价物，用 flock 文件锁实现：
// 锁文件放在用户数据目录（不能放 .app bundle 内，否则破坏代码签名）。
// 返回的释放函数解锁并关闭文件。
func acquireInstanceLock(path string) (func(), bool) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		// 建不出目录就不拦单实例，退化为"总是成功"，避免误报已在运行。
		return func() {}, true
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return func() {}, true
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = f.Close()
		return func() {}, false
	}
	return func() {
		_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
		_ = f.Close()
	}, true
}
