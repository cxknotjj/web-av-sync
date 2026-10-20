# 开发与实现说明

面向维护者，用户文档见 [README.md](README.md)。

这里放的是「为什么这么写」：实现原理、双向模式的三种取数链路、实测数据、
文件结构、开发环境、发布流程，以及各种只在调试时才需要知道的细节。
第一次接触这个项目请先读 README。

## 目录

- **原理** —— 声音是怎么被延迟的，为什么接管期间页面会静音
- **双向模式** —— 为什么默认只能延后，怎么拿到"未来"的音频
- **三条链路** —— 各自的前提、代价、完整对照
- **链路②** —— 为什么只能用 debugger 读 ts，为什么不用 hook fetch
- **实测数据** —— 各链路的真实数字
- **文件** —— 每个文件负责什么
- **开发** —— 本机怎么跑起来、本地测试台的两个坑
- **发布** —— Edge 商店提交流程
- **调试** —— 双向模式没按预期走链路时按什么顺序查

---

## 原理

```
tabCapture  ──→  MediaStreamSource  ──→  DelayNode  ──→  destination
      │                                      │
   标签页最终混音                       └──→  Analyser（只测电平）
```

就三个节点。`delayTime` 改多少，声音就晚多少。

### 捕获期间标签页会静音

这是 Chrome 的强制行为，不是 bug：

> 当为某个标签页获取 MediaStream 时，该标签页中的音频将不再播放给用户。

所以扩展必须把音频接回 `destination`，否则就是彻底没声音。**这条链路是用户唯一的出声通道**，代码里任何一步失败都会回滚并交还原音频。

好处是不会出现"原声 + 处理后"两遍重声。

***

## 双向模式（声音提前）

默认链路走 `tabCapture`，抓的是播放输出，而输出里没有「未来」的样本，所以只能延后。

双向模式换了一条取数路径：**复用页面自己下载的 MSE 音频片段**。页面用 `hls.js` / `dash.js` 播放时，音视频片段必须经过 `SourceBuffer.appendBuffer`，在那里截一份出来，就能拿到「比当前播放位置更靠后」的数据 —— 有了未来数据，就可以提前。

```
页面 appendBuffer ──┬─→ 页面自己的 SourceBuffer（照常播）
                    └─→ 复制一份给扩展 → 只含音频的 MediaSource → <audio>
```

那条 `<audio>` 有自己的时钟，`currentTime` 设到画面位置之后就是「声音提前」。

### 怎么启用

1. 先把视频播起来
2. 点图标接管，面板右下角会显示「双向需授权」
3. 点它，浏览器弹出授权框，点「允许」
4. 扩展会自动刷新页面，面板上出现「启用双向」，点一下切过去

第 3 步能一次点完，靠的是**手势能撑过 content script → service worker 这一跳**。但前提是 service worker 里 `chrome.permissions.request` 之前不能有任何 `await` —— 哪怕只是先查一下有没有授权，手势也会失效，报 `This function must be called during a user gesture`。

第 4 步的刷新是自动的：脚本必须在 `document_start` 注入，而 `init segment`（定义音频编码参数的那段）只在播放器初始化时 append 一次，所以授权后不刷新等于没装。

**如果面板显示「刷新页面生效」而不是「双向需授权」**，说明站点早就授权了，只是当前页面加载时脚本还没注册上。点一下按钮就会补注册并自动刷新，不会再弹授权框——`permissions.request` 即使权限已存在也要求手势，这种情况走的是另一条不需要手势的通道。

### 三条链路（按代价从低到高）

点「启用双向」时不是只有一条路可走。代码按下面的顺序试，能省则省：

| 顺序 | 链路 | 数据从哪来 | 额外带宽 | 代价 |
| --- | --- | --- | --- | --- |
| ① | **MSE 复用** | 被 hook 到的 `appendBuffer` 音频片段 | **零** | 要站点授权 + `document_start` 注入 |
| ② | **调试协议抓切片** | `chrome.debugger` + `Network.getResponseBody` 取回播放器**已经下载过**的 ts | **零** | 页面顶部出现「正在调试」黄条，每片一次 RPC |
| ③ | **再拉一路** | `<audio src="同一路流">`，浏览器重新解码 | **双倍** | 无 |

①和②都拿不到时才落到③。②失败（抓不到切片、调试器被占用）会自动降到③，用户不需要自己选。

### 面板上看得见走的是哪条

模式标签下面多了一条链路指示条，点之前就能看到**将要**走哪条，点之后能看到**实际**走哪条：

| 状态 | 样式 | 文案 |
| --- | --- | --- |
| 还没启用 | 虚线灰 | `② 将用 抓取已下载切片　零流量` |
| 链路已选定、还在等数据 | 虚线 | `② 抓取已下载切片　连接中…` |
| 已经在出声 | 实线青 | `② 抓取已下载切片　零流量 · 可提前 15.2s` |

右侧那个「可提前 N 秒」是实时算的：

```js
ahead = enhAudio.buffered.end(末尾) - video.currentTime
```

也就是音频最多还能往前推多少。它只跟「已经下到哪」有关，所以用户能直接看出为什么有时只能提前两三秒——缓冲就那么多，不是代码偷懒。

降级也是可见的：② 抓不到切片时，指示条会从 `②` 变成 `③ 重新拉一路　约双倍流量`，不会让用户以为还在走省流量那条。

**走 ③ 的时候会说明原因。** 指示条的悬停提示里带着 `routeWhy`，只有两种取值：

- `页面是直连媒体（.mp4 / 非 m3u8），没有切片可抓` —— 这条链路本来就不存在，不是失败
- `抓切片失败（调试器被占用，或页面上没有新的切片请求），已自动降级` —— 失败降级

降级那一刻还会弹一次提示，因为这时候用户的流量会翻倍，不能只写在悬停里让人自己发现。

三条链路的编号、名称、代价写在 `ads-enhance.js` 顶部的 `ROUTES` 表里，加链路只要往表里添一条；而「这次会走哪条」由 `pickRoute()` 统一判断，UI 预告和真正分派共用它，避免出现「预告说走①、实际跑③」。

### 限制

| 限制              | 说明                                                                                                               |
| --------------- | ---------------------------------------------------------------------------------------------------------------- |
| 三条链路各有前提        | **MSE 播放器**（`blob:`）走①，零额外带宽但要授权 + 刷新；**原生 HLS**（`.m3u8`）优先走②，抓不到再退③；**直连 mp4** 只能走③  |
| 能提前多少取决于缓冲      | 只能提前到「已经下载到」的位置，超出会卡住等数据                                                                                         |
| 误差几十毫秒          | 每 250ms 校正一次，偏差超过 40ms 才动，实测落在 20\~70ms                                                                          |
| 和 tabCapture 互斥 | 进入双向模式会停掉捕获链路，主视频转为静音                                                                                            |

### 链路②：调试协议抓切片（原生 HLS）

原生 HLS 由浏览器内置 demuxer 处理，ts 字节全程不经过 JS——没有 `MediaSource`、没有 `appendBuffer`，hook 无处可挂。但调试协议能看到这批字节：

```js
chrome.debugger.attach({ tabId }, '1.3');
chrome.debugger.sendCommand({ tabId }, 'Network.enable', { ... });

// 切片 loadingFinished 之后才能取
const r = await chrome.debugger.sendCommand({ tabId }, 'Network.getResponseBody', { requestId });
// r.body 是 base64，转成 Uint8Array 后交给 mux.js
```

拿到字节后还要转一次格式：**ts 不能直接喂 MSE**（`addSourceBuffer('audio/mp2t')` 实测抛 `NotSupportedError`），得用 `mux.js` demux 成 fMP4：

```js
const t = new muxjs.mp4.Transmuxer({ keepOriginalTimestamps: true, remux: false });
t.on('data', (seg) => {
  if (seg.type !== 'audio') return;   // remux:false 才会把音频单独吐出来
  // initSegment 只 append 第一次，data 每片都 append
});
```

几个实测踩到的点：

- **必须等 `loadingFinished`**：还在流式传输时取会报 `No data found for resource with given identifier`
- **`remux: false`**：默认输出 `combined` 段，含 `avc1` 视频轨，`audio/mp4` 的 SourceBuffer 会直接拒收
- **init segment 只 append 一次**：重复 append 会让 SourceBuffer 报错
- **CDP 的 `frameId` 不能直接给 `chrome.tabs.sendMessage`**：前者是字符串，后者要数字，得用 content 自己报上来的 `sender.frameId`
- **match pattern 里不能写端口**：`http://127.0.0.1:8124/*` 这种写法整条规则会失效，要写成 `http://127.0.0.1/*`（不带端口反而匹配所有端口）

#### 为什么不 hook `fetch` / `XMLHttpRequest`

很多站点（hls.js、shaka）确实是用 XHR / fetch 下载 ts 的，理论上在那儿劫持也能拿到字节。实际不这么做，是因为不划算——不是做不到。

先摆两个实测事实（本地 hls.js + 单切片 ts）：

```
addSourceBuffer 调用: ["audio/mp4;codecs=mp4a.40.5", "video/mp4;codecs=avc1.42c00d"]
主线程看得到:        ["XHR:playlist-one.m3u8", "XHR:seq1.ts"]     ← worker 开/关都一样
```

1. **hls.js 会把音视频拆成两个 SourceBuffer**，`audio/` 那条正好能被 `inject-main.js` 的 `^audio\//` 命中——链路①成立的前提就在这里。自研播放器如果合成单一 `video/mp4`，那条链路①就截不到。
2. **hls.js 的 Web Worker 只做 transmux，下载仍在主线程**（xhr-loader），所以主线程 hook XHR 确实能看到切片请求。也就是说 hook fetch/XHR 技术上可行。

不选它的三条理由，按分量排：

| 理由 | 说明 |
| --- | --- |
| **覆盖面** | `appendBuffer` 是所有 MSE 播放器的必经点。fetch/XHR 只是实现细节：hls.js 用 XHR、shaka 用 fetch、还有流式读 `Response.body` 自己拼包的。hook 一套只覆盖一部分站点 |
| **加密流拿不到明文** | hls.js 的 AES-128 解密发生在 loader **之后**，hook XHR 截到的是**密文**，还得自己实现解密和 IV/key 推导 |
| **格式还要再转一手** | `appendBuffer` 给的是已经 remux 完、且已分轨的 fMP4，直接能喂 MSE；ts 还得引 mux.js demux |

一句话：**在数据最"熟"的地方截，而不是最早的地方。**

另外 `audioMime` 不是硬编码的，是从 `addSourceBuffer(mime)` 的实参读出来的（实测常见值是 `mp4a.40.5`，不是默认的 `mp4a.40.2`），自建 SourceBuffer 复用同一个字符串，编码参数天然一致。

### 链路③：直连媒体再拉一路（原生 HLS / mp4）

`video.src` 直接是 `.m3u8` 或 `.mp4` 时，数据在浏览器媒体栈里，`appendBuffer` 不会被调用，MSE 路线无从复用。这条路线换成**自己再拉一路**：

```
主 video（页面原有）  muted = true    ← 画面照常
<audio src="同一路流">               ← 浏览器直接解码，独立时钟
audio.currentTime = video.currentTime − currentMs/1000
```

关键事实（均已实测）：

- **媒体元素加载不受 CORS 约束**——`<audio src>` 不需要站点授权、不需要 `host_permissions`，任何直连流都能播
- `audio.currentTime` 可以任意 seek，Chrome 会自己发 Range 请求加载目标位置
- **ts 切片不能直接喂 MSE**：`MediaSource.isTypeSupported('video/mp2t')` 虽然返回 true，但 `addSourceBuffer('video/mp2t')` 实测抛 `NotSupportedError`——`isTypeSupported` 会撒谎，必须以实际 append 为准
- 代价：同一路流下载和解码各跑两遍

### 三条链路的完整对照

| | ① MSE 复用（`blob:`） | ② 调试协议抓切片（`.m3u8`） | ③ 直连再拉一路（`.m3u8` / `.mp4`） |
|---|---|---|---|
| 触发条件 | 页面用 hls.js / dash.js 等 MSE 播放器 | `video.currentSrc` 是 `.m3u8` 且 mux.js 可用 | ①②都不成立 |
| 数据来源 | `addSourceBuffer` 处截获的 fMP4 片段 | 调试协议取回播放器已下载的 ts，mux.js 转 fMP4 | 浏览器对同一 URL 再解码一遍 |
| 额外带宽 | **零** | **零** | **双倍** |
| 需要的权限 | 站点授权 + 刷新一次 | 站点授权 + `debugger` 权限 | **零权限、零刷新** |
| 副作用 | 无 | 页面顶部「正在调试此浏览器」黄条 | 无明显副作用，只是费流量 |
| 注入时机 | 必须 `document_start`，否则拿不到 init segment | 必须 `document_start` | 无要求，点一下就行 |
| 失效场景 | 页面不用 MSE | 调试器已被 DevTools 占用、切片迟迟不下完、流是 fMP4 分片 | 流需要 Referer/token 校验、DRM、直播窗口太窄 |

三条链路共用同一套 UI 和同步循环（`syncTick`），只有"音频从哪来"这一段不同：

```js
// 分派：能复用就复用，复用不了再想办法
if (hookReady && chunks.length)      startMseReuse(v);      // ①
else if (kind === 'hls' && muxjs)    startNativeCapture(v); // ②，失败自动退 ③
else if (kind === 'hls' || kind === 'direct') startViaSrc(v); // ③
```

三条链路建出来的 `enhAudio` 形态不同，但后面完全一样：

```js
// ① 复用：自己建 MediaSource，等 hook 到的片段灌进来
enhMS = new MediaSource();
enhMS.__adsOwn = true;                       // 避免 hook 抓到自己
enhAudio.src = URL.createObjectURL(enhMS);

// ② 抓取：同样建 MediaSource，但片段由后台通过调试协议送来
enhBuf = enhMS.addSourceBuffer('audio/mp4; codecs="mp4a.40.2"');

// ③ 再拉一路：直接交给浏览器解码
enhAudio.src = video.currentSrc;
```

同步这一步三条完全一样：

```js
const want = videoEl.currentTime - currentMs / 1000;  // 负值 = 音频跑到画面前面
if (bufferedHas(want)) {
  if (Math.abs(enhAudio.currentTime - want) > 0.04) enhAudio.currentTime = want;
} else if (Math.abs(enhAudio.currentTime - want) > 2.5) {
  enhAudio.currentTime = want;   // 离得远就 seek 过去，让浏览器自己去加载
}
```

### 视频在跨域 iframe 里

大量影视站把播放器外包给第三方「解析」接口：

```html
<iframe src="https://jx.example.com/vip/?url=<加密后的地址>">
```

`https://m.agedm.io` 就是这种结构——父页面 `document.querySelectorAll('video').length === 0`，真正的 `<video>` 在 iframe 里。所以双向模式的注入必须 `allFrames: true`，否则脚本只进顶层框架，面板挂在一个没有视频的页面上，永远显示「此页不支持双向」。

同时 `content.js` 在初始化时按「本框架里有没有 video」决定要不要显形：父框架保持隐藏，只有真正含 video 的那个 frame 出面版：

```js
if (document.documentElement.dataset.adsHooked === '1') {
  hookInstalled = true;
  if (pickVideo()) api.reveal();   // 没 video 就先藏着，交给轮询等它出现
  return;
}
```

`tabCapture` 的延迟模式不受影响——它抓的是整个标签页的混音，音频从哪层框架出来都一样。

### 实测数据

在本地 `hls.js` + 公开测试流（MSE，`blob:`）上跑出来的结果，音频电平用 `captureStream + AnalyserNode` 直接量：

| 滑块       | `audio.currentTime − video.currentTime` | 电平 RMS |
| -------- | --------------------------------------- | ------ |
| 0        | −0.020 s                                | 0.027  |
| −3000 ms | **+3.06 s**（声音提前 3 秒）                    | —      |
| +2000 ms | −1.93 s（声音延后 2 秒）                        | —      |
| −8000 ms | +8.06 s                                  | —      |

`delta = audio − video` 为正表示音频播放位置在画面**之前**，即观众**提前**听到对应内容；为负是延后。滑块语义是「音频延迟量」：负值提前、正值延后，与 hls.js 的 `audioDelay` 一致。

真实站点实测（Chrome 155，CDP 驱动滚轮）：

**B 站（MSE 路线，`blob:`，顶层 video）**

| 操作 | `audio − video` |
|---|---|
| 启用双向 | −0.063 s（同步，视频已静音） |
| 滑到 −3000 | **+2.941 s** |
| 滑到 −5000 | +4.937 s |
| 拉回 0 | −0.061 s |
| 退出双向 | 视频恢复出声，audio 销毁 |

**agedm.io（直连路线，视频在跨域 iframe 里）**

| 操作 | `audio − video` |
|---|---|
| 启用双向 | −0.060 s |
| 滑到 −3000 | **+2.920 s** |
| 滑到 −5000 | +4.953 s |
| 拉回 0 | −0.065 s |
| 退出双向 | 恢复出声 |

父框架 `visible: false`、iframe 内 `visible: true` —— 面板只出现在真正有播放器的那一层。

早前在受控页面上跑出的对照组（直连 `<video src=".m3u8">`）：

| 操作 | `audio − video` |
|---|---|
| 启用双向（未调） | −0.054 s（同步） |
| 滑到 −3000 | **+2.998 s**（提前 3 秒） |
| 滑到 −5000 | +4.939 s |
| 拉回 0 | −0.015 s |
| 退出双向 | 视频恢复出声，audio 元素销毁 |

***

## 限制

| 限制                     | 说明                                                                |
| ---------------------- | ----------------------------------------------------------------- |
| **默认模式只能延后**          | 实时流里没有"未来"的音频，`tabCapture` 抓的是已渲染输出，物理上做不到提前。要提前必须切到双向模式（见上）。 |
| **Chrome / Edge only** | Firefox 没有 `tabCapture`。`getDisplayMedia` 虽然能带音频，但会弹屏幕选择框，体验完全不同。 |
| **捕获整个标签页**            | 页面里的提示音、广告声会一起被延迟。只处理视频音轨做不到——那需要接管播放器。                           |
| **一次只能捕获一个标签页**        | 浏览器限制，同一标签页也只能被一路捕获。                                              |
| **接管后原播放器会静音**         | 页面上的音量条看起来正常但没声音，这是预期行为。                                          |

***

## 文件

```
manifest.json      MV3 清单
background.js      service worker 入口：点图标接管、管理 offscreen、消息路由
bg-auth.js         站点授权与增强脚本注册（permissions.request 的手势约束都在这）
bg-capture.js      原生 HLS 抓切片：chrome.debugger + Network.getResponseBody
offscreen.html/js  音频处理：getUserMedia → DelayNode → destination
ads-template.js    面板与提示的样式、结构模板（纯字符串，不碰 DOM）
ads-ui.js          面板、提示条、滑块/滚轮/键盘/拖动/全屏跟随 → window.ADS.ui
ads-enhance.js     双向模式三条链路 + 同步循环 → window.ADS.enh
content.js         内容脚本入口：消息路由、初始化
inject-main.js     MAIN world：劫持 appendBuffer，复制音频片段给双向模式用
mux.min.js         原生 HLS 那条链路用来把 ts 转成 fMP4（Apache-2.0）
icons/             16 / 32 / 48 / 128 四档图标（make-icons.js 生成）
tools/             图标生成、商店素材生成、打包校验、CDP 加载脚本
store/             商店提交材料：文案、截图、隐私政策
dist/              打好的提交包（package.js 产出）
```

后台两个模块用 `importScripts` 挂进 SW，和 `background.js` 共用同一个全局环境；
内容脚本几个文件则是靠 manifest 的顺序加载，通过 `window.ADS` 串起来。

***

## 开发

### 加载未打包扩展：用 Edge，不要用 Chrome

Chrome 137 起移除了 `--load-extension`。**Chrome 155 实测发现 CDP 的 `Extensions.loadUnpacked` 也失效了**——它会返回扩展 id，看着像成功，但扩展不起 service worker、content script 一个都不注入，重启浏览器后连安装记录都不剩。加 `--enable-unsafe-extension-debugging` 也救不回来。

Edge 没有这个问题（实测 `151.0.4129.93`，`--load-extension` 正常工作），所以自动化测试全部跑在 Edge 上：

```cmd
"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --user-data-dir="...\test-env\profile-dev" --load-extension="...\test-env\ext" --disable-extensions-except="...\test-env\ext" --remote-debugging-port=9227 --no-first-run --no-default-browser-check --autoplay-policy=no-user-gesture-required
```

三个必须同时满足的条件：

- **`--load-extension` 和 `--disable-extensions-except` 成对给**，只加载这一个扩展。否则别的扩展可能先占住 debugger，链路②直接 attach 失败
- **每次换一个新的 `--user-data-dir`**。浏览器会从旧 profile 恢复扩展副本，对已存在的路径再 `loadUnpacked` 是空操作——你会以为在测新代码，其实跑的是上次的
- **测试用 `test-env/ext` 那份副本**，改完源文件先 `cp` 过去再重启

> `test-env/` 是本地脚手架，整目录在 `.gitignore` 里：临时扩展副本、hls.js、测试切片都不入库。下文提到它时都是指你本机这份。

改完代码必须重启浏览器才能生效，`--load-extension` 加载的是启动那一刻的文件快照。

手工路线依然可用：`edge://extensions` → 开发者模式 → 加载已解压的扩展程序，改完点卡片上的刷新按钮。适合看一点改一点。

### 本地测试台

链路② 需要一个「切片请求会真的发出去」的环境，这里有两个坑，都踩过：

- **不要把同一个 ts 复制多份拼 playlist**。8 片内容相同意味着时间戳重复，Chrome 会报
  `CHUNK_DEMUXER_ERROR_APPEND_FAILED` 然后卡死，此后不再请求任何切片。要测就用单切片列表，或者真正时间戳连续的切片。
- **`python -m http.server` 不能用来测这条链路**。它不发 `Cache-Control`，单切片重新加载时 ts 会命中磁盘缓存，浏览器**压根不发请求**，`Network.requestWillBeSent` 一条都不来——现象和「attach 失败」一模一样，很容易查错方向。

```bash
node tools/serve-hls.js                                # 默认服务 test-env/hls，端口 8127
node tools/serve-hls.js --root ./some-dir --port 8127  # 换目录
```

> `tools/serve-hls.js` 本身在仓库内，`--root` 可以指到你放切片的地方。

重新生成图标与商店素材：

```bash
node tools/make-icons.js                              # icons/icon{16,32,48,128}.png
python tools/make-store-assets.py                     # store/ 下的截图、推广图、logo
```

> 商店素材脚本用 PIL 渲染真实字体（`pip install pillow`），中文标注不用手写点阵。

打商店提交包：

```bash
node tools/package.js         # → dist/audio-delay-sync-<version>.zip
```

跑点击行为测试（把 `chrome.*` 全 mock 掉，验证状态机）：

```bash
node tools/test-toggle.js    # 点图标的状态机
node tools/test-inject.js    # appendBuffer 劫持与数据复制
node tools/test-pagekind.js  # 播放方式判定（MSE / 原生 HLS / 直连 / 未知）
```

> 覆盖：首点接管、再点停止、换标签页先拆旧的、捕获被拒要提示且不留残留状态、页面不允许注入时退回图标角标、延迟值落盘、标签页关闭自动收尾。

> `package.js` 会在打包前做一轮清单检查：MV3、名称/描述长度、禁用词（不得出现其他浏览器名）、四档图标齐全、`update_url` 必须不存在、以及**每一项权限都能在代码里找到调用依据**。任何一项不过直接退出。

> ⚠ `getMediaStreamId` 校验的是「扩展是否被用户在**当前页面**调用过」，CDP 的 `Runtime.evaluate` 即使带 `userGesture: true` 也不算。所以**捕获这一步无法自动化**，必须真人点一次工具栏图标。这一点没有绕过方式，是 activeTab 的安全边界。

***

## 发布到 Edge 加载项商店

注册免费（Partner Center → Edge 计划），审核通常 3\~7 个工作日。

同一个 zip 直接复用，Edge 基于 Chromium，`chrome.*` API 与 manifest 完全一致。要改的只有商店侧的信息：

| 项            | 说明                                      |
| ------------ | --------------------------------------- |
| 名称 / 描述      | 不得出现 "Chrome" 等其它浏览器名（`package.js` 已校验） |
| `update_url` | 必须不存在                                   |
| 扩展 ID        | Edge 会分配一个新的，与 Chrome 商店的 ID 不同         |
| 认证测试说明       | **必须写明「先让视频播放再点接管」**，否则审核员在静音标签页上测试必然失败 |

完整文案、截图规格、权限理由、审核员测试步骤见 [`store/SUBMISSION.md`](store/SUBMISSION.md)。

***

## 首次使用检查清单

如果点了图标却听不到声音，按顺序排查：

1. **视频在播吗** —— 没有正在播放的音频，捕获会直接失败，顶部会弹提示
2. **是不是浏览器内部页** —— `chrome://`、扩展商店、PDF 阅读器不允许捕获
3. **看 service worker 控制台** —— `edge://extensions`（Chrome 是 `chrome://extensions`）→ 该扩展 → 检查视图 → Service Worker，红色报错就是原因
4. **看 offscreen 是否被创建** —— 控制台里 `chrome.offscreen.hasDocument()` 应该返回 `true`
5. **AudioContext 状态** —— 如果是 `suspended`，点一下页面再重试

只要链路建起来了，页面右下角会出现面板，电平条会跟着声音跳动。**电平条不动就说明没出声**，这时不要凭页面音量条判断。

***

## 调试

**接管后没声音**

打开扩展的 service worker 控制台（`chrome://extensions` → 该扩展 → 检查视图 → Service Worker），看有没有错误。常见原因：

- `AudioContext` 停在 `suspended` → 点一下页面再重试
- 音频链路某一步抛错 → 会自动回滚，标签页声音恢复

**面板没出现**

某些页面不允许注入（`chrome://`、扩展商店、部分 PDF 阅读器）。这类页面上音频本来也捕获不了，工具栏图标会短暂显示红色 `!` 角标提示失败。

**声音有咔哒声**

拖动滑块时 `delayTime` 在 60ms 内线性过渡。如果特别频繁地大幅拖动，偶尔会有轻微跳音——这是 `DelayNode` 的固有特性，无法完全消除。

### 双向模式没按预期走链路

**第一步永远是这一行**，F12 → Console：

```js
document.documentElement.dataset.adsState
```

输出扩展当下的内部判断：

```json
{"kind":"hls","mux":true,"hookInstalled":true,"hookReady":false,"chunks":0,
 "enhanced":true,"mode":"capture","why":"",
 "videoSrc":"http://127.0.0.1:8127/playlist-one.m3u8","videoPaused":false}
```

之所以写在 DOM 上：内容脚本跑在**隔离世界**，主世界 Console 读不到 `window.ADS`，DOM 是两边唯一的公共面。这也是这个功能唯一可自动化的观测点。

返回值是一个字符串，想看结构再套一层：

```js
JSON.parse(document.documentElement.dataset.adsState)
```

| 字段 | 含义 |
| --- | --- |
| `kind` | 播放方式：`mse` / `hls` / `direct` / `stream` / `unknown` / `none` |
| `mux` | mux.js 是否可用。为 `false` 时 ② 直接被跳过 |
| `hookInstalled` / `hookReady` | 增强脚本装上了 / 真的截到音频轨（两者是两件事） |
| `mode` | 当前链路：`mse` / `capture` / `src` |
| `why` | 落到 ③ 的原因，与指示条悬停提示同源 |
| `videoSrc` | 视频地址，判断有没有切片可抓就看它 |

**第二步：看抓切片的轨迹**

```js
document.documentElement.dataset.adsDiag
```

形如 `|attach-ok|evt:playlist.m3u8|hit:seq1.ts|fin|body:173580`。按顺序对：

| 缺哪段 | 含义 | 处理方向 |
| --- | --- | --- |
| 没有 `attach-ok` | attach 失败 | 看 SW 控制台的原始错误，多半是页面开着 DevTools |
| 有 `attach-ok` 没 `evt:` | Network 域没生效，或此后页面没发请求 | 确认点按钮后页面还在加载切片 |
| 有 `evt:` 没 `hit:` | URL 过滤没匹配上 | 有些站切片不带 `.ts` 后缀 |
| 有 `hit:` 没 `fin` | 流式请求悬着不结束 | 只能靠 12 秒超时降级 |
| 有 `fin` 没 `body` | 响应体已被回收 | 检查 `Network.enable` 的 buffer 参数 |

**三种观察通道，各有不可替代的位置**

1. **service worker 控制台**（`edge://extensions` → 检查视图 → Service Worker）——唯一能看到 attach 原始错误的地方
2. **页面 DOM 上的 `adsState` / `adsDiag`** ——不用开 SW 的 DevTools，且保留了时序
3. **外部 CDP 脚本** ——连 `--remote-debugging-port` 读页面状态，适合回归

**一个反直觉的失败**

② 挂上了却抓不到，最常见的原因不是权限也不是代码，而是**页面上没有新的切片请求**：你在播放中途点按钮，如果视频已经缓冲到边界、或者刚好暂停，attach 之后就没有新 ts 可抓，12 秒后降级 ③。这是取舍（不能无限等），不是 bug。

**面板显示「此页不支持双向」**

说明 `pickVideo()` 没找到 `<video>`——页面可能还在加载、播放器在别的框架里、或者内容根本没加载出来。这种情况三条链路都无从下手，跟 debugger 无关。

***

## 许可证

[MIT](LICENSE) © 2026 cxknotjj

随便用、改、商用、闭源分发都行，保留版权声明即可。

### 第三方组件

`mux.min.js` 是 [mux.js](https://github.com/videojs/mux.js) 7.0.3，**Apache-2.0**，
版权归 Brightcove, Inc.，原样分发、未做修改。只用于链路②把 ts 切片解复用成 fMP4。

按 Apache-2.0 的要求，许可全文和版权声明随包分发：

- [`LICENSE-APACHE-2.0.txt`](LICENSE-APACHE-2.0.txt) —— 许可全文
- [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) —— 版本、来源、用途、升级步骤

这两个文件都会打进 `dist/` 的发布包，不只是放在仓库里。
