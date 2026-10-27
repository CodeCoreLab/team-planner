# 团队协作台 · 部署与发布记录

> 线上地址：**https://example-site.com/team-planner/**
> 本地根：`E:\xmtool\team-planner\`（遵循 `E:\xmtool\README.md` 规范，目录名 = 线上 slug）

---

## 1. 目录结构

```
E:\xmtool\team-planner\
├── src\                        纯前端应用本体（可直接双击 index.html 运行）
│   ├── index.html              应用入口
│   ├── data.js                 数据文件（首次为占位，连接目录后被覆盖）
│   ├── css\app.css
│   ├── icons\                  图标（svg + 32/180/192/512 png）
│   └── js\
│       ├── core\               errors · bus · validate · schema
│       ├── data\               db · auth · repo · 5 个域 Repo · seed
│       ├── io\fileio.js        目录授权 + 数据文件读写
│       ├── ui\                 kit · shell
│       └── pages\              11 个页面
├── docs\
│   ├── product.html            产品介绍页（发布为线上入口 index.html）
│   ├── assets\
│   │   ├── icon.svg
│   │   └── team-planner.zip    安装包
│   └── live-*.png              线上验收截图
├── releases\
│   ├── v1.0.0-20261023\
│       └── team-planner.zip    179,061 字节
│   └── v1.0.2-20261023\
│       └── team-planner.zip    180,111 字节（当前线上）
└── tools\                      （预留：构建与校验脚本）
```

---

## 2. 线上结构

```
/opt/xmtooldev/www/team-planner/
├── index.html                  产品介绍页（47 KB）
├── assets\
│   ├── icon.svg                560 字节
│   └── team-planner.zip        179,061 字节
└── app\                        应用本体（在线试用入口）
    ├── index.html
    ├── data.js                 占位（避免 404）
    ├── css\  icons\  js\
    └── 使用说明.txt
```

**为什么应用放 `app/` 子目录而不是根目录与产品页并存：**

两者都需要 `index.html` 这个名字。最初把应用直接发布到根目录、产品页也叫 `index.html`，
结果互相覆盖 —— 访问 `/team-planner/index.html` 拿到的是产品页，应用完全不可用。
现在是「产品页做入口、应用放子目录」，两个名字不再冲突。

---

## 3. 首次发布（2026-10-23）

| 项 | 值 |
|---|---|
| URL | https://example-site.com/team-planner/ |
| 目标机 | example-test-host（不是跳板机 example-jump-host） |
| 目录 | `/opt/xmtooldev/www/team-planner/` |
| 发布方式 | `xmtooldev-publish` skill（prepare → publish → 卡片 → 验证） |
| 安装包 | `assets/team-planner.zip` · 179,061 字节 · zip 头 `PK` |
| 属主权限 | `root:root`，目录 755 / 文件 644 |
| 入口卡片 | 已插入 `/opt/xmtooldev/www/index.html`，`grep -c 'href="/team-planner/"'` = 1 |
| 入口页备份 | `index.html.bak_cards_20261023_043706`（md5 `a2540777…`，与原件一致） |
| healthcheck | exit 0，含 `tool:team-planner -> 200` |
| 解耦红线 | vhost `grep -c aireport` = 0 |
| 回滚点 | 首次发布，无旧快照 |

### 发布过程中的两次修正

| # | 问题 | 根因 | 修复 |
|---|---|---|---|
| 1 | 应用页 200 但页面空白 | 产品页与应用页都叫 `index.html`，应用被覆盖 | 应用移入 `app/` 子目录，产品页保留根 `index.html` |
| 2 | 本地 `file://` 与线上 HTTP 都出现 404 控制台报错 | `data.js` 不存在时浏览器必然打 404 | 打包时放一个只有注释的占位 `data.js`，从根上消除 |


---

## 3.1 v1.0.2（2026-10-23 下午）— 用户反馈修复

用户反馈：「第一次进入，工作日志感叹号红色是否正常，可以取消吗？」

查下来这不是显示问题，而是**两个真实缺陷**：

| # | 问题 | 根因 | 修复 |
|---|---|---|---|
| 1 | 红色感叹号关不掉 | `log_reminder` 设置项只在 `schema.js` 定义了默认值，**从未被任何代码读取**，设置页也没有对应开关 | 角标逻辑真正读取该设置；设置页加「日报提醒」开关；日志页加「不再提醒」按钮就地关闭 |
| 2 | 全局搜索一搜就报错 `items.map is not a function` | `sec('日志', l => ...)` 少传了数组参数，箭头函数被当成 items | 补上 `r.logs` 参数；并给 `sec()` 加数组兜底，同类错误以后只会跳过该段而不是整块崩 |

### 顺带修的设计问题

设置页三个「保存 xxx」按钮原本都是整行绿色主按钮，页面没有主次。
改为右对齐的普通按钮（`.form-act`），只保留「保存到目录」「连接目录」作为主操作。

### 叹号的完整语义（修复后）

| 条件 | 是否显示 |
|---|---|
| `log_reminder = 1` **且** 今天是工作日 **且** 今天没写日报 | 显示 `!` |
| 任意一条不满足 | 隐藏 |

**为什么加"仅工作日"**：周末不写日报是正常的，一直挂红点会变成噪音，用户就会习惯性忽略它 —— 那样提醒就失效了。

### 关闭方式（两条路）

1. 日志页提示卡右上角「不再提醒」—— 就地关闭，不用去设置页找
2. 系统设置 → 界面偏好 → 取消勾选「工作日未写日报时在侧栏显示提醒」

### 验收

专项测试 15/15（`tests/html/badge_search_test.js`），覆盖：
搜索三类命中、红点默认显示、悬停说明、日志页就地关闭、设置持久化、设置页开关状态一致、重新开启后红点回来、写日志后消失、非工作日不提醒。
另有全模块功能体检 18/18、端到端 38/38、安全 11/11、单元 62/62 全部回归通过。

**线上版本：v1.0.2**（安装包 180,111 字节）


---

## 3.2 v1.0.3（2026-10-23 晚）— 代码审查修复

完整审查报告见 `E://WorkBuddy//2026-10-22-17-32-50//report//14_code_architecture_review.md`

### 修复 3 个真实缺陷

| # | 缺陷 | 用户可见症状 | 根因 |
|---|---|---|---|
| 1 | **事件监听器累积** | 切到工作台再回来，**点复选框没反应** | `#page` 是复用容器，每次 `nav()` 都往上挂新 delegate 且从不移除，导航 N 次后一次点击触发 N 次 toggle，奇偶抵消 |
| 2 | **并发 toggle 竞态** | 快速连点 2 次，状态停在 completed 而非 pending | `next` 在事务外计算，所有并发调用用同一个过期值 |
| 3 | **decorate 全表扫描** | 库越大列表越慢 | 拉全库标签/子任务再内存过滤，成本与库总量成正比 |

### 关键实证数据

**缺陷 1**（monkey-patch 计数）：
```
真实点击后: pending  ✗ 点击未生效
直接调 API: {"apiReturned":"completed","dbAfter":"completed"}  ← API 正常
toggle 被调用次数: 2   ← 一次点击触发两次
```
修复后：`toggle 被调用次数: 1`

**缺陷 2**（不同并发数）：
| 连点 | 终态 | 期望 | |
|---|---|---|---|
| 2 | completed | pending | ✗ |
| 3 | completed | completed | ✓（巧合） |
| 10 | completed | pending | ✗ |

> 最初用 5 次测试通过了，因为奇数次刚好和错误值重合。
> **教训：并发测试必须覆盖奇偶两种情形。**

**缺陷 3**（隔离实验，库 3020 任务/3020 标签，结果集 20 行）：
```
修复后 A. 结果行无标签   → decorate 5.4ms
修复后 B. 结果行各有标签 → decorate 5.9ms
修复前同规模装饰 255 行  → decorate 36.8ms
```
成本从"与库总量成正比"变为"与结果集关联量成正比"。

### 顺带清理

删除 `repo.js` 6 个死代码导出（313 → 220 行）。
清理时误删了 `emitChange`/`alive`/`aliveOnly`（看着像导出、实际内部也在用），
已被全量回归捕获并恢复。

### 新增测试

`tests/html/nav_stress_test.js` —— 在 4 个页面间来回切 **40 次导航**后验证：
一次点击只触发 1 次操作、状态严格交替、容器外元素不触发。

**这个测试填补了重要空白**：之前所有测试都只导航 1~2 次，无法发现监听器累积。

### 验收

7 组 **168 项全通过**（本轮新增 6 项压力测试）：
单元 62 + 端到端 38 + 安全 11 + 数据文件 12 + 红点搜索 15 + 兼容性 24 + 导航压力 6

线上 v1.0.3（安装包 181,518 字节），导航压力测试在线上同样 6/6 通过。

### 审查发现的待改进项（未在本轮改）

| 优先级 | 事项 |
|---|---|
| P1 | 34 处页面越层直接调 Repo/DB（报表/画像的聚合应上移） |
| P1 | settings/profile/oplogs 的 async 事件缺 try/catch（有全局兜底但不具体） |
| P2 | 密码用单轮 SHA-256，建议改 PBKDF2 10 万轮 |
| P3 | 页面懒加载（当前启动加载全部 24 模块，287ms） |

---

## 4. 验收（真浏览器，非服务端 curl）

| 项 | 结果 |
|---|---|
| 产品页 HTTPS 200 + 标题正确 | ✓ |
| 入场动效全部完成（无元素停在 opacity:0） | ✓ 22/22 |
| 桌面 1440 无横向溢出 | ✓ 0px |
| 内容完整（8 功能卡 / 3 场景 / 12 规格行） | ✓ |
| 安装包真实 GET → 200 且字节数一致 | ✓ 179,061 |
| 应用页可启动（首次向导就绪） | ✓ |
| 全部 11 个核心模块加载成功 | ✓ |
| 线上可初始化并创建数据 | ✓ |
| 入口页卡片存在且点击可进入工具页 | ✓ |
| 移动端 390 无横向溢出 | ✓ 0px |
| 移动端导航收起但 CTA 保留 | ✓ |
| console / pageerror | ✓ 0 条 |

**合计 18/18 通过。**

---

## 5. 更新与回滚

```bash
# 更新：改完 src/ 或 docs/ 后重新走发布流水
python ~/.workbuddy/skills/xmtooldev-publish/scripts/prepare_publish_dir.py \
    team-planner docs/product.html /tmp/pub \
    docs/assets/team-planner.zip=team-planner.zip docs/assets/icon.svg=icon.svg
# 再把 src/* 放进 /tmp/pub/app/
python ~/.workbuddy/skills/xmtooldev-publish/scripts/publish_to_xmtooldev.py team-planner /tmp/pub

# 回滚
ssh root@example-test-host '/opt/xmtooldev/bin/deploy.sh team-planner --rollback'
ssh root@example-test-host 'ls /opt/xmtooldev/backup/snapshots/team-planner/'
```

---

## 6. 产品页设计说明

按 `impeccable` 技能的设计原则做的，记录关键决策便于后续维护：

| 维度 | 决策 | 理由 |
|---|---|---|
| 调性 | 清爽工作台 | 与产品界面同源（墨绿主色、白底、高密度），访客第一眼建立「同一个东西」的认知，避免营销页与产品割裂 |
| 字体 | 单一系统字体多字重 | 中文渲染最稳、零加载延迟。不引入展示字体是因为受众是国内内网用户，加载外链字体会失败 |
| 字号 | 5 级模块化（12.5 / 13.5 / 15 / h2 clamp / h1 clamp） | 避免 14/15/16/18 挤在一起的模糊层次 |
| 间距 | 4pt 基准（4→128 共 10 档） | 8pt 太粗，12px 这种常用值会缺 |
| 配色 | 墨绿 `#16a34a` 主色 + 偏绿中性灰 | 纯灰偏冷，中性色偏品牌色更整体 |
| 动效 | 仅 `opacity` + `transform`，`cubic-bezier(.16,1,.3,1)` | 只动这两个属性不触发重排；指数缓出不回弹（回弹是 2015 年的审美） |
| 动效时长 | 入场 700ms，悬停 180–250ms | 符合 100/300/500 规则 |
| 降级 | 默认可见 → `html.js` 才允许隐藏 | 这是必须的：JS 挂掉或 IO 不支持时，整页停在 `opacity:0` 是最经典的事故 |
| 减速 | `prefers-reduced-motion` 直接显示 | 前庭功能障碍影响约 35% 的 40 岁以上人群，不是可选项 |
| 高亮 | 底线强调而非高亮块 | 克制、不打断阅读节奏；用 `box-decoration-break:clone` 保证换行时每行完整 |
| 响应 | 980 / 720 / 400 三个断点 | 980 时界面示意前置（手机先看到产品再读文案），720 收起导航，400 按钮变全宽 |

---

## 7. 待办

| 项 | 说明 |
|---|---|
| 应用内「数据目录」授权 | 线上是 HTTPS，可正常使用 `showDirectoryPicker`；但浏览器重启后权限会降为 `prompt`，需用户再点一次（浏览器安全策略，无法规避） |
| 安装包版本号 | 当前固定为 `team-planner.zip`，未带版本号。若后续频繁更新，建议改名 `team-planner-v1.0.1.zip` 便于区分 |
| Firefox / Safari | 未实测（本机无环境）。代码已做能力探测：不支持目录选择时降级为手动导出 |
