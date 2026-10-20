# 音画偏移 · 标签页音频

接管**当前标签页**的音频输出，做实时延迟，修正音画不同步。
页面自己的播放器、进度条、画质切换、字幕全部不动——它只是把最终输出的声音推迟一点。

![使用场景](store/screenshot-1-scene.png)

<sub>播放器、工具栏面板、页面内悬浮面板三者同时工作；页面本身不受影响。</sub>

---

## 特性

- **零适配**：抓的是浏览器渲染后的最终混音，不受网站 CORS、播放器实现、加密流影响
- **实时可调**：拖滑块立刻生效，不用刷新、不用重新加载
- **全屏可用**：页面右下角有悬浮面板（Shadow DOM 隔离，跟随全屏）
- **键盘精调**：`←` `→` 100ms，`Shift + ←/→` 1s，`Home` 归零，`Enter` 起停
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

1. 打开视频页面，**让它开始播放**（没声音时捕获会失败）
2. 点工具栏上的扩展图标
3. 点**接管当前标签页**
4. 拖滑块调节，页面右下角会出现悬浮面板——全屏也能用

再次点图标可以停止，或点面板上的「停止」。停止后声音自动回到页面本身。

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
background.js     service worker：管理 offscreen、注入面板、状态广播
offscreen.html/js 音频处理：getUserMedia → DelayNode → destination
popup.html/js/css 工具栏面板：发起接管、调节延迟
content.js        页面内悬浮面板（Shadow DOM，全屏跟随）
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

重新生成图标：

```bash
node tools/make-icons.js      # icons/icon{16,32,48,128}.png
node tools/make-store-assets.js   # store/ 下的截图、推广图、logo
```

打商店提交包：

```bash
node tools/package.js         # → dist/audio-delay-sync-<version>.zip
```

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

如果点了「接管」却听不到声音，按顺序排查：

1. **视频在播吗** —— 没有正在播放的音频，捕获会直接失败
2. **是不是浏览器内部页** —— `chrome://`、扩展商店、PDF 阅读器不允许捕获
3. **看 service worker 控制台** —— `chrome://extensions` → 该扩展 → 检查视图 → Service Worker，红色报错就是原因
4. **看 offscreen 是否被创建** —— 控制台里 `chrome.offscreen.hasDocument()` 应该返回 `true`
5. **AudioContext 状态** —— 如果是 `suspended`，点一下页面再重试

只要链路建起来了，页面右下角会出现悬浮面板，电平条会跟着声音跳动。**电平条不动就说明没出声**，这时不要凭页面音量条判断。

---

## 调试

**接管后没声音**

打开扩展的 service worker 控制台（`chrome://extensions` → 该扩展 → 检查视图 → Service Worker），看有没有错误。常见原因：

- `AudioContext` 停在 `suspended` → 点一下页面再重试
- 音频链路某一步抛错 → 会自动回滚，标签页声音恢复

**面板没出现**

某些页面不允许注入（`chrome://`、扩展商店、部分 PDF 阅读器）。这不影响音频，只是少了调节入口，用 popup 调也一样。

**声音有咔哒声**

拖动滑块时 `delayTime` 在 60ms 内线性过渡。如果特别频繁地大幅拖动，偶尔会有轻微跳音——这是 `DelayNode` 的固有特性，无法完全消除。

---

## 许可证

[MIT](LICENSE) © 2026 cxknotjj

随便用、改、商用、闭源分发都行，保留版权声明即可。
