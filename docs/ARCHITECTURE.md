# Onederz 架构说明

## 1. 分层

```
┌──────────────────────────────────────────────────────────────┐
│  app/  共享前端（唯一一份 UI 与业务逻辑）                       │
│   lib/model.js  业务规则（纯函数，可单测）                      │
│   lib/sync.js   同步引擎（outbox + LWW + WebSocket）            │
│   lib/store.js  本地持久化（localStorage）                      │
│   app.js        控制器：把状态、渲染、原生桥串起来               │
└───────────┬──────────────────────────────┬───────────────────┘
            │                              │
   ┌────────▼────────┐            ┌────────▼─────────┐
   │ desktop/        │            │ mobile/www/      │
   │ Electron 外壳   │            │ Capacitor 外壳   │
   │ 原生：亚克力/   │            │ 原生：悬浮窗服务 │
   │ 圆角/桌面层     │            │ (可选)           │
   └────────┬────────┘            └────────┬─────────┘
            │  HTTP/WSS                    │
            └──────────┬───────────────────┘
                       ▼
            ┌──────────────────────┐
            │ server/  同步服务    │
            │ 增量同步 + 广播       │
            │ JSON 文件持久化       │
            └──────────────────────┘
```

三端共用 `app/`：Windows 端由 Electron 用 loopback 静态服务提供页面，
Android 端由 Capacitor 打包进 APK，浏览器端直接访问。

> **为什么用 loopback HTTP 而不是 `file://`？**
> 前端是原生 ES Module，`file://` 下浏览器会因 CORS 拒绝加载模块。
> 统一走 HTTP 之后，三端加载方式完全一致，不必为桌面端维护特殊打包流程。

---

## 2. 数据模型

```js
Task {
  id            唯一 ID
  type          'daily' 常驻 | 'temp' 临时
  title         内容
  note          备注
  date          归属日 'YYYY-MM-DD'（临时任务用；常驻任务为 null）
  doneDate      ★ 完成于哪一天（null = 未完成）
  doneAt        完成时刻（展示用）
  remindAt      提醒时间戳
  remindFiredOn 已提醒的日期键，避免重复提醒、并支持跨天重置
  countdownTo   倒计时目标时间戳
  order         同组内排序
  createdAt/updatedAt
  deviceId      最后修改设备（同步冲突兜底 + 来源追溯）
  deleted       墓碑标记
}
```

### 2.1 完成态 = 日期推导，不是布尔值

| | 判定 |
|---|---|
| 常驻任务 | `doneDate === 今天` |
| 临时任务 | `doneDate != null` |

这是整个项目最关键的一处设计。传统做法是"零点定时把 `done` 置回 false 并同步"，
会带来三个问题：定时器可能不触发（设备休眠）、重置事件要参与冲突解决、
离线设备的本地状态会和服务端打架。

改成日期推导后：

- **零点自动生效** —— 日期变了，判定结果自然翻转，无需任何写入；
- **同步层零负担** —— 重置不是一个"事件"，不需要被同步；
- **离线安全** —— 设备三天后开机，状态也是对的；
- **A 端勾选 → B 端同步 → 两端都显示"今天已完成"**，因为 `doneDate` 跟着任务走。

### 2.2 每日维护做什么

`runDailyMaintenance()` 只做一件事：把过期的临时任务标记为 `deleted`（墓碑）。
标记而不是物理删除，是为了让其他设备同步后也一起清掉，避免"这台删了那台还在"。

---

## 3. 同步协议

```
POST /api/auth/register  { username, password }            → { token, userId, username }
POST /api/auth/login     { username, password }            → { token, userId, username }
GET  /api/snapshot       Bearer                            → 全量任务（新设备首次接入）
POST /api/sync           Bearer { since, changes[], deviceId }
                                                           → { now, changes[], accepted }
GET  /api/health                                           → { ok, stats }
WS   /ws?token=...                                         ← { type:'changes', changes[] }
```

### 3.1 一次同步的流程

```
客户端                                    服务端
  │  POST /api/sync {since, changes[]}      │
  │───────────────────────────────────────►│
  │                                        │ 1. 对每个 id 做 LWW 合并
  │                                        │ 2. 收集 updatedAt > since-2000 的变更
  │                                        │ 3. 有实际采纳 → 广播给同账号其他连接
  │◄───────────────────────────────────────│
  │ {now, changes[], accepted}             │
  │                                        │
  │ 4. 本地 mergeChanges()，同 id 走 LWW     │
  │ 5. since = now                         │
```

`since` 回退 2000ms 是刻意的：各端时钟总有几十毫秒到几秒的偏差，
回拨一点窗口可以避免"更新刚写进去却因为时钟偏慢被漏拉"。合并是幂等的，多拉不会出错。

### 3.2 冲突合并规则（`pickWinner`）

1. `updatedAt` 大者胜；
2. 时间相同 → **删除优先**（删除是更强的主张，避免已删任务被旧数据复活）；
3. 再相同 → 比较 `deviceId`，保证任意两台设备算出同一个结果。

客户端 `model.js` 与服务端 `server/src/store.js` 的规则**逐条对齐**，
否则会出现"客户端认为赢的是 A、服务端认为赢的是 B"的分裂。

### 3.3 实时推送

WebSocket 连接按 `userId` 分组。任一设备上行并触发了实际变更，
服务端就把这批变更广播给该用户的其他连接，其他端立刻 `mergeChanges` + 重绘。
心跳 30s，半开连接自动清理。

---

## 4. Windows 原生层

`desktop/src/win32.js` 通过**常驻 PowerShell 宿主进程 + 内联 C#** 调用 Win32 API。
为什么不用 `koffi` / `ffi-napi`？—— 那些是原生模块，装到 Electron 里需要按 Electron 的
ABI 重新编译，是 Electron 项目最常见的踩坑点。PowerShell 方案零依赖、开箱即用。

| 能力 | API |
|---|---|
| 亚克力磨砂 | `SetWindowCompositionAttribute` + `ACCENT_ENABLE_ACRYLICBLURBEHIND` |
| 系统圆角 | `DwmSetWindowAttribute(DWMWA_WINDOW_CORNER_PREFERENCE)`；失败退回 `SetWindowRgn` |
| 桌面层挂载 | `EnumWindows` 找 `WorkerW` → `SetParent`（实验性，见下） |
| 层级判定 | `GetForegroundWindow` + `GetClassName`（判断桌面是否在最前） |
| 点击可达性 | `WindowFromPoint` + `GetWindowThreadProcessId`（确认点击落在我方） |

**性能要点**：`Add-Type` 编译 C# 有数百毫秒开销，`isDesktopOnTop` 又要 500ms 轮询一次，
所以宿主进程常驻、用 stdin/stdout 逐行收发命令（一行命令一行响应），
而不是每次新起进程。启动时预热一次，把编译开销提前。

### 圆角必须在下沉之前施加

`DwmSetWindowAttribute(DWMWA_WINDOW_CORNER_PREFERENCE)` **只对顶层窗口生效**。
窗口一旦被 `SetParent` 下沉为子窗口，调用就会被拒绝，只能退回 `SetWindowRgn`
做区域裁剪（有锯齿）。所以顺序必须是：磨砂 → 圆角 → 层级，且窗口显示后再补几次
（DWM 有时惰性）。这个顺序问题会让圆角看起来"偶尔生效偶尔不生效"。

### 桌面层挂载：一个会静默失效的陷阱

**Windows 上 Electron 的透明窗口存在两个 `Chrome_WidgetWin_1`。**
`getNativeWindowHandle()` 返回的那个不承载页面内容；真正显示内容的是
`WindowFromPoint` 命中的 `Chrome_RenderWidgetHostHWND` 所属的另一个窗口。

后果：对前者调用 `SetParent` 会正常返回、`GetAncestor(GA_PARENT)` 也显示父窗口已变，
**但内容窗口的位置与层级毫无变化**。看起来成功，实际什么都没发生。

判定这类操作是否真的生效，必须**以"承载内容的窗口"为准**：

1. 在窗口重心做 `WindowFromPoint`，得到内容窗口；
2. 沿 `GetAncestor(GA_PARENT)` 走祖先链；
3. 检查目标 `WorkerW` 是否出现在链中 —— 出现才算真的挂上。

另外两条同样重要的经验：

- **不要用 `GetParent()` 判定父子关系**。`WS_POPUP` 窗口（Electron 无边框窗口即是）
  的 `GetParent()` 返回的是**所有者**而非父窗口，通常为 0，会把成功的操作误判为失败。
  正确做法是 `GetAncestor(hwnd, GA_PARENT)`。
- **判定"点击是否落在我方"要比进程，不要比句柄**。命中的是子窗口
  （`Chrome_RenderWidgetHostHWND`）而非顶层窗口，直接比句柄会得出错误的否定结论；
  用 `GetWindowThreadProcessId(hit) == GetWindowThreadProcessId(self)` 才可靠。

因为这些限制，「桌面层挂载」在 Onederz 里不是默认方案：默认的
**「跟随桌面显示 / 隐藏」**（前台是桌面就显示，打开其他应用就隐藏）对用户可见行为一致，
且完全可控。桌面层作为实验性选项保留，挂载后自校验、失败自动回落。

---

## 5. 磨砂玻璃：两层模型

面板外观由**两层**叠加而成，分清"谁承担不透明度"是调好观感的前提：

```
   桌面壁纸
      │
      ├─ 层 1  系统级模糊/磨砂   Windows: SetWindowCompositionAttribute(亚克力)
      │                          Android 12+: FLAG_BLUR_BEHIND + setBlurBehindRadius
      │                          浏览器/旧 Android: 无
      │
      ├─ 层 2  页面玻璃层 .widget  rgba(基色, α) + backdrop-filter
      │         （另有随浓度变化的顶部高光 --sheen）
      │
      └─ 内容
```

| 端 | 层 1 | 层 2（α） | 滑块映射 |
|---|---|---|---|
| Windows 桌面端 | 亚克力（承担填充） | 0.05–0.15 极薄色膜 | **1:1 → 亚克力 alpha**：`alpha = 14 + 218 × 浓度` |
| 浏览器 / Android | 无 | 承担全部 | α = 浓度，覆盖 8%–96% |

关键点：两层各调各的会变成"雾上加雾"（页面 62% 白 + 亚克力 54% 白 ≈ 82% 不透明），
而且最初的映射是反向的（浓度调低 → 亚克力 alpha 反而升高），
导致"越调越不透"。现在统一为：**有系统填充时页面只上色，没有时页面全担**，
单一滑块在两端都单调、可控。

浓度同时驱动顶部高光 `--sheen`：玻璃厚则高光明显，玻璃透则收敛，
避免通透档位被一层固定白纱糊掉。

前端用 `body.env-desktop / .env-android / .env-android-overlay / .env-web`
四个类区分运行环境（`glassLayers()` 据此决定分工），玻璃层是同一套 CSS 变量驱动，
视觉语言三端一致。基色由 `data-tint` 决定：浅色 `rgba(255,255,255,α)`、
深色 `rgba(24,27,36,α)`；浏览器与 Android 端的环境光底色另行通过 `body[data-glass]`
切换明暗，避免深色玻璃落在浅色底上导致文字对比度不足。

---

## 6. 安全与权限

- Electron 渲染进程 `contextIsolation: true`、`nodeIntegration: false`，
  原生能力经 `preload.js` 白名单暴露；
- 外部链接一律交给系统浏览器，窗口内不允许导航到非本地地址；
- 口令用 `scrypt` + 随机盐，令牌是自签 HMAC（90 天有效），密钥可经 `ONEDERZ_SECRET` 指定；
- Android 悬浮窗需要用户显式授予 `SYSTEM_ALERT_WINDOW`，不申请多余权限。

---

## 7. 可扩展点

- **多设备/多清单**：`Task` 加 `listId`，服务端按 `userId + listId` 分桶即可；
- **富文本备注**：`note` 字段目前是纯文本，换成 markdown 只需改渲染层；
- **服务端换数据库**：`server/src/store.js` 是唯一的数据访问层，接口保持不变即可替换为 SQLite/Postgres；
- **端到端加密**：`title` / `note` 在客户端加密后上行，服务端只做密文合并。
