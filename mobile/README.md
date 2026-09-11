# Onederz · Android 端

界面与业务逻辑完全复用 `app/`，Capacitor 只做外壳与原生能力桥。
`mobile/www/` 由 `node ../scripts/sync-mobile.js` 从 `app/` 自动生成，**不要手改**。

---

## 路线 A：PWA（零安装，马上可用）

计算机上先启动同步服务：

```bash
npm run server        # 记下打印的局域网地址，例如 http://192.168.1.10:8787
npm run preview       # 界面服务，默认 4317 端口
```

手机浏览器打开 `http://192.168.1.10:4317/`，在「⋯ → 设置与同步」填入同步服务地址并登录。
用浏览器菜单里的**「添加到主屏幕」**即可变成类原生 App。

---

## 路线 B：GitHub Actions 云端构建（推荐，本机零依赖）

仓库自带 CI（`.github/workflows/android.yml`）：每次推送到 `main` 或在
**Actions → Android APK → Run workflow** 手动触发，GitHub 云端自动
装配 Android 工程并编译 debug APK，产物在构建页面的 **Artifacts** 里下载
（`trans-todo-debug-apk`）。**本机不需要装 Java / Android SDK / Android Studio。**

手动触发：

```bash
# 也可以用 API 触发
curl -X POST -H "Authorization: token <你的PAT>" \
  https://api.github.com/repos/Uranus1952/trans-todo/actions/workflows/android.yml/dispatches \
  -d '{"ref":"main"}'
```

---

## 路线 C：本地打包 APK（含桌面悬浮窗）

需要 **Android Studio**（含 Android SDK）与 **JDK 17**。

```bash
cd mobile
npm install

# 生成 Android 工程（首次）
npx cap add android

# 集成原生悬浮窗（复制 Java 源码 + 打补丁到 AndroidManifest / MainActivity）
node ../scripts/apply-android-overlay.js

# 把最新前端同步进工程并同步插件
npx cap sync android

# 打开 Android Studio 运行 / 打签名包
npx cap open android
```

一条命令搞定全部步骤：

```bash
cd mobile && npm run setup
```

生成调试 APK（无需打开 IDE）：

```bash
cd mobile && npm run apk
# 产物：mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

---

## 桌面小组件（天气卡片式）怎么用

不想开 App 也能一眼看到待办——**长按桌面空白处 → 小组件 / Widgets → Onederz → 拖到桌面**。

| 特性 | 说明 |
|---|---|
| 显示内容 | 标题栏「今日待办 · 完成数/总数」+ 最多 9 条任务（✓ 已完成 / □ 未完成） |
| 点击行为 | 点组件任意位置打开 App |
| 尺寸 | 默认 3×2 格，可横向纵向自由拉伸 |
| 数据更新 | App 内任何改动实时推送到组件；跨天后组件自动重置常驻任务状态（即使 App 没打开，系统每 30 分钟刷新一次） |
| 多端一致 | 手机上勾选的任务，组件状态与 Windows / 其他设备同步更新 |

> 组件与「桌面悬浮窗」是两个独立能力：小组件是标准桌面部件（不悬浮在应用之上），
> 悬浮窗是覆盖在其他 App 上的浮层。二选一或都开都行。

---

## 桌面悬浮窗怎么用

1. App 内 **⋯ → 设置与同步 → 桌面悬浮窗（Android）**
2. 点「开启桌面悬浮」→ 首次会跳转系统设置，授予**「在其他应用上层显示」**
3. 回到 Onederz 再点一次「开启桌面悬浮」→ 待办就会浮在桌面上

| 操作 | 手势 |
|---|---|
| 移动窗口 | 拖动**顶部标题条** |
| 缩放窗口 | 拖动**右下角 30dp 热区** |
| 吸附回桌面 | 位置与尺寸自动持久化，重启后保持 |

关闭方式：悬浮窗内点右上角 ✕，或从通知栏操作，或在设置里点「关闭悬浮窗」。

---

## 实现要点

### 同源，所以数据天然一致

悬浮窗里的 WebView 用 `WebViewAssetLoader` 把 `assets/public` 映射到
`https://localhost`，与 Capacitor 主 WebView **完全同源**。
因此两个界面共用同一份 `localStorage`，不存在"悬浮窗改了主界面看不到"的问题。

### 磨砂玻璃

- Android 12+：`FLAG_BLUR_BEHIND` + `setBlurBehindRadius(26dp)` —— 系统级窗口模糊，
  磨砂质感与 Windows 端一致；
- Android 12 以下：退化为半透明圆角容器，仍是玻璃观感。

### 前台服务

悬浮窗由前台服务维持，避免被系统内存回收；通知优先级设为 `IMPORTANCE_MIN`，
不打扰但可随时从通知栏关闭。

### 权限清单

| 权限 | 用途 |
|---|---|
| `SYSTEM_ALERT_WINDOW` | 悬浮窗（用户显式授权） |
| `FOREGROUND_SERVICE` | 悬浮窗常驻 |
| `FOREGROUND_SERVICE_SPECIAL_USE` | Android 14+ 前台服务类型要求 |
| `POST_NOTIFICATIONS` | 悬浮窗状态通知（Android 13+） |

---

## 文件对照

```
mobile/
├── capacitor.config.json         Capacitor 配置（webDir=www，androidScheme=https）
├── www/                          由 app/ 自动同步，勿手改
└── android-overlay/              集成用的原生源码
    └── app/src/main/java/cn/onederz/widget/
        ├── FloatingWidgetService.java   悬浮窗服务（窗口、模糊、手势）
        ├── FloatingWidgetPlugin.java    Capacitor 插件（权限 / 开关）
        └── MainActivity.java            注册插件

scripts/apply-android-overlay.js       把上面的文件复制进生成的 Android 工程，
                                       并向 AndroidManifest 注入权限与 <service>
```

`apply-android-overlay.js` 是**打补丁**而不是整目录覆盖：
Capacitor 后续 `cap sync` 重新生成的配置不会被破坏，重复执行也安全（幂等）。
