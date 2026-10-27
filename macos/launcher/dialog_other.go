//go:build !darwin

package main

import (
	"fmt"
	"os"
)

// showNativeDialog 非 macOS 平台只写 stderr。
func showNativeDialog(title, text string) {
	fmt.Fprintf(os.Stderr, "%s: %s\n", title, text)
}
