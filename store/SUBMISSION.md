# Edge 商店提交材料

Partner Center 各字段的**可复制文案**。除特别说明外，均为中文（简繁同源，建议同时提交 zh-CN）。

提交入口：Partner Center → Edge → 创建新扩展

---

## 一、清单字段（来自 manifest.json，只读，改这里无效）

| 字段 | 当前值 | 限制 | 状态 |
|---|---|---|---|
| Name | 音画偏移 · 标签页音频 | ≤45 字符 | 14 字符，通过 |
| Description | 接管当前标签页的音频输出做实时延迟，修正音画不同步。页面播放器、进度条、画质切换全部不动。 | ≤132 字符 | 49 字符，通过 |
| Version | 1.0.0 | `x.y.z` | 通过 |

> 这两项在 `manifest.json` 里，**上传后不可在 Partner Center 修改**。要改必须重打 zip 重新上传。所以文案务必先定稿。

---

## 二、Properties（属性）

### Category（分类）

首选 **Tools（工具）**；备选 **Productivity（效率）**。

> 不要选 Entertainment——娱乐类审核会问"是否涉及内容分发/版权"，解释成本高。

### Search terms（搜索词，最多 7 个，逗号分隔）

```
音画不同步, 音频延迟, 口型对不上, 蓝牙耳机延迟, 视频同步, audio delay, lip sync
```

> 政策 1.1.4：不得超过 7 个，且必须与功能相关。不要塞无关热词（例如"下载""视频网站名"），会被直接驳回。

### 语言

至少 **简体中文**。若也想让海外用户搜到，加 **English** 一份 listing（描述可用下面第三节的英文版）。

---

## 三、Store listing（商店详情，每个语言一份）

### 简短描述（≤ 200 字符，显示在搜索结果里）

```
把当前标签页的声音推迟一点，让口型和声音对上。拖动即时生效，页面播放器完全不动。
```

### 详细描述

```markdown
## 它是做什么的

有些时候，画面和声音就是对不上——蓝牙耳机慢半拍、投屏后口型飘、录屏回放声音提前。

这个小工具只做一件事：**把当前标签页听到的声音，按你设定的毫秒数往后推一点**，让声音追上画面。

拖动滑块，声音立刻变化，不用刷新、不用重新加载、不用等缓冲。

## 为什么用它可以，别的方案不行

普通的前端脚本改不了这件事，因为浏览器不允许页面上下文直接接管标签页音频。
本扩展使用的是浏览器原生的 `tabCapture` 接口，抓取的是**浏览器渲染完成之后的最终混音**。

这意味着：

- 不受网站 CORS 限制，任何视频站、任何播放器都能用
- 不影响页面自己的播放器：进度条、画质切换、字幕、倍速全部照常
- 不需要破解、不需要下载、不需要解析视频地址

## 怎么用

1. 打开视频页面，**先让视频播放起来**（没有声音时无法捕获）
2. 点一下浏览器工具栏上的扩展图标——声音立刻被接管，页面右下角出现面板
3. 拖动滑块，直到口型和声音对上

再点一次图标就是停止，声音立刻回到页面本身。面板上也有「停止」按钮。

## 快捷键

滚轮停在面板上直接滚，一格 100 毫秒，`Shift` 一格 1 秒，向上为增加。滚轮只作用于面板，不会滚动页面。

鼠标悬停在面板上时：

- `←` / `→` — 减 / 加 100 毫秒
- `Shift + ←` / `Shift + →` — 减 / 加 1 秒
- `Home` — 归零

只在悬停时生效，不会和播放器自己的方向键（快进快退）打架。

## 几点必须提前说清楚的限制

- **默认模式只能延后。** 实时音频流里没有"未来"的样本，物理上做不到让声音提前。如果页面用的是 MSE 播放器（`video.src` 是 `blob:`），可以切到可选的「双向模式」：复用页面已经下载的音频片段，这时才能提前。原生 HLS（地址直接是 `.m3u8`）由浏览器内部解码，扩展拿不到数据，面板会直接写明不支持，不会假装可用。
- **捕获的是整个标签页。** 页面里的广告声、提示音会一起被延迟。只挑视频音轨做不到——那需要接管播放器本身。
- **接管期间，页面自己的音量条看起来正常但没有声音。** 这是浏览器的强制行为（捕获后标签页静音），不是 bug。声音从扩展这条链路出来。
- **一次只能接管一个标签页。**
- **不适用于浏览器内部页面**（设置页、扩展商店、PDF 阅读器）。
- **需要支持 `tabCapture` 的浏览器**（Chromium 内核）。

## 隐私

不收集、不上传任何数据。音频只在你的电脑内存里停留你设定的延迟时长，然后送到扬声器，不落盘、不传输。

## 开源与反馈

遇到问题请通过「支持」链接反馈，附上浏览器版本和出问题的网站（如果方便的话）。
```

### 英文版（可选，用于多语言 listing）

```markdown
## What it does

Sometimes the picture and the sound just don't line up — Bluetooth headphones run half a beat late, casting drifts, screen recordings come out with audio ahead.

This tool does exactly one thing: **it delays the audio of the current tab by the number of milliseconds you choose**, so the sound catches up with the picture.

Drag the slider and the audio changes immediately. No reload, no re-buffer.

## Why an extension, not a userscript

Page-context scripts cannot touch tab audio — the browser does not allow it.
This extension uses the native `tabCapture` API, which grabs the **final mix after the browser has rendered it**.

That means:

- No CORS problems. Works on any video site, any player.
- The page's own player is untouched: progress bar, quality switching, subtitles, playback speed.
- No cracking, no downloading, no parsing of video URLs.

## How to use

1. Open a video page and **let it start playing** (capture fails on silence)
2. Click the extension icon in the toolbar once — audio is taken over and a panel appears in the bottom-right corner
3. Drag the slider until lip sync matches

Click the icon again to stop; audio returns to the page instantly. The panel also has a stop button, and it keeps working in fullscreen.

## Keyboard and mouse wheel

Scroll while the pointer is over the panel: one notch is 100 ms, `Shift` makes it 1 s, scrolling up increases the value. The wheel is scoped to the panel and never scrolls the page.

While hovering over the panel: `←` / `→` for 100 ms, `Shift + ←/→` for 1 s, `Home` to reset. Only active on hover, so it never fights the player's own arrow-key seeking.

## Known limitations

- **Delay only in the default mode.** Tab audio is captured after mixing, so there are no future samples to pull forward — advancing audio in real time is impossible on that path. On pages that use Media Source Extensions, the optional bidirectional mode reuses the audio segments the page already downloaded and can therefore advance it. It is unavailable on native HLS (where `video.src` is an `.m3u8` URL and the browser demuxes internally), and the panel says so instead of pretending otherwise.
- **The whole tab is captured.** Ads and notification sounds on the page get delayed too.
- **The page's own volume slider looks normal but is silent while captured.** This is browser-enforced behavior, not a bug.
- **One tab at a time.**
- **Does not work on internal browser pages** (settings, extension store, PDF viewer).

## Privacy

No data collected, no data uploaded. Audio lives in memory for the delay duration you set, then goes to your speakers — never written to disk, never transmitted.
```

### Screenshots（截图）

| 文件 | 尺寸 | 用途 |
|---|---|---|
| `store/screenshot-1-scene.png` | 1280×800 | 使用场景：播放器 + 右下角面板 |
| `store/screenshot-2-panel.png` | 1280×800 | 面板特写 + 各控件标注 |

> 商店要求至少 1 张，最多 6 张，推荐 1280×800 或 640×400。
> 政策 1.1.2：截图必须「清晰、信息量大、渲染正确，不得拉伸或模糊」。
> **这两张是按 content.js 真实配色与布局重绘的示意图**（`tools/make-store-assets.py` 生成），不是真实抓屏。文案与 UI 一致，功能一致，符合要求。如果希望更真实，可以补一张真机截图作为第三张。

### Promotional images（推广图）

| 文件 | 尺寸 | 是否必需 |
|---|---|---|
| `store/promo-large-640x400.png` | 640×400 | 建议提供 |
| `store/promo-small-440x280.png` | 440×280 | 可选 |

### Logo

`store/logo-300.png`（300×300，透明圆角）

> manifest 里的 128px 图标也会被自动取用；300px 的用于详情页大图位。

---

## 四、Privacy（隐私）

### Single purpose（单一用途）

```
把当前标签页的音频延迟（或提前）一个用户设定的时长，用于修正视频音画不同步。
```

> 两个模式（默认的 tabCapture 延迟、可选的双向偏移）服务于同一个用途：调整当前标签页的音画相对时序。不是两个功能。

### Permission justification（逐条权限理由）

按 Partner Center 的输入框逐条粘贴：

**tabCapture**

```
Core functionality. getMediaStreamId() is the only API that can capture a tab's audio output. Without this permission the extension cannot perform its single stated purpose. It is invoked only from the toolbar icon click handler (chrome.action.onClicked), which is a user gesture — capture never starts on its own.
```

**offscreen**

```
MV3 service workers cannot instantiate Web Audio (AudioContext is unavailable in a service worker). The offscreen document hosts the MediaStreamAudioSourceNode → DelayNode → destination graph. The document is created on demand when capture starts and destroyed immediately when capture stops; it is not kept alive.
```

**storage**

```
Persists one value in chrome.storage.local: the last delay value the user selected (integer milliseconds, 0–10000). Used only to restore the slider position the next time capture starts. No user identifiers, no telemetry, nothing leaves the device.
```

**activeTab**

```
Grants temporary host access to the current tab only at the moment the user clicks the extension icon. This is the permission that makes getMediaStreamId() legitimate for that specific tab. The extension deliberately does NOT request "tabs" or any host_permissions, so it cannot read page content or URLs at any other time.
```

**scripting**

```
Injects a single content script into the tab the user already granted via activeTab: a floating panel with an <input type="range"> so the delay can be adjusted during fullscreen video, plus a small banner that explains capture failures (for example "this tab is not playing audio"). Injection failure is caught and ignored — the toolbar icon shows a red badge instead, and the audio pipeline is never affected. No page data is read.
```

**optional_host_permissions (`*://*/*`)**

```
OPTIONAL — never granted at install. After installation the extension shows "no website access" and works on any site using only activeTab.

This permission backs the optional bidirectional mode, and is requested per-origin only after two explicit user actions: clicking the "启用双向" (enable bidirectional) button on the panel, then clicking the extension's toolbar icon, which is what actually triggers the browser permission prompt. Chromium requires chrome.permissions.request to be called from a real user gesture; a click inside a web page does not survive the message hop to the extension's service worker, so the toolbar icon is the only reliable entry point. After granting, the user reloads the page once. Its sole purpose is to register a document_start script on that one site, which copies audio segments that the page's own player has ALREADY downloaded (the page uses Media Source Extensions, so segments pass through SourceBuffer.appendBuffer).

Why it is technically required: MediaSource.appendBuffer runs at document_start, before the extension can be invoked by a user gesture. Without a pre-registered script the very first segment is missed and the audio track can never be initialised.

No page content is read, no request is made, nothing is transmitted. The copied bytes stay in memory and are fed to a local MediaSource belonging to the extension. If the user never uses the bidirectional mode, no host permission is ever granted.
```

### Remote code（是否使用远程代码）

选 **No**。

理由（如需要填写）：

```
All code is bundled in the package. The extension makes zero network requests — no CDN, no fonts, no analytics, no remote scripts. It works fully offline.
```

### Data usage（数据使用声明）

全部勾 **不收集**。特别是以下几项要明确不勾：

- Personally identifiable information
- Health information
- Financial and payment information
- Authentication information
- Personal communications
- Location
- Web history
- User activity
- Website content

> 本扩展确实处理音频流，但音频**不离开设备、不落盘、不传输**，因此不属于"收集"。

### Privacy policy URL

填 `store/privacy-policy.md` 部署后的公网地址。

> 政策 1.5.2 要求有隐私政策。即使不收集数据，也建议提供——没有这一项在审核里是常见扣分点。部署方式见该文件末尾说明。

---

## 五、Certification notes（给审核员的测试说明）

这一栏**极其重要**。审核员很可能第一遍就失败，然后直接判「功能不可用」驳回。

```
=== IMPORTANT: this extension cannot be tested without playing audio first ===

The extension captures tab audio via chrome.tabCapture.getMediaStreamId(). Per
Chromium's activeTab design, that call only succeeds if the extension was invoked
by a real user gesture on that specific tab. It also requires the tab to have an
active audio stream, otherwise capture returns NotAllowedError.

There is no popup. Clicking the toolbar icon IS the action — no dialog opens,
the capture starts immediately.

TEST STEPS (please follow in order):

1. Open https://www.youtube.com/watch?v=aqz-KE-bpKQ  (Big Buck Bunny, public domain,
   no login required) — or any page that plays audio.
2. Click PLAY. Confirm you can hear sound through your speakers/headphones.
   >>> Do not skip this. With a paused tab, capture is expected to fail. <<<
3. While the video is still playing, click the extension's toolbar icon ONCE.
4. Expected result within ~1 second:
   - A floating panel appears in the bottom-right corner of the page
   - The panel shows a cyan number (seconds) and a slider
   - A green level meter inside the panel starts moving with the sound
5. Drag the slider to the right. Expected: you hear the audio shift later by the
   amount shown. The video itself keeps playing normally; its own progress bar,
   quality menu and subtitles are unaffected.
6. Click the toolbar icon again, or the red "停止" (Stop) button on the panel.
   Expected: audio returns to the page immediately.

IF NOTHING HAPPENS:

- A red banner appears at the top of the page explaining the failure. The most
  common cause is a tab that is not currently playing audio.
- On pages where script injection is blocked (chrome:// pages, the extension
  store, PDF viewer), the toolbar icon briefly shows a red "!" badge instead.
  Capture is blocked by Chromium on those pages anyway.

NOTES FOR THE REVIEWER:

- While captured, the page's own volume control appears normal but is silent.
  This is browser-enforced tab muting during tabCapture, not a defect. Audio is
  coming out through the extension's audio graph instead.
- No login, no account, no payment, no network access is required or performed.
- There is exactly one purpose and one control surface: a delay slider.
```

> 如果审核员所在地区的 YouTube 不可访问，**换一个你自建的公网测试页**（一个 `<video>` 标签 + 一个公开可用的 MP4 即可），把 URL 写进说明。这比让审核员自己找视频稳妥得多。

---

## 六、Availability（可用性）

- **Markets**：全选（含中国区）
- **Visibility**：Public

> 如果想先小范围验证，可以先选 **Hidden**（仅持链接者可安装），确认无崩溃后再切 Public。这条路径对手上有真实用户反馈渠道的人很划算。

---

## 七、提交前自检清单

- [ ] `manifest.json` 无 `update_url`
- [ ] name / description 里没有 "Chrome"、"Firefox"、"Edge 浏览器"等字样（`tools/package.js` 会自动校验）
- [ ] 四档图标齐全：16 / 32 / 48 / 128
- [ ] `node tools/package.js` 通过，产出 `dist/audio-delay-sync-1.0.0.zip`
- [ ] **在真实 Edge 里完整跑通一次**：播放 → 点图标 → 接管 → 调延迟 → 停止
- [ ] 截图 / 推广图 / logo 齐全
- [ ] 隐私政策已部署，URL 可访问
- [ ] 5 项权限理由逐条填写
- [ ] Certification notes 已填写，且明确写了「必须先播放音频」
- [ ] 搜索词 ≤ 7 个

---

## 八、审核可能被打回的点（预判）

| 风险 | 触发条件 | 应对 |
|---|---|---|
| **功能不可用** | 审核员在静音标签页上点接管，捕获失败 | certification notes 里写死「先播放」，并提供自建测试页 URL |
| **权限过度** | 5 项权限里有解释不清的 | 已逐条填写；`package.js` 也会校验权限与代码的对应关系 |
| **描述不实** | 描述里出现「支持所有网站」「可调负延迟」之类 | 已在详情里明确写出「只能延后」「浏览器内部页不支持」 |
| **截图不清** | 截图模糊、拉伸 | 尺寸严格 1280×800，非拉伸 |
| **非生产构建** | 描述/说明里出现 "beta"、"experimental"、"测试中" | 文案里一个都别出现 |
| **搜索词超限** | 超过 7 个 | 已控制在 7 个 |
| **隐私政策缺失** | 未填 URL | 必须部署 |
