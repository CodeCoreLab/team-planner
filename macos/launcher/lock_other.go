//go:build !darwin

package main

import (
	"os"
	"path/filepath"
)

// acquireInstanceLock 的非 macOS 版本。
//
// Windows/Linux 上本项目只是做交叉编译回归验证，不参与实际分发，
// 因此这里不实现真正的文件锁，只保证能编译通过。
func acquireInstanceLock(path string) (func(), bool) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return func() {}, true
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return func() {}, true
	}
	return func() { _ = f.Close() }, true
}
