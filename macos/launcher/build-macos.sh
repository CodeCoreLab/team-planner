#!/bin/bash
# team-planner launcher —— macOS 交叉编译（在跳板机上跑）
#
# 产出：
#   team-planner-darwin-arm64    Mach-O，arm64
#   team-planner-darwin-amd64    Mach-O，x86_64
#   team-planner-universal       universal binary（arm64 + x86_64）
#
# 之所以在 Linux 上交叉编译：Go 支持纯 Go 交叉编译，
# 不需要 macOS SDK；但 Tauri / WPF 那类需要 macOS 宿主的工具链就做不到。
set -euo pipefail

export PATH=/opt/go/bin:/usr/bin:/bin
export GOPATH=/opt/gopath
export GOFLAGS=-mod=mod
export CGO_ENABLED=0

cd /root/build/tplauncher

echo "=== 1. 静态检查 ==="
go vet ./...

echo "=== 2. 编译 darwin/arm64 ==="
GOOS=darwin GOARCH=arm64 go build -trimpath -ldflags "-s -w" -o team-planner-darwin-arm64 .
file team-planner-darwin-arm64

echo "=== 3. 编译 darwin/amd64 ==="
GOOS=darwin GOARCH=amd64 go build -trimpath -ldflags "-s -w" -o team-planner-darwin-amd64 .
file team-planner-darwin-amd64

echo "=== 4. 合并 universal ==="
/usr/lib/llvm-18/bin/llvm-lipo -create \
  team-planner-darwin-arm64 team-planner-darwin-amd64 \
  -output team-planner-universal
file team-planner-universal
/usr/lib/llvm-18/bin/llvm-lipo -info team-planner-universal

echo "=== 5. sha256 ==="
sha256sum team-planner-darwin-arm64 team-planner-darwin-amd64 team-planner-universal

echo "=== 6. 回归：Windows 交叉编译（确认非 darwin 分支可编译） ==="
GOOS=windows GOARCH=amd64 go build -trimpath -ldflags "-s -w" -o team-planner-windows-amd64.exe . && echo "windows build OK"
GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "-s -w" -o team-planner-linux-amd64 . && echo "linux build OK"

echo "=== DONE ==="
ls -la team-planner-*
