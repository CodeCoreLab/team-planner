#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""team-planner macOS 分发包打包脚本。

Windows 侧发的是一个 zip，解压后双击 index.html 就能用 —— 这套做法在 macOS 上
有一个绕不过去的坑：**双击 html 由系统默认浏览器接管，而 macOS 默认是 Safari，
Safari 没有 File System Access API（showDirectoryPicker），「连接目录」功能
直接不可用**；同时 file:// 下 fetch 被 CORS 拦、ES Module 被拦。

所以 macOS 版必须是一个原生壳：壳起本地 HTTP 服务，再用 Chromium 内核的
--app 模式打开窗口。本脚本负责把「launcher 可执行文件 + 前端静态资源」
封装成标准的 macOS .app bundle，并打成 zip。

产物结构::

    团队协作台.app/
      Contents/
        Info.plist              CFBundleExecutable / 图标 / 版本号
        PkgInfo                 "APPL????" 标记
        MacOS/team-planner      Mach-O 可执行文件（universal：arm64 + x86_64）
        Resources/AppIcon.icns
        Resources/site/         前端静态资源（index.html / css / js / icons / data.js）

与 pmvault 打包脚本的差异：

| 项 | pmvault | team-planner |
|---|---|---|
| 产物内容 | 仅可执行文件 | 可执行文件 + 前端静态资源 |
| 资源目录 | Resources/AppIcon.icns | Resources/AppIcon.icns + Resources/site/ |
| 图标来源 | .ico 内嵌 PNG | icons/icon-512.png 直接缩放 |
| 可执行文件名 | pmvault | team-planner |

两个关键点（与 pmvault 一致，都是踩过的坑）：

1. **zip 内路径必须带 .app 顶层目录名**，否则解压出来是一个叫 "Contents"
   的散目录，Finder 认不出是应用。
2. **必须显式写回 unix 权限位**（external_attr = mode << 16，
   create_system=3），否则 macOS 解压后 Contents/MacOS/team-planner 变成 0644，
   双击提示「无法执行」。

用法::

    python 脚本-打包-macOS.py <Mach-O 可执行文件> <前端静态资源目录> <输出目录>
"""
import os
import plistlib
import shutil
import struct
import sys
import zipfile

# .app 标识。identifier 必须稳定，改了会被 macOS 当成另一个应用
# （权限、偏好设置、Gatekeeper 记录都不继承）。
BUNDLE_ID = "cn.gf.teamplanner"
BUNDLE_VERSION = "1.0.3"
SHORT_VERSION = "1.0.3"
MIN_SYSTEM = "11.0"

APP_NAME = "团队协作台"
APP_DIR = "团队协作台.app"
EXE_NAME = "team-planner"

# icns 条目类型 -> 像素尺寸。
# ic11/ic12/ic13/ic14 是 @2x 变体（同样是 PNG 编码）。
ICNS_ENTRIES = [
    ("icp4", 16),
    ("icp5", 32),
    ("icp6", 64),
    ("ic07", 128),
    ("ic08", 256),
    ("ic09", 512),
    ("ic10", 1024),
    ("ic11", 64),     # 32@2x
    ("ic12", 128),    # 64@2x
    ("ic13", 512),    # 128@2x
    ("ic14", 1024),   # 256@2x
]

README_TEXT = """团队协作台（macOS 版）
====================

本版本是原生应用包（.app），双击即可启动，会自动打开一个独立窗口。

为什么 macOS 版不是「双击 index.html」
------------------------------------
Windows 版解压后双击 index.html 就能用，macOS 版不行，原因有两个：

1. macOS 默认浏览器是 Safari，而 Safari 不支持「选择文件夹」接口，
   程序最核心的「连接目录 → 数据自动写回 data.js」功能会不可用。
2. file:// 协议下浏览器会拦截 fetch 与 ES Module。

因此 macOS 版改为：应用在后台起一个本地服务（仅监听 127.0.0.1，
不对外网开放），再用 Microsoft Edge 或 Google Chrome 的应用窗口模式打开。
好处是「连接目录」功能完全可用，且数据行为与 Windows 版一致。

系统要求
--------
* macOS {minsys} 及以上（Apple Silicon 与 Intel 通用）
* 需要已安装 Microsoft Edge 或 Google Chrome
  （检查：/Applications 下是否有 "Microsoft Edge.app" 或 "Google Chrome.app"）

安装
----
1. 双击本 zip 解压
2. 把「{appname}.app」拖进「应用程序」文件夹
   （放在任意位置直接双击运行也完全可用）
3. 首次打开若提示「无法验证开发者」或「已损坏」：
   * 在 Finder 里 **右键点击** 该 .app → 选择「打开」→ 再点「打开」
   * 或打开「系统设置 → 隐私与安全性」，在下方提示中点「仍要打开」
   * 命令行方式：xattr -dr com.apple.quarantine "{appname}.app"

使用
----
1. 双击「{appname}.app」，稍等 1~2 秒会自动弹出应用窗口
2. 首次使用会要求设置管理员密码（至少 6 位），密码只存在本机，不会上传
3. 点左下角「连接目录」，选中下面的数据目录，点「允许」
   数据目录：{datadir}
   选中之后，程序的每次改动都会自动写回该目录下的 data.js

数据存放位置
------------
* {datadir}
  包含 site/（程序本体与 data.js）、profile/（专用浏览器配置）、
  run.log（最近运行日志，排障用）
* 换电脑时复制整个 TeamPlanner 目录即可，数据格式与 Windows 版一致

卸载
----
把「{appname}.app」拖进废纸篓并删除即可。
程序不写系统目录、不注册后台服务、不安装任何驱动，删除即卸载干净。

安全说明
--------
* 本地服务只监听 127.0.0.1 回环地址，不对外网开放
* 浏览器使用独立的 profile 目录，不读取也不影响你日常浏览器的
  账号、Cookie、书签与扩展
* 数据全部保存在本机，不联网、不上传

本程序未做 Apple 公证（未购买开发者签名），
因此首次打开需要按上面的方式手动放行，属正常现象。
""".format(minsys=MIN_SYSTEM, appname=APP_NAME,
           datadir="~/Library/Application Support/TeamPlanner")

USAGE_TEXT = """使用说明 —— 团队协作台 macOS 版
============================

1. 双击 zip 解压。
2. 右键点击「{appname}.app」→「打开」→ 确认「打开」。
   （首次需手动放行；之后可直接双击启动。）
3. 稍等 1~2 秒，程序会打开一个独立应用窗口。
4. 设置管理员密码（至少 6 位），密码只存在本机。
5. 点左下角「连接目录」，选中
   ~/Library/Application Support/TeamPlanner/site
   点「允许」。之后每次改动都会自动写回该目录的 data.js。

常见问题
--------
Q: 提示「无法验证开发者 / 已损坏，无法打开」怎么办？
A: 右键 .app 选「打开」；或在「系统设置 → 隐私与安全性」点「仍要打开」；
   或执行 xattr -dr com.apple.quarantine "*.app"。

Q: 提示「未找到可用的浏览器内核」？
A: 本版本需要 Microsoft Edge 或 Google Chrome，请先安装其一
   （在 /Applications 里能看到对应 .app 即可）。

Q: 双击后没反应？
A: 看 ~/Library/Application Support/TeamPlanner/run.log，
   最后一行是本次运行的记录。

Q: 换电脑后数据还在吗？
A: 把旧机的 ~/Library/Application Support/TeamPlanner 整个目录
   拷到新机同名位置即可，数据格式与 Windows 版一致。

Q: 能像 Windows 版那样双击 index.html 吗？
A: 技术上可以，但在 Safari 里「连接目录」不可用（Safari 缺接口），
   数据无法自动写回。所以 macOS 版统一走 .app 启动。
""".format(appname=APP_NAME)


def build_icns(png_path, out_path):
    """从 PNG 生成 .icns 容器。

    .icns 格式：'icns' + 总长度(uint32 BE)，随后是若干
    [类型(4B) + 长度(uint32 BE, 含 8 字节头) + 数据] 条目。
    PNG 数据直接嵌入对应类型即可，macOS 原生支持。
    """
    from PIL import Image

    im = Image.open(png_path).convert("RGBA")
    base_w, base_h = im.size
    base = max(base_w, base_h)

    chunks = []
    for etype, px in ICNS_ENTRIES:
        if px <= base:
            img = im.resize((px, px), Image.LANCZOS)
        else:
            # 超过原图尺寸时从原图等比放大后居中裁切，避免糊
            scale = px / float(base)
            big = im.resize((max(px, int(base_w * scale)), max(px, int(base_h * scale))), Image.LANCZOS)
            left = (big.width - px) // 2
            top = (big.height - px) // 2
            img = big.crop((left, top, left + px, top + px)).convert("RGBA")

        from io import BytesIO
        buf = BytesIO()
        img.save(buf, format="PNG")
        data = buf.getvalue()
        chunks.append(struct.pack(">4sI", etype.encode("ascii"), len(data) + 8) + data)

    body = b"".join(chunks)
    with open(out_path, "wb") as f:
        f.write(b"icns" + struct.pack(">I", len(body) + 8) + body)
    return out_path


def make_info_plist():
    return {
        "CFBundleName": APP_NAME,
        "CFBundleDisplayName": APP_NAME,
        "CFBundleIdentifier": BUNDLE_ID,
        "CFBundleExecutable": EXE_NAME,
        "CFBundleIconFile": "AppIcon",
        "CFBundlePackageType": "APPL",
        "CFBundleInfoDictionaryVersion": "6.0",
        "CFBundleShortVersionString": SHORT_VERSION,
        "CFBundleVersion": BUNDLE_VERSION,
        "CFBundleDevelopmentRegion": "zh_CN",
        "CFBundleAllowMixedLocalizations": True,
        # 窗口由 Edge / Chrome 提供，我们的进程只在后台跑本地服务，
        # 不在 Dock 上留一个无意义的图标。
        "LSUIElement": True,
        "LSMinimumSystemVersion": MIN_SYSTEM,
        "NSHighResolutionCapable": True,
        "LSApplicationCategoryType": "public.app-category.productivity",
        "NSSupportsAutomaticGraphicsSwitching": True,
        "NSHumanReadableCopyright": "© 广发证券 稳定性保障中心",
    }


def copy_tree(src, dst):
    """复制目录，并保留符号链接结构（前端资源里没有符号链接，防御性处理）。"""
    for root, dirs, files in os.walk(src):
        rel = os.path.relpath(root, src)
        target_root = os.path.join(dst, rel) if rel != "." else dst
        os.makedirs(target_root, exist_ok=True)
        for d in dirs:
            os.makedirs(os.path.join(target_root, d), exist_ok=True)
        for f in files:
            shutil.copy2(os.path.join(root, f), os.path.join(target_root, f))


def zip_bundle(src_dir, zip_path, arc_root):
    """把 .app 打成 zip。

    两个关键点：
    1. **arc_root 必须带 .app 目录名**：zip 内路径要是
       ``团队协作台.app/Contents/...``，否则解压出来是一个叫 "Contents"
       的散目录，Finder 认不出是应用。
    2. **必须显式写回 unix 权限位**：macOS 的「解压缩」依赖 zip 里的
       external_attr 保存权限，丢失后 .app 内的二进制会变成 0644，
       双击提示「无法执行」。
    """
    files = []
    for root, dirs, fs in os.walk(src_dir):
        for d in dirs:
            files.append(os.path.join(root, d))
        for f in fs:
            files.append(os.path.join(root, f))
    files.sort(key=lambda p: p.replace("\\", "/"))

    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for path in files:
            rel = os.path.relpath(path, src_dir).replace("\\", "/")
            arc = arc_root + "/" + rel
            if os.path.isdir(path):
                zi = zipfile.ZipInfo(arc + "/")
                zi.external_attr = (0o755 << 16) | 0x10
                zi.create_system = 3
                z.writestr(zi, b"")
                continue
            zf = zipfile.ZipInfo(arc)
            zf.create_system = 3
            zf.compress_type = zipfile.ZIP_DEFLATED
            # 可执行文件 0755，其余 0644
            mode = 0o755 if rel.endswith("/MacOS/" + EXE_NAME) else 0o644
            zf.external_attr = (mode << 16)
            with open(path, "rb") as fh:
                z.writestr(zf, fh.read())


def main():
    if len(sys.argv) != 4:
        print(__doc__)
        return 2
    exe_path, site_src, outdir = sys.argv[1], sys.argv[2], sys.argv[3]

    if not os.path.exists(exe_path):
        print("可执行文件不存在:", exe_path)
        return 1
    if not os.path.exists(os.path.join(site_src, "index.html")):
        print("静态资源目录无效（缺 index.html）:", site_src)
        return 1

    os.makedirs(outdir, exist_ok=True)
    stage = os.path.join(outdir, APP_DIR)
    if os.path.exists(stage):
        shutil.rmtree(stage)
    contents = os.path.join(stage, "Contents")
    macos_dir = os.path.join(contents, "MacOS")
    res_dir = os.path.join(contents, "Resources")
    for d in (macos_dir, res_dir):
        os.makedirs(d, exist_ok=True)

    # 可执行文件
    dst_exe = os.path.join(macos_dir, EXE_NAME)
    shutil.copy2(exe_path, dst_exe)
    os.chmod(dst_exe, 0o755)

    # Info.plist / PkgInfo
    with open(os.path.join(contents, "Info.plist"), "wb") as f:
        plistlib.dump(make_info_plist(), f)
    with open(os.path.join(contents, "PkgInfo"), "w", encoding="utf-8") as f:
        f.write("APPL????")

    # 图标：从 512 PNG 组装 icns
    icon_png = os.path.join(os.path.dirname(os.path.abspath(site_src)), "src", "icons", "icon-512.png")
    if not os.path.exists(icon_png):
        cand = os.path.join(site_src, "icons", "icon-512.png")
        icon_png = cand if os.path.exists(cand) else icon_png
    if not os.path.exists(icon_png):
        print("找不到图标源文件 icon-512.png")
        return 1
    build_icns(icon_png, os.path.join(res_dir, "AppIcon.icns"))

    # 前端静态资源
    # site 是浏览器站点根目录，只放浏览器真正会请求的资源：
    # index.html / css / js / icons / data.js。
    # 「使用说明.txt」这类文档不进 site（它已被单独放在 bundle 根目录）。
    site_dst = os.path.join(res_dir, "site")
    os.makedirs(site_dst, exist_ok=True)
    for item in ("index.html", "data.js", "css", "js", "icons"):
        src_item = os.path.join(site_src, item)
        if not os.path.exists(src_item):
            print("静态资源缺失:", src_item)
            return 1
        if os.path.isdir(src_item):
            copy_tree(src_item, os.path.join(site_dst, item))
        else:
            shutil.copy2(src_item, os.path.join(site_dst, item))

    # 说明文件放在 bundle 根目录（与 .app 同级），便于用户随手查看
    with open(os.path.join(stage, "README.md"), "w", encoding="utf-8", newline="\n") as f:
        f.write(README_TEXT)
    with open(os.path.join(stage, "使用说明.txt"), "w", encoding="utf-8", newline="\r\n") as f:
        f.write(USAGE_TEXT)

    # 打包
    zip_path = os.path.join(outdir, "team-planner-macos.zip")
    if os.path.exists(zip_path):
        os.remove(zip_path)
    zip_bundle(stage, zip_path, APP_DIR)

    print("产出:", zip_path, os.path.getsize(zip_path), "字节")
    print("bundle:", stage)
    return 0


if __name__ == "__main__":
    sys.exit(main())
