# 变更日志 — 团队协作台（team-planner）

本文件记录本项目的变更。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

### 变更

- 输入校验补全：长度按字符数判定（而非字节数），emoji 计 1 字符
- 数据 schema 版本门禁：版本更高的库文件拒绝降级打开，避免静默丢数据
- **口令派生升级为 PBKDF2-HMAC-SHA256（10 万轮）**：新设/新改口令一律使用
  `pbkdf2$<iter>$<salt>$<hash>` 格式；存量 `salt$sha256` 格式继续可校验，
  存量用户无需迁移
- **对外分发的备份文件剥离口令哈希**：导出备份时 `users[].password` 被替换为
  不可逆标记 `__reset_required__`；导入该备份后账号进入「需重设口令」状态，
  登录时引导设置新口令并写回。写回本地工作数据（data.js）**不**剥离，
  以保留「整个文件夹拷到新电脑双击就能用」的迁移路径
- `db.js` 的 `put/add/del/clear` 支持 `opts` 透传；`reqAsync` 新增
  `tolerate` 单行容错——单行失败不再中止整个 IndexedDB 事务
- `orgRepo` 新增 `profileSelfSave`：个人资料自助修改只接受
  `real_name`/`email`/`phone` 白名单字段

### 修复

- `.gitignore` 中 `data/`、`logs/`、`backup/`、`run/`、`releases/`、`data.js`
  等无前导斜杠的目录模式会匹配**任意层级**同名目录，误伤 `src/js/data/`
  源码目录，导致 9 个核心数据层文件从未入库。已全部改为 `/` 锚定仓库根

### 新增

- 21 项测试（`node --test`，无第三方依赖），覆盖校验规则、
  日期运算、标识数组处理与去重去空
- 12 项专项回归测试（`tests/verify-hardening.mjs`），覆盖 PBKDF2 新旧格式
  兼容、导出脱敏标记、`tolerate` 容错分支、`profileSelfSave` 白名单
- `tools/make_dist.py` 打包器：输出与线上包结构一致的扁平 zip（37 项），
  并设置 `ZipInfo.flag_bits |= 0x800` 修复中文文件名在 Windows 资源管理器
  下的乱码问题（「使用说明.txt」不再变成乱码）

## [1.0.3] - 2026-10-23

### 新增

- 数据 schema 升级至 v2：增加软删除、点评、通知、操作日志

## [1.0.2] - 2026-10-23

### 新增

- 统计报表与组织架构页

## [1.0.1] - 2026-10-23

### 新增

- 提醒中心与全局搜索（`Ctrl+K`）

## [1.0.0] - 2026-10-23

### 新增

- 首个发布版本：任务计划、看板、工作日志、组织架构、权限体系
