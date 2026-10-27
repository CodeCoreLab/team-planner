package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestSyncAssetsKeepsUserData 验证资源同步不会覆盖用户数据 data.js。
//
// 这是最关键的一条：data.js 里是用户全部数据，
// 一旦被 bundle 里的占位文件覆盖，用户数据就没了。
func TestSyncAssetsKeepsUserData(t *testing.T) {
	src := t.TempDir()
	dst := t.TempDir()

	if err := os.WriteFile(filepath.Join(src, "index.html"), []byte("<html>v1</html>"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(src, "data.js"), []byte("/* 占位 */\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(src, "js", "core"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(src, "js", "core", "errors.js"), []byte("//v1"), 0o644); err != nil {
		t.Fatal(err)
	}

	// 用户已有真实数据
	userData := "window.__DATA = {\"data\":{\"tasks\":[1,2,3]}};\n"
	if err := os.WriteFile(filepath.Join(dst, "data.js"), []byte(userData), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := syncAssets(src, dst); err != nil {
		t.Fatalf("syncAssets 失败: %v", err)
	}

	got, err := os.ReadFile(filepath.Join(dst, "data.js"))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != userData {
		t.Fatalf("data.js 被覆盖了！\n期望: %q\n实际: %q", userData, string(got))
	}

	// 普通静态资源应被同步过来
	if _, err := os.Stat(filepath.Join(dst, "index.html")); err != nil {
		t.Fatalf("index.html 未同步: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dst, "js", "core", "errors.js")); err != nil {
		t.Fatalf("js/core/errors.js 未同步: %v", err)
	}
}

// TestSyncAssetsOverwritesStatic 验证静态资源在版本升级后会被覆盖。
func TestSyncAssetsOverwritesStatic(t *testing.T) {
	src := t.TempDir()
	dst := t.TempDir()

	os.WriteFile(filepath.Join(src, "index.html"), []byte("new"), 0o644)
	os.WriteFile(filepath.Join(dst, "index.html"), []byte("old"), 0o644)

	if err := syncAssets(src, dst); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(filepath.Join(dst, "index.html"))
	if string(got) != "new" {
		t.Fatalf("静态资源未更新，仍是 %q", string(got))
	}
}

// TestHandlerRouting 验证 HTTP 路由：只放行站点资源，不泄露内部路径。
func TestHandlerRouting(t *testing.T) {
	site := t.TempDir()
	os.WriteFile(filepath.Join(site, "index.html"), []byte("<html>ok</html>"), 0o644)
	os.WriteFile(filepath.Join(site, "data.js"), []byte("/* placeholder */"), 0o644)
	os.MkdirAll(filepath.Join(site, "js"), 0o755)
	os.WriteFile(filepath.Join(site, "js", "boot.js"), []byte("//boot"), 0o644)

	h := newHandler(site)

	cases := []struct {
		path string
		want int
	}{
		{"/", 200},
		{"/index.html", 200},
		{"/data.js", 200},
		{"/js/boot.js", 200},
		{"/__tp_health", 200},
		{"/nonexistent.js", 404},
	}
	for _, c := range cases {
		req := httptest.NewRequest(http.MethodGet, c.path, nil)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != c.want {
			t.Errorf("GET %s = %d, 期望 %d", c.path, rec.Code, c.want)
		}
	}

	// 首页必须 200 且是真实内容，不能是 301 重定向
	// （曾经踩过的坑：http.ServeFile 对 index.html 会 301 到 "./"，
	//   与 "/" 映射叠加后形成无限重定向循环）
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("GET / = %d, 期望 200", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "<html>ok</html>") {
		t.Errorf("GET / 未返回 index.html 内容: %q", rec.Body.String())
	}

	// 健康检查应返回带标记的 JSON
	req := httptest.NewRequest(http.MethodGet, healthPath, nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if !strings.Contains(rec.Body.String(), launcherMarker) {
		t.Errorf("健康检查未返回 marker: %s", rec.Body.String())
	}
}

// TestHandlerRejectsInternalPaths 验证内部路径（profile 目录等）不可访问。
func TestHandlerRejectsInternalPaths(t *testing.T) {
	site := t.TempDir()
	os.MkdirAll(filepath.Join(site, "profile"), 0o755)
	os.WriteFile(filepath.Join(site, "profile", "secret.txt"), []byte("token"), 0o644)

	h := newHandler(site)
	for _, p := range []string{"/profile/secret.txt", "/__tp_health/../profile/secret.txt"} {
		req := httptest.NewRequest(http.MethodGet, p, nil)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != 404 {
			t.Errorf("GET %s = %d, 期望 404", p, rec.Code)
		}
	}
}
