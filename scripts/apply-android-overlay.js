/**
 * 把 mobile/android-overlay/ 里的原生悬浮窗代码集成进 Capacitor 生成的 Android 工程。
 * 用"打补丁"的方式而不是整目录覆盖，避免把 Capacitor 自动生成的配置弄丢。
 *
 * 前置：先在 mobile/ 目录跑过 `npx cap add android`
 * 用法：node scripts/apply-android-overlay.js
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OVERLAY = path.join(ROOT, 'mobile', 'android-overlay');
const ANDROID = path.join(ROOT, 'mobile', 'android');
const PKG = 'cn/onederz/widget';
const MANIFEST = path.join(ANDROID, 'app', 'src', 'main', 'AndroidManifest.xml');
const MAIN_ACTIVITY = path.join(ANDROID, 'app', 'src', 'main', 'java', PKG, 'MainActivity.java');

const log = (...a) => console.log('  ', ...a);
let problems = 0;

function must(cond, msg) {
  if (!cond) {
    console.error('  ✗ ' + msg);
    problems++;
  }
  return cond;
}

function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  let n = 0;
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) n += copyTree(s, d);
    else {
      fs.copyFileSync(s, d);
      n++;
      log('复制 ' + path.relative(ROOT, d).replace(/\\/g, '/'));
    }
  }
  return n;
}

/* ------------------------------ 1. 检查 ------------------------------ */
console.log('\nOnederz · Android 悬浮窗集成\n');

if (!must(fs.existsSync(ANDROID), '未找到 mobile/android，请先执行：cd mobile && npx cap add android')) {
  process.exit(1);
}
if (!must(fs.existsSync(MANIFEST), '未找到 AndroidManifest.xml')) process.exit(1);

/* --------------------------- 2. 复制 Java --------------------------- */
const javaDest = path.join(ANDROID, 'app', 'src', 'main', 'java', PKG);
copyTree(path.join(OVERLAY, 'app', 'src', 'main', 'java', PKG), javaDest);

/* --------------------------- 3. 补 AndroidManifest --------------------------- */
let manifest = fs.readFileSync(MANIFEST, 'utf8');

const PERMS = [
  ['android.permission.SYSTEM_ALERT_WINDOW', '在其他应用上层显示悬浮窗'],
  ['android.permission.FOREGROUND_SERVICE', '让悬浮窗常驻不被系统回收'],
  ['android.permission.FOREGROUND_SERVICE_SPECIAL_USE', 'Android 14+ 前台服务类型'],
  ['android.permission.POST_NOTIFICATIONS', 'Android 13+ 展示悬浮窗状态通知'],
];

let permAdded = 0;
for (const [name, note] of PERMS) {
  if (manifest.includes(`android:name="${name}"`)) continue;
  const line = `    <!-- ${note} -->\n    <uses-permission android:name="${name}" />`;
  if (manifest.includes('</manifest>')) {
    // 插到第一个 <application 之前
    manifest = manifest.replace(/(\s*)<application/, `\n${line}\n$1<application`);
    permAdded++;
  }
}
log(`权限：新增 ${permAdded} 条`);

const SERVICE_TAG = 'FloatingWidgetService';
if (!manifest.includes(SERVICE_TAG)) {
  const service = `
        <!-- Onederz 桌面悬浮窗：让待办像 PC 端一样浮在其他应用之上 -->
        <service
            android:name=".FloatingWidgetService"
            android:enabled="true"
            android:exported="false"
            android:foregroundServiceType="specialUse">
            <property
                android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE"
                android:value="桌面待办悬浮窗常驻显示" />
        </service>
`;
  if (manifest.includes('</application>')) {
    manifest = manifest.replace(/\s*<\/application>/, `${service}    </application>`);
    log('已注册 FloatingWidgetService');
  } else {
    must(false, 'AndroidManifest.xml 缺少 </application>');
  }
} else {
  log('FloatingWidgetService 已存在，跳过');
}

fs.writeFileSync(MANIFEST, manifest, 'utf8');

/* --------------------------- 3.5 补 app/build.gradle 依赖 --------------------------- */
/* FloatingWidgetService 用了 WebViewAssetLoader（androidx.webkit），
   Capacitor 生成的模板未必包含它 —— 幂等注入一次。 */
const BUILD_GRADLE = path.join(ANDROID, 'app', 'build.gradle');
if (fs.existsSync(BUILD_GRADLE)) {
  let gradle = fs.readFileSync(BUILD_GRADLE, 'utf8');
  if (!gradle.includes('androidx.webkit')) {
    if (gradle.includes('dependencies')) {
      gradle = gradle.replace(/(dependencies\s*\{)/, `$1\n    // 悬浮窗的 WebViewAssetLoader 需要\n    implementation 'androidx.webkit:webkit:1.10.0'`);
      fs.writeFileSync(BUILD_GRADLE, gradle, 'utf8');
      log('已注入 androidx.webkit 依赖');
    } else {
      must(false, 'app/build.gradle 找不到 dependencies 块');
    }
  } else {
    log('androidx.webkit 依赖已存在，跳过');
  }
} else {
  must(false, '未找到 app/build.gradle');
}

/* --------------------------- 4. 注册插件 --------------------------- */
const ACTIVITY = `package cn.onederz.widget;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

/**
 * Onederz 主界面
 * 在 super.onCreate 之前注册悬浮窗插件，前端才拿得到 window.Capacitor.Plugins.FloatingWidget。
 */
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(FloatingWidgetPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
`;
fs.writeFileSync(MAIN_ACTIVITY, ACTIVITY, 'utf8');
log('已重写 MainActivity（注册 FloatingWidgetPlugin）');

/* --------------------------- 5. 结果 --------------------------- */
if (problems) {
  console.error(`\n✗ 集成未完成，有 ${problems} 个问题需要处理\n`);
  process.exit(1);
}
console.log(`
✓ 悬浮窗集成完成

  接下来：
    1. cd mobile && npm install
    2. npx cap sync android
    3. npx cap open android      # 用 Android Studio 打开并运行
  手机端首次点「开启桌面悬浮」时会跳转系统设置申请"在其他应用上层显示"权限。
`);
