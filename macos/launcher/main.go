// team-planner launcher —— 团队协作台 macOS 原生壳
//
// 为什么要做这个壳：
//
//	team-planner 是纯前端静态页，Windows 版的用法是「解压 → 双击 index.html」。
//	搬到 macOS 后有两个硬伤：
//	  1. 双击 index.html 会被系统默认浏览器接管。macOS 默认是 Safari，
//	     而 Safari 没有 File System Access API（showDirectoryPicker），
//	     「连接目录」这个核心功能直接不可用。
//	  2. file:// 下 fetch() 被 CORS 拦、ES Module 被拦，只能退化成
//	     <script src> 逐个加载。
//
//	所以 macOS 版改为：壳起一个本地 HTTP 服务（127.0.0.1 固定端口），
//	再用 Edge / Chrome 的 --app 模式打开。这样：
//	  · 站点跑在 http://127.0.0.1:<固定端口> 上，fetch / ES Module 都不受限
//	  · 127.0.0.1 是 secure context，showDirectoryPicker 可用
//	  · 固定端口 = 固定 origin = IndexedDB / localStorage 跨启动保持一致
//	    （端口若每次变化，浏览器会当成另一个源，登录态与本地库全部"丢失"）
//
//	数据目录（siteDir）里同时放静态资源与 data.js，和 Windows 版
//	「data.js 与 index.html 同目录」的语义保持一致，用户在
//	「连接目录」里选中该目录即可让数据自动写回，下次启动自动载入。
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	appName        = "团队协作台"
	bundleID       = "cn.gf.teamplanner"
	appVersion     = "1.0.3"
	shortVersion   = "1.0.3"
	minSystem      = "11.0"
	preferredPort  = 49321
	portTryCount   = 5
	healthPath     = "/__tp_health"
	launcherMarker = "team-planner-launcher"
)

var logFile *os.File

func main() {
	work, err := workDir()
	if err != nil {
		fatal("启动失败", "无法确定用户数据目录："+err.Error())
		return
	}
	siteDir := filepath.Join(work, "site")
	profileDir := filepath.Join(work, "profile")
	lockPath := filepath.Join(work, ".instance.lock")

	for _, d := range []string{siteDir, profileDir} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			fatal("启动失败", "无法创建目录 "+d+"："+err.Error())
			return
		}
	}
	openLog(filepath.Join(work, "run.log"))

	// 静态资源同步：把 .app 内置的 site 同步到用户目录。
	// data.js 是用户数据，任何情况下都不覆盖。
	if err := syncAssets(bundleSiteDir(), siteDir); err != nil {
		fatal("启动失败", "静态资源同步失败："+err.Error())
		return
	}

	// 单实例：拿不到锁说明已经有一个实例在跑。
	release, ok := acquireInstanceLock(lockPath)
	if !ok {
		logf("检测到已在运行的实例，唤起新窗口")
		if b, found := pickBrowser(); found {
			launchBrowser(b.path, urlFor(preferredPort), profileDir)
		}
		return
	}
	defer release()

	port, err := listen(preferredPort, siteDir)
	if err != nil {
		fatal("启动失败", "本地服务启动失败："+err.Error())
		return
	}
	logf("本地服务已启动：%s", urlFor(port))

	browser, found := pickBrowser()
	if !found {
		fatal("未找到可用的浏览器内核",
			"团队协作台 macOS 版需要 Microsoft Edge 或 Google Chrome。\n"+
				"请先安装其一，然后重新打开本应用。")
		return
	}
	logf("使用浏览器内核：%s", browser.name)

	launchBrowser(browser.path, urlFor(port), profileDir)

	// 等浏览器退出后结束进程。
	// Chromium 启动进程可能先行退出，改用「profile 目录是否仍被进程占用」判断。
	waitBrowserExit(profileDir)
	logf("浏览器已退出，进程结束")
}

// workDir 返回用户数据根目录：~/Library/Application Support/TeamPlanner
func workDir() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, "TeamPlanner"), nil
}

// bundleSiteDir 定位 .app 内置的静态资源目录。
// 可执行文件位于 Contents/MacOS/team-planner，资源在 Contents/Resources/site。
func bundleSiteDir() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	base := filepath.Dir(exe)
	for _, c := range []string{
		filepath.Join(base, "..", "Resources", "site"),
		filepath.Join(base, "site"),
	} {
		if st, err := os.Stat(filepath.Join(c, "index.html")); err == nil && !st.IsDir() {
			return filepath.Clean(c)
		}
	}
	return ""
}

// syncAssets 把 bundle 内的静态资源同步到 siteDir。
//
// 规则：
//   · 逐文件按内容哈希判断是否需要覆盖
//   · data.js / data.bak.js 是用户数据，任何情况下都不覆盖
func syncAssets(src, dst string) error {
	if src == "" {
		return fmt.Errorf("未找到内置静态资源目录")
	}
	if err := os.MkdirAll(dst, 0o755); err != nil {
		return err
	}
	return filepath.Walk(src, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, rerr := filepath.Rel(src, path)
		if rerr != nil {
			return rerr
		}
		rel = filepath.ToSlash(rel)
		base := filepath.Base(rel)
		if info.IsDir() {
			return os.MkdirAll(filepath.Join(dst, filepath.FromSlash(rel)), 0o755)
		}
		if base == "data.js" || base == "data.bak.js" {
			return nil
		}
		target := filepath.Join(dst, filepath.FromSlash(rel))
		if same, serr := sameContent(path, target); serr == nil && same {
			return nil
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		return copyFile(path, target)
	})
}

func sameContent(a, b string) (bool, error) {
	ha, err := hashFile(a)
	if err != nil {
		return false, err
	}
	hb, err := hashFile(b)
	if err != nil {
		return false, err
	}
	return ha == hb, nil
}

func hashFile(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, in)
	return err
}

// listen 绑定本地端口并起服务。优先用固定端口（origin 稳定 = 浏览器本地库连续），
// 被占用时往后试几个。
func listen(preferred int, siteDir string) (int, error) {
	for i := 0; i < portTryCount; i++ {
		p := preferred + i
		ln, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(p))
		if err == nil {
			go serve(ln, siteDir)
			return p, nil
		}
	}
	return 0, fmt.Errorf("127.0.0.1:%d 起连续 %d 个端口均不可用", preferred, portTryCount)
}

func serve(ln net.Listener, siteDir string) {
	srv := &http.Server{Handler: newHandler(siteDir)}
	_ = srv.Serve(ln)
}

// newHandler 只放行站点需要的路径，避免把 profile 目录（浏览器配置，
// 含缓存与令牌）暴露到 HTTP 上。
func newHandler(siteDir string) http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc(healthPath, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"marker":"`+launcherMarker+`","version":"`+appVersion+`"}`)
	})

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		serveSite(w, r, siteDir)
	})
	return mux
}

// serveSite 提供站点静态文件。
//
// 这里刻意**不用 http.ServeFile**：它对以 index.html 结尾的路径会 301 到 "./"，
// 而我们把 "/" 映射到 index.html，浏览器就会在 "/" 与 "./" 之间反复跳转
// 形成死循环。改为直接读文件写出。
func serveSite(w http.ResponseWriter, r *http.Request, siteDir string) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	clean := path.Clean("/" + strings.TrimPrefix(r.URL.Path, "/"))
	if clean == "/" {
		clean = "/index.html"
	}
	// 内部路径一律不开放
	if strings.HasPrefix(clean, "/__") {
		http.NotFound(w, r)
		return
	}
	// profile 是浏览器配置目录（含缓存与令牌），任何情况下都不允许访问
	if clean == "/profile" || strings.HasPrefix(clean, "/profile/") {
		http.NotFound(w, r)
		return
	}

	full := filepath.Join(siteDir, filepath.FromSlash(clean))
	// 二次确认没有跳出 siteDir（防目录穿越）
	rel, err := filepath.Rel(siteDir, full)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		http.NotFound(w, r)
		return
	}

	st, err := os.Stat(full)
	if err != nil || st.IsDir() {
		http.NotFound(w, r)
		return
	}

	data, err := os.ReadFile(full)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	if ct := mime.TypeByExtension(filepath.Ext(full)); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	// 禁用缓存，避免升级后仍看到旧静态资源
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	if r.Method == http.MethodHead {
		return
	}
	_, _ = w.Write(data)
}

func urlFor(port int) string {
	return "http://127.0.0.1:" + strconv.Itoa(port) + "/"
}

// waitBrowserExit 轮询 profile 目录是否仍被进程占用。
// Chromium 启动器进程可能先退出，因此不能只等 cmd.Wait()。
func waitBrowserExit(profileDir string) {
	for {
		if !browserRunning(profileDir) {
			return
		}
		time.Sleep(2 * time.Second)
	}
}

func openLog(path string) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return
	}
	logFile = f
}

func logf(format string, args ...interface{}) {
	if logFile == nil {
		return
	}
	msg := fmt.Sprintf("%s  %s\n", time.Now().Format("2006-01-02 15:04:05"), fmt.Sprintf(format, args...))
	_, _ = logFile.WriteString(msg)
	_ = logFile.Sync()
}

// ---------------------------------------------------------------- 平台相关

// launchBrowser 以 --app 模式启动浏览器。
//
// 独立 --user-data-dir 是必须的：
//   · 不污染用户日常浏览器配置
//   · IndexedDB / localStorage 落在固定目录，跨启动保持
//   · --app 模式给出无地址栏的独立窗口，观感接近原生应用
func launchBrowser(bin, url, profileDir string) {
	args := []string{
		"--app=" + url,
		"--user-data-dir=" + profileDir,
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-background-mode",
		"--disable-features=Translate,TranslateUI,MediaRouter",
		"--window-size=1280,860",
	}
	cmd := exec.Command(bin, args...)
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	if err := cmd.Start(); err != nil {
		fatal("启动浏览器失败", err.Error())
		return
	}
	go func() { _ = cmd.Wait() }()
}
