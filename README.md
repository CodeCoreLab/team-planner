# team-planner — 团队协作台

纯前端的团队任务 / 日志 / 工时协作台。**零依赖、零构建**——
解压后双击 `src/index.html` 就能用，不需要安装任何东西，不需要联网。

数据全部存在浏览器本地（IndexedDB），不上传任何服务器。

| 项 | 值 |
|---|---|
| 技术栈 | 原生 JavaScript（ES5 语法基线） |
| 第三方依赖 | **无**。无框架、无打包器、无 CDN 资源 |
| 前端产物 | 静态站点，解压即用 |
| 数据存储 | IndexedDB（schema v2） |
| 测试 | 21 项（Node 内置 `node:test`，用 `vm` 沙箱加载浏览器脚本） |
| 代码规模 | 约 11,900 行 JS |

---

## 快速开始

```bash
# 方式一：直接打开（Windows）
#   双击 src/index.html

# 方式二：起个本地静态服务器（推荐，避免个别浏览器对 file:// 的限制）
cd team-planner/src
python -m http.server 8080
# 浏览器打开 http://localhost:8080
```

**macOS**：直接双击 html 会被默认浏览器接管，而 Safari 不支持
File System Access API（`showDirectoryPicker`），「连接目录」不可用；
`file://` 下 fetch 被 CORS 拦、ES Module 被拦。
所以 macOS 版用 `macos/` 下的原生壳（起本地 HTTP 服务 + Chromium 内核
`--app` 模式开窗），打包脚本为 `macos/脚本-打包-macOS.py`，需在 macOS 上执行。

**首次运行**会要求设置管理员密码。密码只保存在你自己电脑上（浏览器本地存储），
不上传、不同步。

---

## 功能

### 十个功能页

| 页面 | 说明 |
|---|---|
| **工作台** | 今日概览、待办汇总、快捷入口 |
| **任务计划** | 按周 / 按日 / 按列表视图查看任务，支持筛选与分页 |
| **计划管理** | 任务的批量归类与周期规划（管理组） |
| **提醒中心** | 到期任务提醒与红点提示 |
| **工作日志** | 每日工时填报，按日 / 按周 / 按月聚合 |
| **统计报表** | 工时与任务的多维统计（管理组） |
| **组织架构** | 成员、角色与权限管理（管理组） |
| **系统设置** | 站点信息、界面偏好、工作时段（管理组） |
| **操作日志** | 关键操作留痕（管理组） |
| **用户中心** | 个人资料与密码修改 |

标「管理组」的页面需要对应权限才会在导航中出现。

> 「管理组」是便于理解的**功能分组**，不是代码里的权限单元。
> 实际权限模块是下列 8 项，「计划管理」与「用户中心」不单独设权限模块
> ——前者复用 `plans`，后者对所有登录用户开放。

### 权限模型

角色可配置，权限由两个维度组合而成：

**权限模块**（8 个）：

```
dashboard  plans  logs  board  reports  org  settings  oplogs
```

**动作**（6 种，按模块组合授权）：

| 动作 | 含义 | 适用模块 |
|---|---|---|
| `view` | 查看 | 全部 |
| `add` | 新增 | `plans` `logs` `org` |
| `edit` | 编辑 | 全部 |
| `delete` | 删除 | `plans` `logs` `org` |
| `review` | 点评 | `logs` |
| `co_assign` | 指派他人 | `plans` |

**数据范围**（`data_scope`）：`self`（仅自己的）/ `dept`（本部门）/ `all`（全部）

内置三个角色：系统管理员（全权限 + `all`）、部门主管（无设置与操作日志 + `dept`）、
普通成员（仅本人数据 + `self`）。其他角色可在「组织架构」页按模块逐一授权。

### 数据导出与备份

「系统设置」页提供 JSON 导出 / 导入。**导入会做 schema 版本检查**——
版本高于当前程序的数据文件会被拒绝加载，而不是静默丢数据。

> ⚠️ 数据存在浏览器本地存储中。**清理浏览器数据、使用无痕窗口、
> 换浏览器或换设备，数据都不会跟着走。** 请定期用导出功能备份。

---

## 配置说明

所有设置项存于本地数据库的 `settings` 表，界面在「系统设置」页。

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `site_name` | `团队协作台` | 站点名称，显示在标题与侧栏 |
| `site_subtitle` | `团队任务与工作日志一体化` | 副标题 |
| `theme_default` | `light` | 默认主题（`light` / `dark`） |
| `week_start` | `1` | 每周起始日（0=周日，1=周一） |
| `work_days` | `1,2,3,4,5` | 工作日（周一至周五） |
| `page_size` | `20` | 列表每页条数 |
| `log_reminder` | `1` | 是否显示日志填写红点提醒 |
| `hide_weekend` | `0` | 日报视图隐藏周末 |
| `hide_saturday` | `0` | 单独隐藏周六 |
| `hide_sunday` | `0` | 单独隐藏周日 |
| `hide_evening` | `0` | 日报视图隐藏晚间时段 |
| `notify_enabled` | `0` | 是否启用到期提醒 |
| `email_enabled` | `0` | 邮件提醒开关。**纯前端无服务进程，邮件提醒不可用**；保留键位以便迁移兼容 |
| `work_periods` | 上午/下午/晚上三段 | 工作时段划分，用于工时归类 |

> 完整默认值以 `src/js/core/schema.js` 的 `DEFAULT_SETTINGS` 为准。

配置文件 `src/data.js` 是**首次运行时的占位文件**。连接数据目录并保存后，
程序会把它覆盖成真实数据；也可以用「备份」导出的文件替换它。

> 请勿删除此文件——删除后浏览器控制台会报 404（不影响功能，但看着像出错）。

---

## 常见问题

**Q：为什么双击打开后有些功能不正常？**
A：个别浏览器对 `file://` 协议下的 IndexedDB 有限制。用本地静态服务器打开即可
（见「快速开始」）。

**Q：数据怎么备份？**
A：「系统设置」页导出 JSON 文件。恢复时用导入功能选回该文件。

**Q：换电脑后数据能同步吗？**
A：不能。这是纯前端应用，没有服务端。请用导出 / 导入在设备间手动迁移。

**Q：支持多人同时编辑吗？**
A：同一浏览器内多标签页可以，但跨设备不行。多人协作场景请用带服务端的方案。

**Q：怎么加一个新的功能页？**
A：在 `src/js/ui/shell.js` 的 `ROUTES` 表里注册路由，
并在 `src/js/pages/` 下实现同名模块。

---

## 项目结构

```
team-planner/
├── src/
│   ├── index.html          入口（含首屏骨架，避免白屏）
│   ├── data.js             首次运行占位数据文件
│   ├── css/app.css         全部样式
│   ├── icons/              自带图标（SVG + PNG）
│   └── js/
│       ├── boot.js         启动引导：加载核心脚本、渲染外壳
│       ├── core/           基础设施
│       │   ├── bus.js      事件总线
│       │   ├── errors.js   错误类型（AppError / ValidationError / StorageError）
│       │   ├── schema.js   数据结构定义、枚举、默认设置与角色
│       │   └── validate.js 输入校验统一出口
│       ├── data/           仓储层
│       │   ├── repo.js     通用仓储基类
│       │   ├── db.js       IndexedDB 封装与 schema 迁移
│       │   ├── auth.js     认证与权限
│       │   ├── orgRepo.js  / planRepo.js / taskRepo.js / logRepo.js / miscRepo.js
│       │   └── seed.js     初始数据播种
│       ├── io/fileio.js    导入导出
│       ├── ui/
│       │   ├── kit.js      组件库（toast / modal / 字段 / 表格等）
│       │   └── shell.js    外壳：路由表、导航、全局搜索
│       └── pages/          10 个功能页
├── tests/run-tests.mjs   node:test 用例
├── docs/                 产品页、截图与发布记录
└── macos/                macOS 打包脚本
```

---

## 开发

### 跑测试

```bash
cd team-planner
node --test tests/run-tests.mjs
```

测试用 Node 的 `vm` 沙箱加载浏览器脚本，因此**不需要浏览器、不需要 headless 环境**。
注意：`vm` 沙箱里的数组原型与宿主不同，断言集合内容时请用值比较
（如 `.join(',')`）而非 `deepEqual`。

### 加一个校验规则

所有输入校验集中在 `src/js/core/validate.js`，不要在页面里另写一套：

```js
// 在 core/validate.js 的 window.Validate 导出中登记
window.Validate = {
  // ...
  myRule,
};
```

调用点统一用 `Validate.check(value, [Validate.required, Validate.myRule])`。

---

## 许可

MIT © 2026 Ma Xin。见 [`../LICENSE`](../LICENSE)。

零第三方依赖，无第三方许可需要追溯。
