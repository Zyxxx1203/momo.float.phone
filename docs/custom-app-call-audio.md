# 自定义 APP 接入「通话语音留档」开发要点

> **面向**：给 AI 虚拟手机写自定义 APP 的人（和他的 AI）。
> **目标**：让你的 APP 能**复听通话当时的原音**，而不是每次重新合成。
> **前提**：站点部署了「通话语音留档」改动（见 `docs/call-feature-updates.md`）。
> 没部署也能跑——会自动降级为重新合成，见 §五。

---

## 一、这份能力解决什么

通话里角色的每句话都是 TTS 现场合成的。早期实现合成完就丢（只放内存 Map，挂断即失），
所以「通话结束后想复听当时那句」只有一条路：**重新合成**——音色、语速、情绪每次都可能不同，
还重复消耗语音额度。

留档改动把合成结果落进媒体库，并把一个引用写进那条消息的 `mediaData`。
自定义 APP 读到引用后，可以**直接播放当时的原音**。

```
通话屏 TTS 合成 → 落媒体库（storeMediaBlob）→ media-store:// 引用
                                   ↓
                    写进消息 mediaData.callAudioRef
                                   ↓
              APP: chat.readHistory 读到引用 → voice.play 直接播
```

**宿主 API 零改动**——这是设计时就打通的两条既有通道：
`serializeChatMessage` 整包透传 `mediaData`；`voice.play` 本就支持 `media-store://` 引用。

---

## 二、数据长什么样

`AiPhone.chat.readHistory({ characterId, limit, before })` 返回里，通话消息带 `origin: "call"`，
`mediaData` 上可能有这些字段：

| 字段 | 含义 |
|---|---|
| `callAudioRef` | **原音留档引用**（`media-store://…`）。有它就能放原音 |
| `callDuration` | 通话时长文本（如 `"12:03"`），挂在挂断留痕那条上 |
| `callStartMarker` | 用户手动标的「通话开头」（布尔） |
| `callEndMarker` | 用户手动标的「通话结尾」（布尔） |

一条带留档的通话消息大概长这样：

```js
{
  id: "msg_...",
  role: "assistant",
  content: "宝宝，你这是……",
  origin: "call",
  createdAt: "2026-10-09T04:39:12.000Z",
  mediaData: {
    callAudioRef: "media-store://mc_1759..."
  }
}
```

**三点注意**：

1. `callAudioRef` 只挂在**有台词**的消息上。贴纸、红包这类没有朗读内容的消息不挂。
2. 老通话（留档功能上线前打的）**永远没有这个字段**——这是数据本身的限制，不是 bug。
3. 留档会被**自动清理**（默认保留最近 30 天 / 400 段），所以昨天有、今天可能就没了。

---

## 三、怎么播（核心代码）

```js
// 1. 读聊天历史
const res = await AiPhone.chat.readHistory({ characterId, limit: 200 });
const messages = res.messages || [];

// 2. 找出有留档的通话消息
const withAudio = messages.filter(m =>
  m.origin === "call" &&
  m.mediaData &&
  typeof m.mediaData.callAudioRef === "string"
);

// 3. 播放：把引用直接交给宿主代播
await AiPhone.voice.play({ dataUrl: withAudio[0].mediaData.callAudioRef });
// 播完才 resolve；期间可以显示「播放中」
```

**四个要点**：

- **直接传引用，不要先转 dataURL。** `voice.play` 内部会自己 `loadMediaBlob` 转 objectURL，
  音频数据**不经过沙盒通信桥**——这是大文件不卡的关键。
- **必须用 `voice.play`（宿主代播），不要自己建 `<audio>`。** APP 跑在沙盒 iframe（空源）里，
  自建 `<audio>` 会让 iOS 锁屏媒体卡片绑到打不开的空白地址（用户一点整个应用白屏）；
  Web Audio 又会被 iOS 静音拨键整个静音。宿主代播没这两个坑。
- **`voice.play` 播完才 resolve**，可以直接 `await` 来驱动播放态。
- **停止播放**用 `AiPhone.voice.stopPlayback({})`。两个通道：`voice`（默认）/ `ambience`。

---

## 四、权限

| 权限 | 干什么 | 何时需要 |
|---|---|---|
| `chat.read` | 读聊天历史（拿 `callAudioRef`） | 必填 |
| `voice.tts` | 语音合成，以及**宿主代播**（`voice.play` 走这个权限） | 必填 |
| `characters.read` | 拿角色名 / 头像 | 按需 |

装 APP 时用户会看到「调用语音合成（消耗你的语音额度）」。**播放已有原音其实不消耗额度**
（不走 TTS API），但这条权限是宿主代播的入口，没有更细的粒度——
建议在 APP 里说明一句，避免用户疑惑「一个统计 APP 为什么要语音权限」。

---

## 五、对方没部署留档改动怎么办（分享前必读）

如果你要把 APP 分享给别人，对方的站点**很可能没部署留档改动**。
这时 `callAudioRef` 永远是 undefined，**不能让 APP 报错或空白**。

**降级路径**：没有留档 → 用 `voice.tts` 现场重新合成。

```js
async function replay(message, characterId) {
  const ref = message.mediaData && message.mediaData.callAudioRef;
  if (ref) {
    await AiPhone.voice.play({ dataUrl: ref });   // 放原音
    return { mode: "origin" };
  }
  const text = String(message.content || "").trim();
  if (!text) return { mode: "none" };
  const speech = await AiPhone.voice.tts({ characterId, text });
  if (!speech || !speech.dataUrl) return { mode: "failed" };
  await AiPhone.voice.play({ dataUrl: speech.dataUrl });
  return { mode: "synthesized" };
}
```

**文案要中性。** 别写「旧版本打的电话」——对没部署的站点，用户每一条都是这个状态，
那句话会让人以为自己数据坏了。改成类似：

> 复听会优先播放通话当时的原音；当前站点未启用语音留档，将按原句重新合成。

**建议**：给这两种状态一个可见的小区分（比如播放按钮换个样式 / 气泡上标「原音」），
让用户知道差别在哪。

---

## 六、踩过的坑

### 坑 1 · 沙盒 iframe 里 `localStorage` 用不了 ★★

APP 跑在**空源**的 sandbox iframe 里（宿主故意不给 same-origin，否则别人的 APP 就能读你
整个小手机的数据）。这种不透明源下，浏览器**直接拒绝访问 `localStorage`**，抛 `SecurityError`。

危险的是：如果按常规写法包了 `try/catch`——

```js
// 静默失败：不报错，但也从没存进去过
try { localStorage.setItem(k, v) } catch (e) {}
```

它**没有任何错误信息**，表现只是「每次进 APP 设置都丢」。真实案例：一个 APP 的主题色
每次都要重选，根因就是这行。

**正确做法**：APP 的设置一律存**宿主私有数据库**。

```js
// 存
await AiPhone.db.create("app_settings", {
  key: "theme", mode: "morandi", updatedAt: new Date().toISOString()
});

// 读
const rows = await AiPhone.db.list("app_settings", { limit: 20 });
const found = rows.find(r => r.key === "theme");

// 改（没有 upsert：先找到记录 id，再 update）
await AiPhone.db.update("app_settings", found.id, { mode: "macaron" });
```

需要 `app.data.read` / `app.data.write`。

### 坑 2 · 别把音频转成 base64 存进 db ★★

`callAudioRef` 是个**引用**（几十字节），不是音频本体。
自己实现时也别把音频 dataURL 塞进 `db.create`——db 记录是整体序列化的文本，
几 MB 的 base64 会让之后每次读写都重新序列化一遍，卡、费内存，iOS 上可能直接崩。

要存大文件，用 `AiPhone.media.put({ dataUrl })` 换 `media-store://` 引用，
db 里只存引用字符串（见官方 SDK 文档「媒体库：大文件的正确存法」）。

### 坑 3 · 富媒体消息没有可朗读内容 ★

`content` 是 `[图片] xxx`、`[表情] xxx` 这类占位文本的消息，即使有引用也别念。
播放前先剥掉占位前缀，空了就跳过。

```js
const text = String(m.content || "").replace(/^\[(图片|表情|红包|转账|语音)\]\s*/, "").trim();
if (!text) return;   // 没有可朗读的文字
```

### 坑 4 · 留档会被自动清理 ★

留档有保留策略（默认最近 30 天 / 最多 400 段，超出从最旧清）。
所以一条消息**曾经有** `callAudioRef`，过一阵可能就没了。

**不要在本地缓存「这条有原音」这个判断**——每次都从当前读到的消息里现取。
播放失败（引用已失效）时也要能**回退重新合成**，别只弹个错误。

---

## 七、验收清单

- [ ] 部署了留档改动的站点：新打通话 → APP 里能放**原音**（音色与通话时一致）
- [ ] 没部署的站点：**不报错**，退回重新合成，提示文案中性
- [ ] 老通话（无留档）：同样不报错、能回退
- [ ] 播放中点第二次能停止；切走页面能停
- [ ] 留档被清理后，播放失败能回退而不是卡住
- [ ] iOS 上播放正常，点锁屏媒体卡片不会白屏
- [ ] APP 的设置（主题等）退出重进还在（证明没用 `localStorage`）

---

## 八、参考

- 留档功能的宿主侧实现与全部推导：`docs/call-feature-updates.md` §二、
  `docs/call-feature-porting-guide.md` 坑 22
- 官方 SDK 文档：语音能力（`voice.play` / `voice.tts` / `voice.readProfiles`）、
  媒体库（`media.put` / `get` / `delete`）、聊天历史（`chat.readHistory`）
- 一个真实用例：「通话统计」APP 的复听实现（优先原音、无则重合成）
