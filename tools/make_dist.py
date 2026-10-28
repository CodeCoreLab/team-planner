#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""打包 team-planner 可分发压缩包（供产品页下载）。

用法：
    python tools/make_dist.py --out <输出目录> [--name team-planner]

产物：
    <输出目录>/team-planner.zip

包内结构（扁平，与线上已发布包保持一致）：
    index.html  data.js  使用说明.txt  css/  icons/  js/

设计约束：
  * 只打包 **src/** 下的运行时文件（应用本体），不含仓库文档 / CI /
    测试脚本 / 打包工具自身 —— 拿到的包解压即可双击 index.html 使用。
  * 内容取自 git 已跟踪文件（git ls-files），排除本地脏文件与运行期数据。
  * 中文文件名（使用说明.txt）必须带 UTF-8 文件名标志位 0x800，
    否则 Windows 解压会乱码成「õ¢+þö¿޻¦µÄ.txt」。
  * 时间戳固定，保证同版本产物可复现。
  * 包内做一次敏感信息自检，命中即中止。
"""
from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# 包内根目录前缀：src/ 下的文件直接摊平到包根
SRC_PREFIX = "src/"

# 排除的路径前缀 / 精确文件名（相对仓库根）
EXCLUDE_PREFIXES = (".github/", "docs/", "tests/")
EXCLUDE_NAMES = {"tools/make_dist.py", "CHANGELOG.md", "LICENSE",
                 "CODE_OF_CONDUCT.md", "CONTRIBUTING.md",
                 "SECURITY.md", "THIRD-PARTY-NOTICES.md", ".gitignore"}

# zip 内时间戳固定，保证同版本产物可复现
FIXED_DATE = (2026, 1, 1, 0, 0, 0)

# 示例值白名单：RFC 5737 文档专用网段
EXAMPLE_NETS = ("192.0.2.", "198.51.100.", "203.0.113.")

# 敏感信息自检规则：命中即打包中止。
# skip_dirs 按规则粒度豁免（测试固件里的构造性假值不算泄露）。
SENSITIVE_RULES = [
    ("内网 IP", re.compile(r"\b(?:10|172|192|198|203)\.(?:\d{1,3}\.){2}\d{1,3}\b"),
     ("tests/",)),
    ("内部域名", re.compile(r"\b[a-z0-9.-]*\.gf\.com\.cn\b"), ()),
    ("凭据赋值", re.compile(
        r"(?i)\b(?:password|passwd|secret|api[_-]?key|token)\s*[=:]\s*[\"'][^\"']{6,}"),
     ("tests/",)),
    ("webhook 明文 key", re.compile(r"webhook/send\?key=[A-Za-z0-9_\-]{8,}"), ()),
    ("SSH 私钥", re.compile(r"BEGIN [A-Z ]*PRIVATE KEY"), ("tests/",)),
    ("数据库连接串", re.compile(
        r"(?i)\b(?:mysql|postgres(?:ql)?|mongodb(?:\+srv)?|redis)://[^\s'\"]+:[^\s'\"]+@"), ()),
]


def tracked_files(repo: str) -> list[str]:
    """取 git 已跟踪文件（相对仓库根）。"""
    try:
        out = subprocess.run(
            ["git", "-C", repo, "ls-files", "-z"],
            capture_output=True, check=True,
        ).stdout
    except (OSError, subprocess.CalledProcessError) as exc:
        print(f"✗ 无法执行 git ls-files: {exc}")
        return []
    return [p for p in out.decode("utf-8").split("\0") if p]


def is_excluded(rel: str) -> bool:
    if rel in EXCLUDE_NAMES:
        return True
    return any(rel.startswith(p) for p in EXCLUDE_PREFIXES)


def scan_sensitive(files: list[tuple[str, bytes]]) -> list[str]:
    hits = []
    for rel, data in files:
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            continue  # 二进制文件跳过
        for label, pattern, skip_dirs in SENSITIVE_RULES:
            if any(rel.startswith(d) for d in skip_dirs):
                continue
            for m in pattern.finditer(text):
                value = m.group(0)
                if label == "内网 IP" and value.startswith(EXAMPLE_NETS):
                    continue
                hits.append(f"{rel}: {label} -> {value[:60]}")
    return hits


def main() -> int:
    ap = argparse.ArgumentParser(description="打包 team-planner 可分发压缩包")
    ap.add_argument("--out", required=True, help="输出目录")
    ap.add_argument("--name", default="team-planner", help="包名")
    args = ap.parse_args()

    repo = ROOT
    if not os.path.isdir(os.path.join(repo, ".git")):
        print(f"✗ 不是 git 仓库目录: {repo}")
        return 1

    tracked = tracked_files(repo)
    if not tracked:
        print("✗ 未取到任何已跟踪文件")
        return 1

    print("=" * 58)
    print(f"  打包 {args.name} 可分发压缩包")
    print("=" * 58)

    # ---- 1) 收集 src/ 下的运行时文件 ----
    payload: list[tuple[str, bytes]] = []
    for rel in sorted(tracked):
        if not rel.startswith(SRC_PREFIX):
            continue
        if is_excluded(rel):
            continue
        src = os.path.join(repo, rel)
        if not os.path.isfile(src):
            print(f"  ! 跳过缺失文件: {rel}")
            continue
        with open(src, "rb") as f:
            data = f.read()
        data = data.replace(b"\r\n", b"\n")
        payload.append((rel[len(SRC_PREFIX):], data))

    if not payload:
        print("✗ src/ 下没有可打包的运行时文件")
        return 1
    print(f"  纳入文件 {len(payload)} 个（src/ 下的运行时文件）")

    # ---- 2) 敏感信息自检 ----
    hits = scan_sensitive(payload)
    if hits:
        print("\n  ✗ 敏感信息自检未通过，打包中止：")
        for h in hits[:12]:
            print("     ", h)
        print("  请先脱敏再打包")
        return 1
    print("  敏感信息自检：PASS")

    # ---- 3) 写 zip ----
    os.makedirs(args.out, exist_ok=True)
    zip_path = os.path.join(args.out, f"{args.name}.zip")

    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for rel, data in payload:
            info = zipfile.ZipInfo(rel, date_time=FIXED_DATE)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (0o100644 << 16)
            # 0x800 = 文件名与注释按 UTF-8 编码。
            # 不设这个标志位，Windows 资源管理器按 CP437 解码，
            # 中文名「使用说明.txt」会变成「õ¢+þö¿޻¦µÄ.txt」。
            info.flag_bits |= 0x800
            zf.writestr(info, data)

    size = os.path.getsize(zip_path)
    print(f"\n  产物: {zip_path}  ({size:,} 字节)")

    # ---- 4) 校验 ----
    with zipfile.ZipFile(zip_path) as zf:
        bad = zf.testzip()
        names = zf.namelist()
    if bad:
        print(f"  ✗ zip 完整性校验失败: {bad}")
        return 1
    if len(names) != len(payload):
        print(f"  ✗ 包内文件数不符: {len(names)} != {len(payload)}")
        return 1
    # 中文名必须带 UTF-8 标志位
    for n in names:
        if not n.isascii():
            with zipfile.ZipFile(zip_path) as zf:
                info = zf.getinfo(n)
            if not (info.flag_bits & 0x800):
                print(f"  ✗ 非 ASCII 文件名缺少 UTF-8 标志位: {n}")
                return 1
    print(f"  完整性校验：PASS（{len(names)} 个条目，中文名 UTF-8 标志位正常）")

    print("\n  包内清单:")
    for n in names:
        print("    ", n)
    print("=" * 58)
    return 0


if __name__ == "__main__":
    sys.exit(main())
