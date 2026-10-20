# 第三方组件声明

本扩展自身以 MIT 许可发布，全文见 [LICENSE](LICENSE)。

下面列出随包分发的第三方代码。上架审核和分发合规都以本文件为准。

---

## mux.js 7.0.3

| 项目 | 内容 |
| --- | --- |
| 文件 | `mux.min.js`（115 KB，压缩后的 UMD 构建） |
| 许可 | Apache License 2.0 |
| 版权 | Copyright Brightcove, Inc. |
| 源码 | <https://github.com/videojs/mux.js> |
| 分发 | <https://www.npmjs.com/package/mux.js> |
| 获取地址 | `https://unpkg.com/mux.js@7.0.3/dist/mux.min.js` |
| 是否修改 | **未修改**，原样分发 |

许可全文见 [LICENSE-APACHE-2.0.txt](LICENSE-APACHE-2.0.txt)，与 npm 包内的 `LICENSE` 逐字相同。

### 用途

只用在链路②（原生 HLS 抓切片）上：把 `chrome.debugger` 取回来的 MPEG-TS 切片解复用，
抽出 AAC 音频轨、重新封装成 fMP4，才能喂给 `MediaSource`。

调用点是 `ads-enhance.js` 的 `onSegChunk()`：

```js
const t = new muxjs.mp4.Transmuxer({ keepOriginalTimestamps: true, remux: false });
```

`remux: false` 是必须的——默认的 `combined` 输出里带 `avc1` 视频轨，
`audio/mp4` 的 `SourceBuffer` 会直接拒收。

### 为什么不用别的办法

Chrome 的 `MediaSource.isTypeSupported('video/mp2t')` 返回 `true`，但真的
`addSourceBuffer('video/mp2t')` 会抛 `NotSupportedError`。也就是说 ts 字节没法直接交给 MSE，
必须在扩展里自己做 demux。mux.js 是这件事最成熟的现成实现。

### 未使用的部分

压缩包里包含 mux.js 的全部功能（mp4、flv、ts 的 transmux 与 mux），
本扩展只用了 `muxjs.mp4.Transmuxer` 的 ts→fMP4 这一条路径。没有做 tree-shaking，
因为自己构建一份反而更难保证和上游一致。

---

## 更新 mux.js 时要做的事

1. 用新版本号替换上面表格里的 `7.0.3`
2. 重新下载 `dist/mux.min.js` 和 `LICENSE`，覆盖 `mux.min.js` 与 `LICENSE-APACHE-2.0.txt`
3. 确认 `mux.min.js` 首行的 banner 还在（`/*! @name mux.js ... @license Apache-2.0 */`）
4. 跑一遍链路②的冒烟测试（判据：面板指示条出现 `② 抓取已下载切片`，且
   `document.documentElement.dataset.adsDiag` 里有 `hit:xxx.ts|fin|body:...`）
