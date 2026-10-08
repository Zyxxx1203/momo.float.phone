# 全局通话 + 原生浮窗 · 移植说明书

> 这份文档给**另一个 AI** 看：照着改就能在自己的副本里复现这套通话功能。
> 每个结论都来自实际踩坑，关键处附上「为什么」和「症状」，不是泛泛的接口说明。
>
> 涉及两层，可以分开移植：
> - **网页层**：通话不再被卸载、可拖动缩放的网页小窗、自动搭话、消息排队、配色自定义。
> - **原生壳层**（可选但推荐）：能浮在**其他 App 上层**的系统浮窗、切出去也能听、长按就地回复。

---

## 零、先搞清楚这套东西解决什么问题

原版通话的实现方式是把通话界面**渲染在聊天室组件内部**，界面又 portal 到聊天室的父容器。后果：

| 用户动作 | 原版表现 |
|---|---|
| 点「返回」，回到会话列表 | 通话层跟着被隐藏，看着像已挂断 |
| 回手机桌面 | 聊天 App 整个卸载，通话直接销毁 |
| 切到别的 App | 通话小窗随浏览器切走，看不见 |

目标状态：**通话全程由一个常驻层持有**，切会话、回桌面、开别的 App 都不断。

---

## 一、整体架构

```
                    ┌──────────────────────────────┐
                    │  lib/call-session-store.ts   │  ← 全局真值：当前是否在通话
                    │  （叶子模块，零外部依赖）      │
                    └───────────┬──────────────────┘
                                │ useSyncExternalStore
                    ┌───────────▼──────────────────┐
                    │ components/chat/call-layer   │  ← 由 desktop-shell 常驻渲染
                    │  按 id 现取 session/角色       │
                    └───────────┬──────────────────┘
                                │
        ┌───────────────────────┼───────────────────────┐
        ▼                       ▼                       ▼
  voice-call-screen      video-call-screen      group-call-screen
  （只负责「发起」，不再渲染通话屏本身）
```

通话屏本身仍然负责通话逻辑（识别、TTS、对话轮），只是**渲染位置**从聊天室挪到了常驻层。

**关键设计取舍**：全局状态里**只存身份**（sessionId / characterId / kind），不存会话对象。
会话和角色按 id 从本地存储现取——否则改名、换头像后浮窗会显示旧值。

---

## 二、网页层改动清单

### 2.1 新增文件

| 文件 | 职责 |
|---|---|
| `lib/call-session-store.ts` | 全局通话状态。`startCall` / `minimizeCall` / `restoreCall` / `endCall` / `subscribeActiveCall` / `getActiveCall` / `getActiveCallServerSnapshot` / `hasActiveCall` / `isCallActiveForSession` |
| `components/chat/call-layer.tsx` | 常驻通话层。无通话渲染 `null`，有通话按 id 现取数据渲染对应通话屏 |
| `components/chat/call-mini-window.tsx` | 可拖动 / 缩放的网页小窗，portal 到 body |
| `components/chat/use-shell-call-overlay.ts` | 三个通话屏共用：接入原生浮窗的接线钩子 |
| `components/chat/use-call-auto-chat.ts` | 自动搭话的运行时（心跳、计数、退避） |
| `components/chat/use-call-reply-queue.ts` | 消息排队补发 |
| `components/chat/call-auto-chat-control.tsx` | 自动搭话的设置按钮 + 面板（可拖动） |
| `lib/call-auto-chat.ts` | 自动搭话配置（存 kv-db） |
| `lib/call-overlay-theme.ts` | 回复条配色（预设 + 逐项自定义） |
| `lib/shell-call-overlay.ts` | 网页 ↔ 原生浮窗桥 |
| `components/settings/call-overlay-settings.tsx` | 设置页：预设配色 / 逐项颜色 / 诊断 |

### 2.2 修改文件

**`components/desktop-shell.tsx`**（两处，缺一不可）

```tsx
import { CallLayer } from "@/components/chat/call-layer";

// 渲染位置：放在 <MascotPreviewHost /> 之后
<CallLayer />
```

同时监听通话结束事件，触发角色回应：

```tsx
useEffect(() => {
    const onEnded = (e: Event) => {
        const detail = (e as CustomEvent).detail as { sessionId?: string };
        // 走后台回复通道，让角色对「刚挂断」这件事有反应
        if (detail?.sessionId) void requestBackgroundChatReply(detail.sessionId);
    };
    window.addEventListener("chat-call-ended", onEnded);
    return () => window.removeEventListener("chat-call-ended", onEnded);
}, []);
```

> **为什么放这里**：挂断时聊天页未必挂载着（用户可能已经回到桌面）。收尾逻辑必须放在**常驻**的桌面壳里，否则那次角色回应会丢。

**`components/chat/chat-room.tsx`**

- 删掉三个通话屏的 import（`VoiceCallScreen` / `VideoCallScreen` / `GroupCallScreen`）；
- 删掉 5 个通话 state（`showVoiceCall` / `showVideoCall` / `callMinimized` / `callInitiator` / `callInitiatorName`）；
- 删掉聊天室内的通话屏渲染（含群聊的整屏早退分支）；
- 来电触发（`ai-call-trigger` 事件）、手动拨打全部改走 `startCall()`；
- 新增 `chat-call-ended` 监听：重置滚动状态 + 从存储重新同步消息。

**`components/chat/voice-call-screen.tsx` / `video-call-screen.tsx` / `group-call-screen.tsx`**

- 对外新增 `minimized` / `onMinimize` / `onRestore` 三个 props；
- `minimized` 时渲染 `CallMiniWindow`；
- 接入 `useCallAutoChat` / `useCallReplyQueue` / `useShellCallOverlay`。

> **群聊要特别注意**：原版群聊**完全没有**小窗实现（连 props 都没有）。补的时候视频和语音两种布局各有各的缩小键位置。

---

## 三、原生壳层改动（可选，但这是「浮在其他 App 上层」的唯一途径）

网页里的悬浮元素**永远出不了浏览器窗口**。要做系统级浮窗，必须有原生壳。

### 3.1 新增文件

| 文件 | 职责 |
|---|---|
| `CallOverlayService.kt` | 前台服务 + `WindowManager` 浮窗，承载通话小窗与快捷回复条 |
| `ShellBus.kt` | 原生 → 网页的单向事件通道 |
| `CallControlService.kt` | 无障碍服务（浮窗保活 + 前台 App 感知） |
| `OverlayActionReceiver.kt` | 通知动作按钮 |
| `res/xml/call_control_service.xml` | 无障碍服务声明 |

### 3.2 `AndroidManifest.xml`

```xml
<uses-permission android:name="android.permission.SYSTEM_ALERT_WINDOW" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK" />

<service
    android:name=".CallOverlayService"
    android:exported="false"
    android:foregroundServiceType="mediaPlayback" />

<service
    android:name=".CallControlService"
    android:exported="true"
    android:permission="android.permission.BIND_ACCESSIBILITY_SERVICE">
    <intent-filter>
        <action android:name="android.accessibilityservice.AccessibilityService" />
    </intent-filter>
    <meta-data android:name="android.accessibilityservice"
        android:resource="@xml/call_control_service" />
</service>
```

**权限分三类，别搞混**：

1. **普通权限**：清单里声明即可生效；
2. **危险权限**（位置、通讯录、媒体…）：声明只是「有资格申请」，**还要代码弹窗让用户同意**；
3. **特殊权限**（`SYSTEM_ALERT_WINDOW`、`WRITE_SETTINGS`、`PACKAGE_USAGE_STATS`）：**弹窗都弹不出来**，必须跳系统设置页让用户手动开。

浮窗权限属于第 3 类。**必须提供引导入口**，否则用户永远开不了，浮窗永远不出现——而且这不是代码 bug。

### 3.3 `MainActivity.kt` 要暴露的桥方法

```kotlin
@JavascriptInterface fun startCallOverlay(name, avatar, meta, callId, elapsedSeconds): Boolean
@JavascriptInterface fun showCallOverlay()
@JavascriptInterface fun hideCallOverlay()
@JavascriptInterface fun updateCallOverlay(name, avatar, meta, elapsedSeconds)
@JavascriptInterface fun stopCallOverlay()
@JavascriptInterface fun canDrawOverlay(): Boolean
@JavascriptInterface fun requestOverlayPermission()
@JavascriptInterface fun getOverlayThemeJson(): String
@JavascriptInterface fun setOverlayThemeJson(json: String)
@JavascriptInterface fun getOverlayDebugInfo(): String   // 排障用，强烈建议做
```

另外两个**必须重写**的生命周期回调：

```kotlin
override fun onStop()  { super.onStop();  CallOverlayService.onHostBackground() }
override fun onStart() { super.onStart(); CallOverlayService.onHostForeground() }
```

---

## 四、双向通信协议

### 4.1 网页 → 原生

直接调 `window.AndroidShell` 上的方法（`@JavascriptInterface`）。

### 4.2 原生 → 网页

`evaluateJavascript` 派发 CustomEvent：

```kotlin
fun dispatchOverlayEvent(action: String, payload: JSONObject = JSONObject()) {
    val detail = JSONObject(payload.toString()).put("action", action)
    val literal = JSONObject.quote(detail.toString())
    evalJs("window.dispatchEvent(new CustomEvent('shell-call-overlay'," +
          "{detail:JSON.parse($literal)}))")
}
```

> **别手写字符串转义**。角色名里出现引号、反斜杠、换行时会把 JS 拼坏。
> 用 `JSONObject.quote` 生成合法字面量，再交给页面 `JSON.parse`。

事件类型：

| action | 载荷 | 含义 |
|---|---|---|
| `tick` | `seconds` / `callId` | 每秒心跳，校准时长并驱动后台的自动搭话 |
| `reply` | `text` / `callId` | 用户在原生回复条里发的消息 |
| `restore` | `callId` | 点浮窗要回全屏 |
| `hangup` | — | 挂断 |
| `needPermission` | — | 浮窗权限没开，网页应引导 |
| `foregroundApp` | `package` | 无障碍感知到的前台包名 |

---

## 五、踩过的坑（这一节最值钱）

### 坑 1 · 头像把 Binder 事务撑爆，浮窗直接起不来 ★★★

**症状**：浮窗完全不出现；诊断里「服务运行 / 有实例 / 窗口已挂」全是「否」。

**报错**：

```
startForegroundService: RuntimeException:
android.os.TransactionTooLargeException: data parcel size 5040676 bytes
```

**原因**：Binder 事务上限约 **1MB**。头像以 data URL（base64，比原图还大 1/3）
经 `Intent.putExtra` 传递，几 MB 的头像必然超限，服务根本启动不了。

> 这个坑的阴险之处：**小头像能过、大头像必炸**，表现为「有时行有时不行」，
> 很容易误判成时序或权限问题。

**修法**：头像先落成 `cacheDir` 里的文件，Intent 只带**路径**：

```kotlin
fun prepareAvatarRef(context: Context, avatar: String): String {
    val value = avatar.trim()
    if (value.isEmpty()) return ""
    if (!value.startsWith("data:image/")) return value   // http 直链/已是路径
    return runCatching {
        val comma = value.indexOf(',')
        if (comma < 0) return@runCatching ""
        val bytes = Base64.decode(value.substring(comma + 1), Base64.DEFAULT)
        val file = File(context.cacheDir, "call_overlay_avatar.img")  // 固定名，每次覆盖
        file.writeBytes(bytes)
        file.absolutePath
    }.getOrDefault("")
}
```

**`start` 和 `update` 两条路径都要改**——只修一条会留个同源的坑。

解码时按需降采样（浮窗最宽也就 320dp）：

```kotlin
var sample = 1
while (bounds.outWidth / sample > 1024) sample *= 2
BitmapFactory.decodeFile(path, BitmapFactory.Options().apply { inSampleSize = sample })
```

### 坑 2 · Android 12+ 禁止后台启动前台服务 ★★★

**症状**：切到别的 App 时浮窗不弹，**但声音照旧**（放音走媒体通道，不依赖浮窗）。

**原因**：`startForegroundService` 在 App 处于后台时会被系统拒绝
（`ForegroundServiceStartNotAllowedException`）。而「用户切出去」那一刻，App 恰好就在后台。

**修法**：**通话一通就在前台把服务暖好**，窗口建出来但先藏着；切后台只改可见性。

```kotlin
ACTION_START -> {
    // 预热：此刻 App 一定在前台，启动前台服务不会被拒
    showOverlay(visible = false)
    startHeartbeat()
}
ACTION_SHOW -> showOverlay(visible = true)   // 只是改可见性，不重新启动服务
ACTION_HIDE -> showOverlay(visible = false)
```

### 坑 3 · 浮窗显隐不能只靠网页 visibilitychange ★★★

**症状**：同一件事——退出去浮窗不弹。

**原因**：App 一退到后台，**WebView 的 JS 会被系统冻结或节流**，
「网页通知原生显示浮窗」这条链路**在源头就断了**。

**修法**：浮窗显隐改由 **Activity 生命周期直接驱动**（系统回调不受 JS 是否在跑影响）：

```kotlin
override fun onStop()  { CallOverlayService.onHostBackground() }
override fun onStart() { CallOverlayService.onHostForeground() }
```

```kotlin
fun onHostBackground() {
    val instance = liveInstance ?: return
    instance.main.post { instance.showOverlay(true) }
}
```

> 网页那条链路保留为辅助即可，但**不能作为主路径**。
>
> 顺带一提：`show()` 优先**同进程直接操作服务实例**，比走 Intent 更可靠，
> 也免掉「刚接通就切出去」时的 Intent 投递竞态。

### 坑 4 · `addView` 失败被静默吞掉，浮窗永久失效 ★★

**原因**：类似下面这种写法——

```kotlin
rootView = layout
runCatching { windowManager.addView(layout, params) }   // 异常被吞
```

`addView` 失败时异常被吞，但 `rootView` 已被赋成非空。之后每次 show 都只是
去改一个**根本没挂上的 View** 的可见性——浮窗永远不出现，且**没有任何报错**。

**修法**：只有真挂上才算建好，失败要复位并留下原因：

```kotlin
val added = runCatching { windowManager.addView(layout, params) }
if (added.isFailure) {
    rootLayout = null
    added.exceptionOrNull()?.let { recordError("addView", it) }
    ShellBus.dispatchOverlayEvent("needPermission")
    return@post
}
rootLayout = layout
rootView = layout
```

### 坑 5 · 整条链路静默吞异常 = 蒙眼改代码 ★★★（方法论）

浮窗链路上全是 `runCatching`：好处是不会因为浮窗异常拖垮通话，
坏处是**「不出现」时一条线索都不留**。

**这个功能上我们猜错了整整两轮**（猜权限、猜时序、猜生命周期），
直到加上自检才一次定位（就是坑 1）。

**强烈建议一开始就做**：

```kotlin
fun debugInfo(context: Context): String = JSONObject()
    .put("canDraw", canDraw(context))            // 权限给了吗
    .put("running", running)                      // 服务起来了吗
    .put("hasInstance", liveInstance != null)    // 通话发过 START 吗
    .put("windowAdded", liveInstance?.rootView != null)  // 窗口真挂上了吗
    .put("visible", liveInstance?.overlayVisible == true) // 是藏着的吗
    .put("lastError", lastError)                  // 最近一次失败原因
    .toString()
```

再在设置页原样展示，并写明「哪一项为否 = 什么问题」。后面所有问题都是这么定位的。

### 坑 6 · const 的暂时性死区（TDZ）导致整页白屏 ★★

**症状**：整页崩溃报 `Cannot access 'X' before initialization`。

**原因**：`useEffect` 引用了**在它下面才定义**的 `const` 函数：

```tsx
useEffect(() => { /* 用了 handleHangup */ }, [handleHangup]);
// ...
const handleHangup = useCallback(() => { ... });   // ← 在后面定义
```

渲染时读到「未初始化」直接抛错。

**修法**：把 effect 移到被引用函数**之后**。或者用 ref 中转（见坑 7）。

**另一个教训**：这个错误之所以发生，是因为我们**改动了模块加载图**。
如果只是接线，第一步可以刻意做成「零行为变化的挂载探针」先验证不崩，再加逻辑。

### 坑 7 · 监听器每秒重装 ★★

**原因**：`handleHangup` 依赖 `callDuration`（每秒都变），进 effect 依赖数组会让
订阅**每秒重建一次**。

**修法**：用 ref 转发：

```tsx
const hangupRef = useRef<() => void>(() => {});
useEffect(() => { hangupRef.current = handleHangup; }, [handleHangup]);

useEffect(() => subscribeShellOverlayEvents((event) => {
    if (event.action === "hangup") hangupRef.current();
}), []);   // ← 依赖留空，订阅只建一次
```

同样的模式适用于所有「回调依赖高频变化的值」的地方（`getDuration` 也用 getter 而非值）。

### 坑 8 · 群聊缩成小窗后有一层看不见的壳挡住桌面 ★★

**原因**：`call-layer.tsx` 给群聊套了一层全屏容器：

```tsx
<div className="absolute inset-0 z-[100]">
    <GroupCallScreen ... />
</div>
```

缩成小窗时，小窗本身 portal 到了 body，但这层**空壳仍留在原地**盖住整个桌面，
用户点哪儿都没反应。

**修法**：缩小时不套壳。

```tsx
if (call.minimized) return <GroupCallScreen {...groupProps} />;
return <div className="absolute inset-0 z-[100]"><GroupCallScreen {...groupProps} /></div>;
```

### 坑 9 · `useSyncExternalStore` 的快照必须是稳定引用 ★★

```ts
// 错：每次都返回新对象 → 判定「快照一直在变」→ 无限重渲染
export function getActiveCall() { return activeCall ? { ...activeCall } : null; }

// 对：只在真正变更时换新对象
export function getActiveCall() { return activeCall; }
```

另外别忘了第三个参数（server snapshot），否则 SSR 报错：

```ts
export function getActiveCallServerSnapshot(): ActiveCall | null { return null; }
```

### 坑 10 · 网页小窗必须 portal 到 body ★

手机壳内部有 `overflow` / `transform` 布局，直接挂在里面时 `position: fixed`
**可能被裁剪或算错参照点**。用 `createPortal(node, document.body)`。

### 坑 11 · 原生回复条要单独开窗口，且不能带 FLAG_NOT_FOCUSABLE ★★

浮窗主体是 `FLAG_NOT_FOCUSABLE`（不该抢焦点），但**输入框必须能聚焦才能打字、调键盘**。
所以回复条另开一个窗口：

```kotlin
val params = WindowManager.LayoutParams(
    MATCH_PARENT, WRAP_CONTENT, type,
    WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,   // 注意：不带 NOT_FOCUSABLE
    PixelFormat.TRANSLUCENT,
).apply {
    softInputMode = SOFT_INPUT_ADJUST_RESIZE or SOFT_INPUT_STATE_VISIBLE
}
```

另外：**底图 `ImageView` 不要挂 `setOnClickListener`**。可点击的 ImageView 会消费触摸事件，
父容器的拖动监听永远收不到 `DOWN/MOVE`，表现为「只能缩放、拖不动，一按还跳回 App」。

### 坑 12 · 颜色格式：`Color.parseColor` 不认 `#RRGGBBAA` ★

Android 的 `Color.parseColor` 只认 `#RRGGBB` 与 `#AARRGGBB`。
传 `#RRGGBBAA` 会**解析失败并整条回落默认色**——表现为「改了颜色却没反应」。

**约定**：颜色一律存 `#RRGGBB`，透明度单独一个 `0~1` 的字段，两边各自拼（原生 `Color.argb`，网页 `rgba()`）。

### 坑 13 · 通话中发消息被静默丢弃 ★★

**症状**：角色正在说话时从浮窗发消息，字收了、条也收起了，**消息哪儿都没去**。
而浮窗发送键又不判断通话状态，看起来一直可用，于是频繁「空发」。

**原因**：

```ts
if (callStateRef.current === "IDLE") runConversationTurn(text);  // 忙 = 直接丢
```

**修法**：改成**排队补发**，并且要让用户看得见：

- 忙时入队，回到 `IDLE` 自动发；
- 队列上限（比如 5 条），超出拒收并**保留输入内容**；
- 一次只补发一条（发出后状态转 `PROCESSING`，effect 重跑自然停手）；
- 挂断清空；
- 界面显示「对方说完就发 · 还有 N 条」，小窗挂角标。

### 坑 14 · 浮窗时长与网页计时对不上 ★

**原因**：浮窗是切到后台才建的，如果原生从 0 开始数，两边就是两套时间。

**修法**：

- 网页把**已通话秒数**一起传过去，原生记下基准点，之后按**墙钟**推算；
- 原生每秒推 `tick` 事件回网页做校准；
- **只前进不后退**（页面在后台被冻结时它报上来的值会停在旧值，无条件覆盖会把时长往回拽）；
- 浮窗上显示 `{{time}}` 占位，由**原生**替换——WebView 被冻结也不停。

### 坑 15 · 后台 WebView 定时器会被冻结 ★★

自动搭话靠 `setInterval` 心跳。App 退到后台后，这个定时器会被节流甚至冻结，
「挂着也一直聊」就失效了。

**修法**：心跳搬到原生（前台服务里的线程），每秒推 `tick` 事件驱动页面。

### 坑 16 · 视频通话/群聊要看齐语音的所有能力

原版只有语音通话有这个那个。补的时候容易漏：

- 视频、群聊也要有：小窗、原生浮窗、自动搭话、消息排队、配色主题；
- **群聊原版完全没有小窗实现**，props 都要新加；
- 三处通话屏的行为完全一样 → **抽成共享 hook**，别抄三份（抄了以后改一处忘两处）。

### 坑 17 · 自动搭话要防失控 ★★

「没人说话就让角色主动开口」很容易变成烧 token 机器。至少要：

- **随机间隔**（`[min, max]` 之间取值）——固定节拍像定时器，真人是忽快忽慢的；
- **条数上限**（本次通话最多 N 条，0 = 不限）；
- **空转退避**：角色这轮没说出内容，下次等待时长翻倍（最多 4 倍）；
- **用户一开口就清零**重算；
- **缩成小窗/切后台时的行为要明确**（这里选择了继续，因为用户要的就是「挂着也一直聊」）。

### 坑 18 · 首次接触 `SYSTEM_ALERT_WINDOW` 的常见误解

- 它属于**特殊权限**，`requestPermissions()` 弹不出窗，必须 `Settings.ACTION_MANAGE_OVERLAY_PERMISSION` 跳系统设置；
- 用户授权后，**已经运行的进程不会自动感知**——要在页面重新可见时重查一次（`visibilitychange` + 重新调 `canDrawOverlays`）；
- **不需要无障碍也能做浮窗**。无障碍在这里只用于「浮窗保活 + 前台 App 感知」，属于锦上添花，权限敏感度高，按需再加。

### 坑 19 · `versionCode` 必须严格递增 ★

否则 Android 拒绝覆盖安装，表现为「应用未安装」。改了壳就要动它。

### 坑 20 · debug 包要固定签名，否则每次重装丢数据 ★

壳内网页数据（聊天记录、角色）存在 App 自己的 WebView 沙箱里。
debug 包如果每次构建换签名，覆盖安装前必须卸载，**数据就没了**。
CI 里给 debug 也配一套固定签名可以避免。

---

## 六、建议的移植顺序

别一次全上。按这个顺序，每步都能单独验证：

1. **全局通话状态 + call-layer 挂载探针**
   先只加 `lib/call-session-store.ts`、`call-layer.tsx`，`desktop-shell` 挂上。
   **不改任何通话逻辑**——这一步的验证标准是「行为完全不变、页面不崩」。
   （改动模块加载图容易引发 TDZ 类问题，单独隔离出来。）

2. **通话逻辑全局化**
   聊天室删渲染、改走 `startCall()`；桌面壳监听 `chat-call-ended`。
   验证：切会话 / 回桌面 / 开别的 App，通话都不断。

3. **网页小窗（可拖动缩放）**
   验证：拖动、缩放、轻点回全屏、长按弹回复条。

4. **群聊小窗补齐**（原版没有）

5. **自动搭话**（三处共用 hook）

6. **原生壳浮窗**
   先做：权限 + 服务 + 浮窗出现 + 拖动缩放 + 点回全屏。
   再做：原生心跳 + 时长同步 + 语音在后台继续。
   最后：长按快捷回复。

7. **消息排队 + 配色自定义 + 诊断面板**

---

## 七、验收清单

**网页层**

- [ ] 通话中返回桌面 → 通话仍在
- [ ] 通话中切到别的 App（网页版）→ 回来看通话仍在小窗
- [ ] 通话中切到另一会话 → 通话仍在
- [ ] 小窗可拖动、可缩放，位置尺寸下次沿用
- [ ] 拖动后松手**不**跳回全屏；轻点**要**能回全屏
- [ ] 群聊语音 / 视频都能缩小、拖动、缩放、回全屏
- [ ] 自动搭话：静默到点角色主动开口**且有声音**
- [ ] **生成中途缩成小窗，那句话仍要播出来**
- [ ] 角色说话时发消息 → 显示「待发 N」→ 说完自动补发

**原生壳层**

- [ ] 浮窗权限未开时，界面有明确引导入口
- [ ] 通话中切到微信/别的 App → 原生浮窗可见
- [ ] 浮窗显示头像、名字、**时长（每秒跳动）**
- [ ] 浮窗可拖动、可缩放
- [ ] 轻点浮窗 → 回到小手机且通话恢复全屏
- [ ] 长按浮窗 → 回复条弹出、能打字、能发送
- [ ] 切出去期间角色仍会主动说话（原生心跳生效）
- [ ] 挂断后浮窗消失，不留悬空残留
- [ ] 诊断面板六项状态与实际相符

---

## 八、环境与依赖

- **网页层**：无新增依赖。用原生 `useSyncExternalStore` + `CustomEvent`。
- **原生壳**：无新增第三方库（浮窗用系统 `WindowManager`，网络用壳里已有的 OkHttp）。
- 壳的构建走仓库自带的 GitHub Actions（`Build Android Shell APK`），
  需要仓库变量 `SHELL_SITE_URL` 指向你的站点。
- **网页改动部署即生效**（Netlify/Vercel 重新部署）；
  **壳改动必须重新构建 APK 并覆盖安装**（记得递增 `versionCode`）。
- 浮窗权限与无障碍权限**都需要用户在系统设置里手动开启**，代码无法代劳。

---

## 九、一句话总结

> **通话状态提到常驻层（网页），浮窗显隐交给系统生命周期（原生），
> 头像这类大对象永远不要塞进 Intent，并且——一开始就把失败原因记下来。**
