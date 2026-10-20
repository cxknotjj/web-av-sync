# 音画偏移 · 标签页音频

接管**当前标签页**的音频输出，做实时延迟，修正音画不同步。
页面自己的播放器、进度条、画质切换、字幕全部不动——它只是把最终输出的声音推迟一点。

![使用场景](store/screenshot-1-scene.png)

<sub>播放器、工具栏面板、页面内悬浮面板三者同时工作；页面本身不受影响。</sub>

---

## 特性

- **零适配**：抓的是浏览器渲染后的最终混音，不受网站 CORS、播放器实现、加密流影响
- **一个界面**：点图标即接管，所有调节都在页面右下角那块面板里，没有第二个弹窗
- **实时可调**：拖滑块立刻生效，不用刷新、不用重新加载
- **全屏可用**：面板挂在页面里，切全屏也跟着走
- **记住上次**：延迟值存在本地，下次接管直接沿用
- **双向模式**：MSE 播放器上可以切换到「声音提前」，见下节
- **无网络请求**：所有代码打包在扩展内，可离线使用，不采集任何数据

---

## 为什么是扩展，不是油猴脚本

`chrome.tabCapture` 是扩展 API，页面上下文和油猴都拿不到。

换来的是**彻底绕开 CORS**：抓的是浏览器渲染完之后的声音，跟源站给不给 `Access-Control-Allow-Origin` 一点关系都没有。任何视频站、任何播放器、任何加密流都能用。

---

## 安装

**方式一：源码加载**（推荐开发时用）

```bash
git clone https://gitee.com/the-chicken-god-comes/AudioDelaySync.git
```

1. 打开 `chrome://extensions`（Edge 是 `edge://extensions`）
2. 右上角打开**开发者模式**
3. 点**加载已解压的扩展程序**，选中仓库目录
4. 把图标固定到工具栏

**方式二：打包安装**

```bash
node tools/package.js   # 产出 dist/audio-delay-sync-<version>.zip
```

把 zip 解压后按方式一加载；或直接上传到 Edge 加载项商店 / Chrome 应用商店。

要求 Chromium 内核 **116+**（用到 `offscreen.hasDocument`）。

---

## 使用

1. 打开视频页面，**让它开始播放**（没有声音时捕获会失败）
2. **点一下工具栏上的扩展图标** —— 声音被接管，页面右下角出现面板
3. 拖滑块调节，口型和声音对上了就停手

再点一次图标就是停止，声音立刻回到页面。面板上也有「停止」按钮。

面板可以拖到任意位置，点 `−` 收起成一条，点 `×` 停止并关闭。

**键盘微调**：鼠标悬停在面板上时，`←` `→` 每次 100ms，`Shift + ←/→` 每次 1 秒，`Home` 归零。只在悬停时生效，避免和播放器自己的方向键（快进快退）打架。

**接管失败会弹提示**：比如标签页没有声音、或页面不允许捕获，顶部会出现一条红色说明，7 秒后自动消失。

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

---

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
3. 点它，同意该站点的访问权限，然后**刷新一次页面**
4. 刷新后再点图标，面板上会出现「启用双向」，点一下切过去

第 3 步的刷新躲不掉：`init segment`（定义音频编码参数的那段）只在播放器初始化时 append 一次，扩展必须在那之前就装好 hook。

### 限制

| 限制 | 说明 |
|---|---|
| 只对 MSE 播放器有效 | `video.src` 是 `blob:` 才行。原生 HLS（`src` 直接是 `.m3u8`）时数据在浏览器内部，JS 碰不到 |
| 首次要授权 + 刷新 | 见上 |
| 零额外带宽，但双倍解码 | 数据是页面已下载的，不重复请求；但解码确实跑了两遍 |
| 能提前多少取决于缓冲 | 只能提前到「已经下载到」的位置，超出会卡住等数据 |
| 和 tabCapture 互斥 | 进入双向模式会停掉捕获链路，主视频转为静音 |

---

## 限制

| 限制 | 说明 |
|---|---|
| **只能延后，不能提前** | 实时流里没有"未来"的音频，物理上做不到。遇到声音比画面晚的片子，只能走离线重编码。 |
| **Chrome / Edge only** | Firefox 没有 `tabCapture`。`getDisplayMedia` 虽然能带音频，但会弹屏幕选择框，体验完全不同。 |
| **捕获整个标签页** | 页面里的提示音、广告声会一起被延迟。只处理视频音轨做不到——那需要接管播放器。 |
| **一次只能捕获一个标签页** | 浏览器限制，同一标签页也只能被一路捕获。 |
| **接管后原播放器会静音** | 页面上的音量条看起来正常但没声音，这是预期行为。 |

---

## 文件

```
manifest.json     MV3 清单
background.js     service worker：点图标接管、管理 offscreen、状态广播
offscreen.html/js 音频处理：getUserMedia → DelayNode → destination
content.js        页面内面板（Shadow DOM，全屏跟随）+ 错误提示 + 双向模式
inject-main.js    MAIN world：劫持 appendBuffer，复制音频片段给双向模式用
icons/            16 / 32 / 48 / 128 四档图标（make-icons.js 生成）
tools/            图标生成、商店素材生成、打包校验、CDP 加载脚本
store/            商店提交材料：文案、截图、隐私政策
dist/             打好的提交包（package.js 产出）
```

---

## 开发

Chrome **137 起移除了 `--load-extension`**（防止恶意软件加载），所以命令行带不动未打包扩展了。两条路：

**日常改代码**：`chrome://extensions` → 开启开发者模式 → 加载已解压的扩展程序 → 改完点卡片上的刷新按钮。

**需要自动化时**，用 CDP 的 `Extensions.loadUnpacked`：

```bash
# 1. 带扩展调试开关启动一个独立实例
chrome.exe --remote-debugging-port=9226 \
           --enable-unsafe-extension-debugging \
           --user-data-dir=/tmp/ads-test about:blank

# 2. 通过 CDP 加载（会打印扩展 ID）
CDP_PORT=9226 node tools/load-unpacked.js
```

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
```

> 覆盖：首点接管、再点停止、换标签页先拆旧的、捕获被拒要提示且不留残留状态、页面不允许注入时退回图标角标、延迟值落盘、标签页关闭自动收尾。

> `package.js` 会在打包前做一轮清单检查：MV3、名称/描述长度、禁用词（不得出现其他浏览器名）、四档图标齐全、`update_url` 必须不存在、以及**每一项权限都能在代码里找到调用依据**。任何一项不过直接退出。

> ⚠ `getMediaStreamId` 校验的是「扩展是否被用户在**当前页面**调用过」，CDP 的 `Runtime.evaluate` 即使带 `userGesture: true` 也不算。所以**捕获这一步无法自动化**，必须真人点一次工具栏图标。这一点没有绕过方式，是 activeTab 的安全边界。

---

## 发布到 Edge 加载项商店

注册免费（Partner Center → Edge 计划），审核通常 3~7 个工作日。

同一个 zip 直接复用，Edge 基于 Chromium，`chrome.*` API 与 manifest 完全一致。要改的只有商店侧的信息：

| 项 | 说明 |
|---|---|
| 名称 / 描述 | 不得出现 "Chrome" 等其它浏览器名（`package.js` 已校验） |
| `update_url` | 必须不存在 |
| 扩展 ID | Edge 会分配一个新的，与 Chrome 商店的 ID 不同 |
| 认证测试说明 | **必须写明「先让视频播放再点接管」**，否则审核员在静音标签页上测试必然失败 |

完整文案、截图规格、权限理由、审核员测试步骤见 [`store/SUBMISSION.md`](store/SUBMISSION.md)。

---

## 首次使用检查清单

如果点了图标却听不到声音，按顺序排查：

1. **视频在播吗** —— 没有正在播放的音频，捕获会直接失败，顶部会弹提示
2. **是不是浏览器内部页** —— `chrome://`、扩展商店、PDF 阅读器不允许捕获
3. **看 service worker 控制台** —— `chrome://extensions` → 该扩展 → 检查视图 → Service Worker，红色报错就是原因
4. **看 offscreen 是否被创建** —— 控制台里 `chrome.offscreen.hasDocument()` 应该返回 `true`
5. **AudioContext 状态** —— 如果是 `suspended`，点一下页面再重试

只要链路建起来了，页面右下角会出现面板，电平条会跟着声音跳动。**电平条不动就说明没出声**，这时不要凭页面音量条判断。

---

## 调试

**接管后没声音**

打开扩展的 service worker 控制台（`chrome://extensions` → 该扩展 → 检查视图 → Service Worker），看有没有错误。常见原因：

- `AudioContext` 停在 `suspended` → 点一下页面再重试
- 音频链路某一步抛错 → 会自动回滚，标签页声音恢复

**面板没出现**

某些页面不允许注入（`chrome://`、扩展商店、部分 PDF 阅读器）。这类页面上音频本来也捕获不了，工具栏图标会短暂显示红色 `!` 角标提示失败。

**声音有咔哒声**

拖动滑块时 `delayTime` 在 60ms 内线性过渡。如果特别频繁地大幅拖动，偶尔会有轻微跳音——这是 `DelayNode` 的固有特性，无法完全消除。

---

## 许可证

[MIT](LICENSE) © 2026 cxknotjj

随便用、改、商用、闭源分发都行，保留版权声明即可。
