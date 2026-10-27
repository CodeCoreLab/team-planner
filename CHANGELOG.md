# 变更日志 — team-planner（团队协作台）

本文件记录本项目的变更。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

### team-planner

#### 变更

- 输入校验补全：长度按字符数判定（而非字节数），emoji 计 1 字符
- 数据 schema 版本门禁：版本更高的库文件拒绝降级打开，避免静默丢数据

#### 新增

- 21 项测试（`node --test`，无第三方依赖），覆盖校验规则、
  日期运算、标识数组处理与去重去空

## 历史版本

### team-planner — v1.0.3（2026-10-23）

- 数据 schema 升级至 v2：增加软删除、点评、通知、操作日志

### team-planner — v1.0.2（2026-10-23）

- 统计报表与组织架构页

### team-planner — v1.0.1（2026-10-23）

- 提醒中心与全局搜索（`Ctrl+K`）

### team-planner — v1.0.0（2026-10-23）

- 首个发布版本：任务计划、看板、工作日志、组织架构、权限体系

## 版本说明

- **xmtool**：`Properties/AssemblyInfo.cs` 中的 `AssemblyInformationalVersion`
  为权威版本号。产物名带 `v1.0.5` 字样，但 AssemblyInfo 可能仍停留在旧值——
  发布前需同步。
- **team-planner**：版本以 `releases/v<版本>-<日期>/` 目录名为准；
  数据 schema 版本独立于应用版本，见 `src/js/data/db.js` 的 `DB_VERSION`。
- **pmvault** / **work-reminder**：版本分别定义在 `go.mod` / `Cargo.toml`
  的 `version` 字段。
