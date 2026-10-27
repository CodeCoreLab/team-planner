# 第三方组件与许可声明 — team-planner（团队协作台）

本文件列出本项目使用的第三方组件及其许可协议。

**本仓库不包含任何第三方二进制文件**——所有依赖一律通过语言原生的包管理机制
（`PackageReference` / `go.mod` / `Cargo.toml`）在构建时还原。
克隆本仓库后执行对应的构建命令，即可获得完整的依赖树。

## team-planner（团队协作台）

技术栈：原生 JavaScript（ES5 语法基线）

**零第三方依赖。** 不使用任何框架、构建工具或 CDN 资源。

- 无 npm 依赖
- 无外部字体、图标库、CDN 脚本
- 所有图标为项目内自带的 SVG / PNG 文件
- 字体使用系统字体栈（`system-ui` / `-apple-system` / `Segoe UI` / `Microsoft YaHei`）

测试依赖仅有 Node.js 内置的 `node:test` 模块（MIT，Node.js 项目）。

---
