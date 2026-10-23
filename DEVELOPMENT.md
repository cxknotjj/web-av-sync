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

三条链路的编号、名称、代价写在 `ads-enh-core.js` 顶部的 `ROUTES` 表里，加链路只要往表里添一条；而「这次会走哪条」由 `pickRoute()` 统一判断，UI 预告和真正分派共用它，避免出现「预告说走①、实际跑③」。

### 限制

| 限制              | 说明                                                                                                               |
| --------------- | ---------------------------------------------------------------------------------------------------------------- |
| 三条链路各有前提        | **MSE 播放器**（`blob:`）走①，零额外带宽但要授权 + 刷新；**原生 HLS**（`.m3u8`）优先走②，抓不到再退③；**直连 mp4** 只能走③  |
| 能提前多少取决于缓冲      | 只能提前到「已经下载到」的位置，超出会卡住等数据                                                                                         |
| 误差几十毫秒          | 每 250ms 校正一次，偏差超过 40ms 才动，实测落在 20\~70ms                                                                          |
| 和 tabCapture 的关系 | **不互斥**：进入双向模式只是把主视频静音、改由本地音轨出声，tabCapture 链路继续留着——而且此时它承载的正是那条本地音轨（所以两条链路要按符号分工，见下一节）。退出双向时 `videoEl.muted = false`，页面声音原样回来 |

### 双向模式里两条链路怎么分工

`tabCapture` 抓的是**整个标签页的混音**，并且把标签页本身的输出静音，声音只能由
offscreen 里的 DelayNode 送去扬声器。而双向模式放进去的那条 `<audio>` 也是页面元素
——它同样在这个混音里。所以两条链路都能产生延迟，不加约束就会做两遍。

但**「不叠加」不等于「DelayNode 一律归零」**。用哪条，取决于延迟的符号：

| 面板值 | 谁来做 | DelayNode | `<audio>` 位置 |
| --- | --- | --- | --- |
| 负值（声音提前） | `<audio>` 往前挪 | **0** | `video.currentTime + \|ms\|/1000` |
| 正值（声音延后） | DelayNode | **ms** | `video.currentTime`（贴画面） |

- **负值只能靠 `<audio>`**：DelayNode 没法让声音提前，留着它只会把已经提前的音频
  再拖回去，两边正好抵消。所以这时候必须归零。
- **正值交给 DelayNode**：零缓冲消耗、不用提前下载，改一次 `delayTime` 立刻生效。
  这时候 `<audio>` 只要贴着画面走。

判据落在 `ads-enh-core.js` 的两个函数上：`wantTime()` 决定音频该播到哪一秒
（只对负值减 `|ms|`），`syncCapturePipe(ms)` 决定这一拍该把 DelayNode 设成什么。

#### 曾经的回归：正值被当成负值处理

早先这里不分符号，`enhReady()` 无条件 `bypassCaptureDelay()`，而 `syncTick` 里
又照旧用 `want = video.currentTime - currentMs/1000`。两者一叠加，拖任何**正值**
都会去要「画面之前」的数据 —— 缓冲区里根本没有，于是面板一路挂着
「等缓冲 · 还差 N 秒」，画面被按住不动，听感上就是**延迟整个失效**。

实测（`test-env/test-features.js` 第 5 组 + 手工探针）：

| 操作 | 修复前 | 修复后 |
| --- | --- | --- |
| 拖 +2000 | `stalled=true`，等缓冲还差 2.0s，DelayNode=0 | DelayNode=2000，音频贴画面（drift −0.04s），不等缓冲 |
| 拖 −3000 | DelayNode=0，drift +2.95s（正确） | 不变 |
| 拖回 +1500 | 又卡等缓冲 | DelayNode=1500，drift −0.05s |

**`transient: true` 仍然必须**：`background.setDelay()` 默认会把值写进
`lastDelayMs`（下次接管沿用）。双向期间这些临时值不该覆盖用户调好的延迟，所以带
transient 的调用只改 DelayNode、不落盘。真正需要持久化的只有 `giveUpWait()`
那次降档——那是用户看得见的变化，面板数字会跟着变小。

**已知取舍**：正值时音频与画面各自解码，会有几十毫秒的固有偏差，靠 `alignAudio()`
的倍速微调追平；负值仍然要提前下载，缓冲不够时会按住画面等（见下一节）。

#### 滑块归零 ≠ 声音归零：tabCapture 回路本身有 ~95ms

双向模式下声音的路径比单向长一整段：

```
<audio> → 页面音频总线 → tabCapture → offscreen source
        → DelayNode → destination → 扬声器
```

`DelayNode` 只是其中一环。把它设成 0，前面那段捕获缓冲照样存在。
2026-10-22 用 `test-env/diag-loop-latency.js` 实测（页面打 20ms 脉冲，
offscreen 的 analyser 以 4ms 采样找峰值，四轮）：

| 轮次 | 页面输出 → offscreen 收到 |
| --- | --- |
| 1 | 63ms |
| 2 | 71ms |
| 3 | 70ms |
| 4 | 79ms |

平均 **71ms**，加上 `AudioContext.outputLatency`（实测 24ms），再减去画面渲染的
1~2 帧，净延迟约 **70ms**。这就是「滑块拖到 0、声音还是慢半拍」的来源 ——
它不在 `DelayNode` 里，归零操作碰不到它。

修法是把这段提前量补在 `wantAt()` 上（`C.LOOP_COMP = 0.07`）：让 `<audio>`
提前 70ms 播，声音走完回路正好对上画面。**只补双向模式**（`S.enhanced` 为真）——
单向模式的声音直接出扬声器，没有这段回路，补了反而会让声音跑到画面前面。

> 这个值是本机实测的。不同机器 / 蓝牙耳机的回路延迟差异很大（蓝牙可能 150ms+），
> 如果用户反馈「归零后声音还是晚」，先让他跑一次 `diag-loop-latency.js`，
> 按实测值改 `LOOP_COMP`，别凭感觉调。

#### 归零之后还有 1~2 秒延迟：`captureTick` 的死区

链路② 的判据原来分三档：`|drift| < 1.0` 正常播、`bufferedHas(want)` 就 seek、
其余静音。中间 **1.0~2.0 秒** 没人管：既不 seek（`bufferedHas` 为假），
也不摆位置（`trySetAudioPos` 的阈值是 2 秒），只是把音频暂停。

暂停之后音频位置不再前进，而 `want` 跟着视频一直走，落后只会越等越大 ——
用户听到的就是「延迟怎么调都消不掉」。修法两条：

- `DRIFT_SEEK` 之外的纠偏改成每拍都试：`seekAudioTo(aim)` 不行就贴到
  **缓冲末尾**，但必须 `tail <= aim`（只往前贴、绝不往后跳）。
  少了这个方向判断，`bufferedEnd()` 会把音频直接扔到十几秒后的预加载段上，
  实测 `aT-vT` 从 −1.4 秒变成 **+8.5 秒**，等于把未来的声音提前放出来。
- `alignAudio()` 的倍速上限从 ±4% 提到 ±10%：原来追 1 秒要 25 秒，
  用户感知就是「一直在延迟」；±10% 十秒内能追平，`playbackRate` 是保音高的
  time-stretch，短时间用听不出来。

**接管瞬间还有一段静音**：链路② 只抓得到「接管之后播放器才请求的切片」，
开头那截在接管前就下载完了。所以缓冲常常从 10.36 秒开始，而 `currentTime`
还是 0 —— MSE 不会自己跳过去，数据到了、视频也追上了，音频却还停在 0。
现在检测到「当前位置不在任何缓冲区间」就主动站到 `buffered.start(0)` 等着。
实测进双向后静音约 3 秒（等视频追上缓冲起点），之后 `drift` 稳定在 0~0.03。

### 缓冲跟不上提前量时：按住画面等下载

> **这一节只适用于链路① 和链路③。** 链路② 的数据全部来自「播放器请求了哪些
> 切片」，按住画面等于断掉自己的数据源 —— 等得越久数据越不来。它走的是
> 「视频优先、音频异步追」，见本节末尾的〈链路② 为什么不能等〉。

`syncTick()` 每 250ms 对一次表：音频要播的位置是 `want = video.currentTime - currentMs/1000`，
`bufferedLead(want)` 返回「want 之后还剩多少秒缓冲」，负数就是「还差多少秒」。

`bufferedLead` 在目标**落在缓冲范围之外**时返回的是「离最近的缓冲边缘有多远」：

- 在末尾之后 → 还没下到那儿（提前量拖得比下载还快）
- 在开头之前 → 用户把进度条拖回去了，缓冲里没有更早的数据

两种都必须返回**可测量的数字**，不能一律给 `-999`。原因见下面「还在下载」那一条：
等缓冲期间唯一的进度信号就是这个数在变大。老实现只处理「末尾之后」，往回拖时
`bufferedLead` 恒为 `-999`、缓冲末尾又是旧位置的高水位永远不长，4 秒就被判成
「下不来了」，提前量被清掉、声音也没回来。

| 情形 | 行为 |
| --- | --- |
| `lead >= 1.5`（RESUME_LEAD） | 正常播，差 40ms 以上就倍速/seek 对齐 |
| `lead` 在 -0.4 ~ 1.5 之间 | 原地等下一拍 —— 网络抖一下很正常，别为它按暂停 |
| 缓冲末尾连续 2 秒没长，且 `lead > 0.4` | 放行。到片尾时剩下的余量就是全部本钱，差零点几秒达不到 1.5 也要播，否则会一路等到「卡死」超时 |
| `lead < -0.4`（WAIT_GAP） | **`stallNow()`：视频和音频一起 pause**，面板右侧改成「等缓冲 · 还差 N 秒」 |
| 等待中 `lead` 在变大 **或** 缓冲末尾在长 | 继续等（面板数字在减少，用户看得见） |
| 目标位置有数据但不够，且 4 秒（WAIT_STUCK_MS）没进展 | `giveUpWait()`：**把提前量自动降到缓冲撑得住的位置**并恢复播放 |
| 目标位置整个落在缓冲外，6 秒（1.5×WAIT_STUCK_MS）没进展 | 同上。这时降提前量本来救不了，交给 `giveUpWait` 去确认：降完还没数据就退出双向，而不是放开画面变成「画面走、声音没有」 |
| 总等待超 15 秒（WAIT_MAX_MS） | 无条件放弃 |
| 已经降到当前值（没得降了） | `enhFail()` 退出双向、归还原声 —— 再放开只会变成「停一会儿、动半秒」的循环 |

等待期间每一拍都会重新 `pause()` 一次视频，不是只在进入时按一次。原因见下一节：
播放器会在用户拖完进度条后自己 `play()`，和我们抢控制权。

#### 链路② 为什么不能等

`chrome.debugger` 只拿得到**播放器实际请求过**的切片。播放器被 `pause()` 之后
就不再发新请求，于是形成一个闭环：

```
音频缺数据 → stallNow 按住画面 → 播放器停止请求 → 数据永远不来 → 一直缺数据
```

2026-10-22 用 `test-env/diag-seekfetch.js` 实测过（41 秒素材 / 限速 40KB/s /
seek 到 30s），三组只有「暂停与否」不同：

| 操作 | 音频缓冲的走向 |
| --- | --- |
| seek 后立刻 `pause()` | 4.0s 才拿到 `25.9~30.77` —— 只有包含跳转点的那一片，此后 7 秒**一动不动** |
| seek 后保持播放 | 3.25s 拿到 `25.9~30.77`，6.5s 长到 `25.9~35.95` |
| seek 后暂停 4 秒再恢复 | 恢复后 3.2 秒长到 `25.9~35.95` |

**停滞是可逆的，前提是播放器继续跑。** 所以链路② 的策略是
「视频优先，音频异步追，追不上就静音」：

| 状态 | 行为 |
| --- | --- |
| 音频在目标附近（偏差 < 1 秒） | 正常播，`alignAudio` 微调 |
| 偏差大，但目标点已有缓冲 | `seekAudioTo` 直接对齐 |
| 目标点没数据 | `enhAudio.pause()`，面板显示「音频重新加载中，画面继续」；**视频不碰** |
| 偏差 > 2 秒 | `trySetAudioPos()` 先把位置摆过去，等切片到了自己续播 |
| 静音超过 2 秒 | 把提前量降到缓冲撑得住的值（`bufferedEnd − video − 0.8`），`transient` 发送不落盘 |
| 跳转后 15 秒 `capBytes` 没增长 | 这个位置的数据抓不到，`degradeCapture()` 换链路③ |
| **静音超过 8 秒**（`CAP_SILENT_MAX_MS`） | 同样 `degradeCapture()`。**这条是保命的**，见下文 |
| 用户自己按暂停 | 音频跟着停（用 `paused && !seeking` 区分，别把「卡在等数据」当成用户暂停） |

代价是跳转后可能有一小段没声音。这是刻意接受的：**宁可无声几秒，也不让画面
卡住十几秒再降档**。面板上的「可安全提前」也只在音频真的连续可播时才显示，
跳转期间改成文字说明。

**为什么不能靠「先把位置摆过去」省掉这段无声**：`trySetAudioPos()` 要检查
`seekable`，而 MSE 的 `seekable` 不会超出 `buffered` —— 实测 `duration` 已经被
`ensureSeekRange()` 撑到 93，`seekable` 仍然只报 `0.00~36.28`（等于缓冲末尾）。
所以跳转到未缓冲区域时，「把 `currentTime` 先设到目标」这条路根本走不通，
只能等数据 append 过来把目标点覆盖。

实测（`test-env/diag-starve.js`，限速 12KB/s、seek 到 30s、提前量 3 秒）：

| 策略 | 出声时间 | 过程 |
| --- | --- | --- |
| 只静音不降档 | **20.5 秒** | 音频停在 2.07 秒不动，等缓冲从 15.56 长到能覆盖 33 |
| 静音 2 秒后自动降到 0 | **10.5 秒** | 目标从 `video+3` 退回 `video`，缓冲覆盖 30 就够了，少等一片 |

降档用 `transient: true` 发，不写 `lastDelayMs` —— 用户下次进双向还是他自己
设的值。滑块会跟着动，同时弹一条 toast 说明降到了多少。

#### 三条出口为什么缺一不可

静音（`audioSilent`）看起来已经有两条出路，实际每条都有前提，用户很容易踩进空档：

| 出口 | 前提 | 什么情况下不成立 |
| --- | --- | --- |
| 静音 2 秒自动降档 | 提前量是**负值**，才有的可降 | 滑块在 0 或正值时 `target = max(-budget, currentMs)` 等于原值，降无可降 |
| 跳转后 15 秒 `capBytes` 没涨 → 换链路③ | 必须**发生过 seek**（`S.seekAt`），且**一条新切片都没抓到** | 没拖过进度条，或者切片在慢慢来（`capBytes` 在涨但太慢） |

两条都不成立时，唯一的结果就是**一直挂着「音频重新加载中，画面继续」**。
2026-10-22 实测复现（`diag-starve.js`，限速 12KB/s、seek 到 30s）：

```
t=0      vT=30  aT=20.49  aBuf=17.54-20.74  capBytes=85236   silent=true
t=10.0   vT=30  aT=20.49  aBuf 多出 25.90-31.10  85236        silent=true
t=10.5   vT=30.58 aT=30.55  aBuf=27.43-31.10  127854         silent=false
```

十秒里 `capBytes` 一动不动 —— 一片 173KB，按 12KB/s 要 14 秒才下得完。
以前这十秒就是一个黑洞：没有进度、没有出口，用户只能看着面板发呆。

所以补了第三条**无条件**的出口：静音满 8 秒就降级，不看符号、不看有没有跳转。
降级后链路③ 自己还有 15 秒就绪超时（`enhGuard`），超时会退出双向、把页面声音还回去。
最坏路径是「8 秒静音 → 降级 → 15 秒没起来 → 退出双向」，至少一定有声音。

> 配套改了一处判定：第一档「位置对」原来无条件清 `silentSince`。
> 但位置对不代表有数据（`readyState` 可能还是 0），清零会让 8 秒永远数不满。
> 现在要 `readyState >= 2` 才算恢复。

两个配套改动：

- `trimBuffer()` 的基准从 `enhAudio.currentTime` 改成
  `min(wantTime(), enhAudio.currentTime)`。只用视频位置，会在音频落后时把
  **正在播的那一段**当历史删掉；只用音频位置，则会在 seek 后把新位置要用的
  余量删掉。取小的那个两个坑都避开。
- `onVideoSeek()` 里把 `S.muxer` 置 null。PTS 跨段跳变会打破 Transmuxer 的
  DTS 连续性假设，不重建的话 seek 后第一批切片可能转出错误时间戳、被
  SourceBuffer 拒收 —— 表现和「抓不到切片」一模一样，很难区分。

#### 拖动进度条：位置、队列、缓冲三件事

`onVideoSeek()` 挂在 `<video>` 的 `seeking` 事件上（`enhReady` 里加、退出时摘）。
用户拖一下进度条，必须同时做三件事，少一件就会出问题：

| 做什么 | 不做会怎样 |
| --- | --- |
| 把 `enhAudio.currentTime` 挪到 `video.currentTime - 提前量` | 画面已经在新位置，声音还在旧位置。等 250ms 一拍的 tick 去发现也不够——中间那几拍就是明显的不同步 |
| 清空 `appendQueue` | 队列里排着的旧片段会被 `pump()` 一片片灌进 MSE，把用户**刚跳过的那一整段**都缓冲下来。这就是「强制缓存已跳过内容」 |
| `trimBuffer()`：`SourceBuffer.remove(0, currentTime - 3)` | MSE 不会自己回收，append 进去的数据一直占着。拖几次之后内存里攒下一整条音轨 |

另外 `stallSince / stallTail / stallLead / stallGiveUps` 都要按新位置重置 ——
不重置的话「刚跳过来的等待」会被算成「已经等了很久」，几秒后就误降档。

**`seekAudioTo()` 判断能不能 seek 用的是 `buffered`，不是 `seekable`。** 实测
缓冲只有 `10.36~15.56` 时 `seekable` 会报 `0~15.56`，中间那段其实是空的；
seek 进空洞不报错，而是**永久停在 seeking 上** —— 之后所有校正都被
`if (!enhAudio.seeking)` 挡住，音频从此不动、画面照走。这是最隐蔽的一条。
`ensureSeekRange()`（把 `MediaSource.duration` 抬到目标之外）保留着做兜底，
但在 Chromium 上真正管用的是 `buffered` 这一层。

链路② 另有一个 `trySetAudioPos()`：它**不**看 `buffered`，只看 `seekable`，
专门用于「数据还没来、但位置得先过去」。两者分工不同 —— `seekAudioTo` 是
「有数据了，纠一下」，`trySetAudioPos` 是「先把位置摆到目标，等数据来」。
后者只在偏差超过 2 秒时才调用，小偏差交给 `alignAudio` 的倍速，否则会把
媒体元素硬设到一个暂时没数据的位置，反而卡成 seeking。

顺带修了 `ensureSeekRange()` 一个从来没生效过的判断：它写的是
`if (!isFinite(cur)) return`，而 MSE 初始 `duration` 就是 NaN —— 等于整段
是死代码，`duration` 永远不会被撑大。现在把 NaN 当 0 处理。

**抓取层也要挡一道。** `bg-capture.js` 在 `requestWillBeSent` 时给每个请求记
`at`（SW 的墙钟），随 `seg` 消息带回页面；`onSegChunk` 丢掉
`msg.at < seekAt - 30ms` 的片段——那是 seek 之前发出去的请求，字节属于
已跳过的那一段，抓回来也是浪费。

两个关键设计：

#### 位置对齐：小偏差用倍速追，绝不动不动就 seek

`alignAudio()` 的规则（这是「声音一顿一顿」的修复）：

| 偏差 | 处理 |
| --- | --- |
| < 40ms | 不管，倍速保持 1 |
| 40ms ~ 350ms | `playbackRate = 1 - drift/4`（上限 ±4%），平滑追上 |
| > 350ms | seek 一次到位 |

以前是 `|偏差| > 40ms` 就 seek，而 `syncTick` 每 250ms 跑一拍 —— 音频时钟和视频时钟
本来就有点相对漂移，结果就是**每秒 seek 好几次**，每次 seek 都打断解码输出，
听感上就是一顿一顿。倍速方案下 0.2 秒的偏差约 5 秒平滑追完，听不出变速
（±4% 对音高的影响远小于人对节奏突变的敏感）。

实测（`test-env/test-smooth.js`，提前 -3 秒连播）：稳态段 drift 依次
-0.13 → -0.084 → -0.053 递减、rate 1.037 → 1.026 → 1.014 → 1，**零 seek**；
仅剩的 seek 都来自 stall 恢复和测试页 loop 重置造成的时间跳变，正常站点没有后者。

恢复/暂停/退出时把 `playbackRate` 复位成 1，别让降速状态残留到下一段音频上。

**stalledByUs 必须和用户暂停分开。** 等待时视频是我们自己 pause 的，下一拍 `syncTick`
会先撞上 `if (videoEl.paused)` 那条分支直接 return —— 所以等待检查必须放在它前面，
否则视频永远放不开。

**放弃时必须降档，不能只放画面。** 只 `play()` 的话下一拍 lead 还是负的，立刻又被按住，
变成「卡四秒、动半秒、再卡四秒」的循环，比一直卡着更难用。所以 `giveUpWait()` 直接算出
`bufferedEnd() - currentTime - 1.2` 能撑住的最大提前量，用 `ui.setValue()` 降到位、
给 SW 发 `setDelay` 同步音频链，再一次恢复。降过一次还撑不住的（`stallGiveUps >= 1`），
第二次直接归零 —— 与其反复降一点卡一段，不如一步到位。`enterEnhanced()` 会把计数清零，
每次重新进双向都给缓冲一次机会。

`exitEnhanced()` / `enhFail()` 里要把画面放开：等待中用户点了停止、或者链路降级，
视频都还停在我们按下的暂停上，不 `play()` 的话用户的视频就永远停住了。

排查用 `adsState` 里新增的两个字段：`stalled`（当前是不是扩展按住的）和
`bufferedLead`（差多少秒）。



> **这一条只在完整版里存在。** 它需要 `debugger` 权限，而该权限既不能在安装时隐藏，也不能改成可选（Chromium 明确把 `debugger` 排除在 `optional_permissions` 之外），安装弹窗上会多出「访问网页调试后端」和「读取并更改所有网站上的所有数据」两条警告。上架版为避开这两条警告把整条链路裁掉，原生 HLS 站点退回链路③。

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
- **标签页一进全屏，调试会话就被掐了**：见下一小节，这是这套机制最容易踩的坑

#### 全屏会把调试会话掐掉

实测于 Edge 151，容器全屏和 `<video>` 全屏都一样：

```
非全屏：attach 后每个切片都有  hit:seq1.ts → fin → body:173580
进全屏后：一条 Network 事件都不再来，页面该请求的切片照常在请求
```

全屏中调用 `chrome.debugger.detach()` 会报 **`Debugger is not attached to the tab`** —— 说明会话在进入全屏的那一刻已经被浏览器断开了，只是没抛错、也没把错误回传给扩展。于此同时 `chrome.debugger.onDetach` 不一定会通知过来，所以"等它告诉我掉线了再重连"这条路走不通。

后果：抓不到片 → 12 秒兜底计时器到点 → **静默降级成链路③**。用户看到的现象就是「本来零流量，一全屏流量翻倍」，而且退出全屏也不会自己回来。

修法是主动重连，`content.js` 里监听 `fullscreenchange`：

```js
document.addEventListener('fullscreenchange', function () {
  if (!window.ADS.enh.isCapturing()) return;   // 不是抓切片链路就别管
  chrome.runtime.sendMessage({ target: 'sw', type: 'captureReattach' });
}, true);
```

SW 那边 `captureReattach()` **必须先 detach 再 attach**：会话可能只是"不送事件"而没真的断开，直接 attach 会报 `Another debugger is already attached`（实测）。

几个细节：

- 必须用 `isCapturing()`（`enhMode === 'capture'`）判断，不能只看 `isEnhanced()`：全屏可能发生在"连接中"（音频还没到手）的时候，那时同样需要重连
- 进出全屏都要重连，两个方向都会断
- 重连时 `capPending` 会清空，正在传输的那一片会丢，不影响后续
- MSE 里已经缓冲的音频不受影响，重连后新片接上就恢复；不会出现"从头再来"
- 上架版没有链路②，`captureReattach` 这个函数压根不存在（`bg-capture.js` 不进包），SW 里用 `typeof` 守卫后才能调用

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
| 触发条件 | 页面用 hls.js / dash.js 等 MSE 播放器 | `video.currentSrc` 是 `.m3u8` 且 mux.js 可用 | ①②都不成立，且 `currentSrc` 是 `.m3u8` / 直连媒体 |
| 数据来源 | `addSourceBuffer` 处截获的 fMP4 片段 | 调试协议取回播放器已下载的 ts，mux.js 转 fMP4 | 浏览器对同一 URL 再解码一遍 |
| 额外带宽 | **零** | **零** | **双倍** |
| 需要的权限 | 站点授权 + 刷新一次 | 站点授权 + `debugger` 权限 | **零权限、零刷新** |
| 副作用 | 无 | 页面顶部「正在调试此浏览器」黄条 | 无明显副作用，只是费流量 |

**`video.currentSrc` 直接是 `.mpd`（`dash`）的页面三条链路都不给。** `<audio src>`
喂不进 DASH 清单，走 ③ 只会白等 15 秒再超时；页面上这种 `src` 本身也播不出画面
（Chrome 没有原生 DASH），真用 dash.js 的站点 `currentSrc` 是 `blob:`，归 ① 管。
所以 `pageKind()` 认出 `dash` 之后，面板直接写「此页不支持双向」，**不能**
让用户去点授权、刷新一轮才发现没用。
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

### 面板归属：接管模式下只能有一个

上面那条只管「脚本注入」这一路。**接管（tabCapture）是整标签页广播 `panel-show`**，每个 frame 各收一份，早期版本每个 frame 都无条件 `reveal()`，于是跨域 iframe 影视站会出现两个面板：播放器那层（有 video，功能完整）和父框架那层（没 video，只会显示「此页不支持双向」）。

现在由每层自行判断该不该出面版，规则三条：

| 这一层 | 行为 |
|---|---|
| 有 `<video>` | 显示，并且 `postMessage` 告诉父框架「我这层有播放器」 |
| 没有 video 的子框架 | 永不显示 |
| 没有 video 的顶层 | 等 1.2 秒，确认没有子框架认领才兜底显示；等待期间收到信号就不显示，已经显示了就收掉 |

关键在于**发信号的和显示面板的是同一批 frame**——只有真的跑着脚本、又有 video 的层才会 `postMessage`。所以「父框架兜底」和「子框架认领」不会同时成立，最多只出一个面板。

兜底那 1.2 秒是必要的：视频在 iframe 里但还没加载完、或者脚本注入比面板显示晚，都可能发生。反过来，如果父框架先画了、子框架后来才报到，父框架会主动 `U.hide()`。

跨域也能用：`window.parent.postMessage(..., '*')` 不受同源限制，多层 iframe 会逐层往上转发。父框架把结果写在 `documentElement.dataset.adsChildVideo` 上，F12 看一眼就知道有没有收到。

`tabCapture` 的延迟模式不受影响——它抓的是整个标签页的混音，音频从哪层框架出来都一样。

### 重复注入：每次接管都要把上一份的监听器收掉

同一个文档会被注入不止一次：点图标 → 停止 → 再点图标、`notifyError` 之后重新接管、
导航完成后的补注入，都是往同一个页面里**再跑一遍**这几个文件。

- 双向模式拆成了五块（core → panel → route → sync → enhance）。**每一块都必须
  自己挡**：`if (E.core) return;` 这样的守卫缺一个，重复注入就会重建 `S`，
  正在跑的 `syncTimer` 引用丢了、旧的停不掉新的又起一个，表现是两路音频同时出声。
  入口 `ads-enhance.js` 额外用 `window.ADS.enh` 挡，因为对外接口只能有一个。
  `init()` 也必须自己防重（`inited` 标记）—— 它会被反复调用，而
  `window.addEventListener('message')` 每调一次就多一条，`seg` / `chunk` 会被
  处理 N 次、MSE 片段被重复 append。
- `content.js` **没有**守卫（上一版就是靠它早退，结果新面板没人接线），所以它每次
  都是新 IIFE。它的 `chrome.runtime.onMessage` 监听器必须由下一份主动摘掉：
  文件开头调 `window.__adsContentTeardown()`，把上一份的监听器和定时器收掉。
  **只收自己的监听器**，不要顺手 `destroy()` 面板 —— 面板已经归新实例管了。
- `ads-ui.destroy()` 清 `window.ADS.ui` 前要先比对身份（`=== api`），
  否则旧实例的销毁会把新实例的引用抹掉，下一次 `ads-ui` 加载时又建一个面板。

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

**面板归属专项验证**（本地 8128，同源与跨域各跑一遍）：

| 场景 | 父框架 | iframe | `dataset.adsChildVideo` |
|---|---|---|---|
| 同源 iframe（`127.0.0.1` 套 `127.0.0.1`） | hidden | visible | `1` |
| 跨域 iframe（`127.0.0.1` 套 `localhost`） | hidden | visible，数字同步到 `4.000` | `1` |
| 整页无 iframe | visible | — | `null` |

跨域那行是关键：iframe 面板上的数字被后台广播的 `panel-show` 改成了 4000，说明消息确实送到了 OOPIF，而父框架**收到了同一条消息却选择不显示**——正是要的行为。

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

### 快捷键（2026-10-21）

**用 `_execute_action` 而不是自定义命令。** `manifest.json` 的 `commands` 里只注册
了 `_execute_action`（Alt+Shift+D）：它是浏览器预留的特殊命令，触发时既授予 `activeTab`
又直接走 `chrome.action.onClicked`，和点图标完全同一条路径 —— `background.js` 里**没有
任何 onCommand 代码**。如果换成自定义命令走 `onCommand`，activeTab 的授予行为在文档里
描述得含糊，没必要冒险。

三个实测结论（Edge 151）：

- **`_execute_action` 里不要写 `description` 字段。** 写了整条被忽略。
- **`chrome.commands.getAll().shortcut` 在 `--load-extension` 下恒为空串，不可信。**
  别拿它判断快捷键有没有注册 —— 快捷键照样能触发（CDP 派发键位实测有效）。
- **`Alt+Shift+A` 不触发，`Alt+Shift+D` 触发。** 其余条件完全相同，只换键位做的
  对照实验 —— A 被 Edge 浏览器层拦截了。选默认键避开它；用户可以在
  `edge://extensions/shortcuts` 里自己改。

**注入失败排查要点（2026-10-21 踩过两回）：**

- **先看标签页是不是错误页。** `executeScript` 报 `Frame with ID 0 is showing error page`
  说明测试服务器没起来或页面加载失败 —— 此时音频流照样能「接管成功」（静音流），
  表现成「start ok 但没有面板」，极易误判成扩展 bug。先用 curl 确认服务 200。
- **`content.js` 清理残留面板只能删别的实例。** ads-ui 在模块加载时就把新面板挂上了，
  content.js 在它之后执行，`getElementById` 拿到的是刚建好的新面板；直接 remove
  会让面板永远不出现（reveal 只改 display，不会重新 append）。正确写法是
  `el !== U.host` 才删。

**加速键本身可靠**：强制 Edge 到前台后，CDP 派发 `Alt+Shift+D` 每次都触发
（`chrome.tabs.get` 能读到 url，说明 activeTab 也授了）。之前怀疑的「偶发失灵」
是上面两个问题叠加造成的误判。

用 CDP 做端到端测试时，`Input.dispatchKeyEvent` 的键位必须和 manifest 里的
`suggested_key` 一致，否则不触发（见 `test-env/test-features.js`）。

***

## 文件

```
manifest.json      MV3 清单
build-info.js      构建标记，只有一行：完整版 capture:true / 上架版 capture:false
background.js      service worker 入口：点图标接管、管理 offscreen、消息路由
bg-auth.js         站点授权与增强脚本注册（permissions.request 的手势约束都在这）
bg-capture.js      原生 HLS 抓切片：chrome.debugger + Network.getResponseBody（仅完整版）
offscreen.html/js  音频处理：getUserMedia → DelayNode → destination
ads-i18n.js        界面文案的多语言：T(key, 中文原文) → 中/英
ads-template.js    面板与提示的样式、结构模板（纯字符串，不碰 DOM）
ads-ui.js          面板、提示条、滑块/滚轮/键盘/拖动/全屏跟随 → window.ADS.ui
ads-detect.js      页面检测：挑 video（全屏感知）、判断播放方式 → window.ADS.detect
ads-enh-core.js    双向模式底座：共享状态 S、常量 C、缓冲几何、音频对齐、链路选择
ads-enh-panel.js   面板文案：链路指示条、可提前几秒、按钮状态 → window.ADS.E.panel
ads-enh-route.js   三条链路的实现：复用 MSE / 抓切片 / 再拉一路 → window.ADS.E.route
ads-enh-sync.js    同步循环：250ms 一拍的对齐、等缓冲、拖进度条 → window.ADS.E.sync
ads-enhance.js     双向模式入口：生命周期、模式切换、对外接口 → window.ADS.enh
content.js         内容脚本入口：消息路由、初始化
inject-main.js     MAIN world：劫持 appendBuffer，复制音频片段给双向模式用
mux.min.js         原生 HLS 那条链路用来把 ts 转成 fMP4（Apache-2.0，仅完整版）
icons/             16 / 32 / 48 / 128 四档图标（make-icons.js 生成）
package.json       npm 脚本（check / lint / test / build / ci）与开发依赖
eslint.config.js   ESLint flat config，只开 no-undef / no-unused-vars
tools/             图标生成、商店素材生成、静态检查、打包、CDP 加载脚本
.github/workflows/ci.yml  CI：check → lint → test → build → 校验产物
_locales/          语言包：zh_CN / en，面板文案与 manifest 的 __MSG__
store/             商店提交材料：文案、截图、隐私政策
dist/              打好的提交包（package.js 产出，完整版与上架版各一份）
```

后台三个模块用 `importScripts` 挂进 SW，和 `background.js` 共用同一个全局环境；
内容脚本几个文件则是靠 manifest 的顺序加载，通过 `window.ADS` 串起来。

### 界面文案

面板、提示条、扩展名和简介都有中英两套，**跟着浏览器的界面语言自动切换**
（`chrome.i18n.getUILanguage()`，`zh*` 走中文，其余走英文），没有手动开关。

三处配合：

| 位置 | 作用 |
| --- | --- |
| `_locales/<locale>/messages.json` | 文案表。`zh_CN` 是默认语言，只要放 manifest 用到的三个键；`en` 放全量 |
| `manifest.json` | `default_locale` + `__MSG_extName__` / `__MSG_extDesc__` / `__MSG_actionTitle__` |
| `ads-i18n.js` | 暴露 `window.ADS.i18n.t(key, 中文原文)`，各模块加载时解构成 `T` |

**写新文案**：`T('someKey', '这里写中文')`，然后往 `_locales/en/messages.json` 加一条
同名条目。中文不查表、直接用第二个参数——中文永远是"源码里写什么就显示什么"，
不会因为漏改语言包而回退成旧文案。

**缺翻译怎么办**：`t()` 查不到就用中文原文，界面上永远不会出现一个 `key` 名字。
`npm test` 的 `[19]` 会核对「代码里用到的每个 key 都在 `en` 里有条目」，漏了直接红。

**加第三种语言**：在 `_locales/<locale>/messages.json` 复制一份 `en` 的键、翻译值，
再把 `ads-i18n.js` 里的 `lang` 判定从「中/英两种」改成按语言表匹配。键名必须是
ASCII——Chrome 不接受中文键名。

**`ads-template.js` 里的 `var T` 不能写成 `const`**：注入是按文件逐个执行的、
共享同一个全局作用域，同一个文件被注入第二次时，顶层 `const` 会抛
`Identifier 'T' has already been declared`，整份模板不执行——面板失去全部样式和结构，
而页面上看不到任何异常。`[20]` 这条用例就是防这个的。

***

## 开发

### 常用命令

```bash
npm install          # 只装开发依赖：eslint + globals
npm run check        # 语法 / JSON / 版本一致性 / 注入清单里的文件是否存在
npm run lint         # 只开 no-undef 和 no-unused-vars 两条规则
npm test             # 离线单测：模块装配、注入清单、静音恢复、监听器清理…
npm run build        # 打完整版 + 上架版到 dist/
npm run ci           # 上面四步串起来，和 GitHub Actions 跑的是同一套
```

`npm test` **不启浏览器**，所以能在 CI 里跑。需要真机验证时用
`test-env/` 下的脚本（不进仓库）：

```bash
node tools/serve-hls.js                                   # 本地 HLS 测试台，端口 8127
node test-env/diag-zero.js                                # 本地链路② 归零诊断
PAGE_URL="https://…" AUTHORIZE=1 node test-env/realtest.js # 真实站点验收
```

几个环境变量：`RESET_PROFILE=1` 重置测试 profile（默认复用，避免每次重建几十 MB）、
`CLEAN_PROFILE=1` 跑完删掉、`STAGE=inspect` 只看页面结构、`NO_EXT=1` 不加载扩展做对照。

### 为什么 lint 只开两条规则

拆分 `ads-enhance.js` 时，一句 `routeWhy` 漏了 `S.` 前缀，点「启用双向」直接
ReferenceError —— 这正是 `no-undef` 能当场抓住的问题。风格类规则一律不开：
这个项目有自己的排版习惯，规则一多，真正的报错会被埋掉。

Service Worker 的三个文件（`background.js` / `bg-auth.js` / `bg-capture.js`）由
`importScripts` 共享同一个全局作用域，ESLint 却是按文件分析的。所以每个文件顶部
用 `/* global … */` 和 `/* exported … */` 显式声明跨文件符号 —— **改导出时记得
同步那份清单**，否则 CI 会报 no-undef。

### CI 校验产物那一步在防什么

以前踩过两次：`dist/` 没重新打包、测试跑的其实是旧构建；以及上架包里混进了
抓切片能力。所以 `.github/workflows/ci.yml` 打完包会断言：

- 上架版没有 `bg-capture.js` / `mux.min.js` / `debugger` 权限，`build-info.js` 里
  `capture: false`；
- 完整版三样都在。

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

打提交包（一次出两个，见下节）：

```bash
node tools/package.js
# → dist/audio-delay-sync-<version>.zip         完整版
# → dist/audio-delay-sync-<version>-store.zip   上架版
```

### 两个构建：完整版与上架版

差别只有链路② 一条，理由是 `debugger` 权限要付的代价：

| | 完整版 | 上架版 |
|---|---|---|
| 链路 | ① ② ③ | ① ③ |
| `debugger` 权限 | 有 | **无**（5 项权限） |
| 安装时警告 | 多两条（调试后端 + 全站数据） | 只有常规几项 |
| 打包体积 | 227 KB | 95 KB（不含 mux.js） |
| 适用 | 自用、GitHub 直接发 | Edge 加载项商店 |

**只有一份源码。** 分支开关是 `build-info.js` 里的这一行：

```js
globalThis.ADS_BUILD = { capture: true };   // 打包时由 package.js 改成 false
```

`package.js` 对上架版做四件事，其余代码一个字不动：改这一行、从 manifest 删掉 `debugger`、把 `bg-capture.js` 和 `mux.min.js` 剔出包、连带去掉 mux.js 的 Apache 许可文件。

代码里读这个标记的地方只有三处，都很短：

- `ads-enh-core.js` 的 `captureEnabled()` —— `pickRoute()` 里 `capture` 那条判断前面加它，面板按钮文案、链路编号也跟着切
- `background.js` —— `importScripts('bg-capture.js')` 只在 `capture !== false` 时执行；消息路由给 `captureStart/captureStop` 加了 `typeof` 兜底，避免上架版里调用不存在的函数
- `bg-auth.js` 的 `contentScriptFiles()` —— 不再列 `mux.min.js`。上架版本就没有这个文件；完整版也改成进链路② 之前按需注入（`background.js` 的 `loadMux()`），避免每个授权页面的每个 iframe 都在 `document_start` 解析 112KB

`package.js` 对上架版额外做两道闸：包内任何 `.js` 出现 `chrome.debugger` 就失败；`mux.min.js` 出现在清单里也失败。所以「忘了改标记」不可能静默打出一个自称上架、实际带调试权限的包。

两个包用同一个版本号，不要同时装进同一个浏览器 —— 扩展 ID 不同，会被当成两个扩展。

跑点击行为测试（把 `chrome.*` 全 mock 掉，验证状态机）：

```bash
node tools/test-toggle.js    # 点图标的状态机
node tools/test-inject.js    # appendBuffer 劫持与数据复制
node tools/test-pagekind.js  # 播放方式判定（MSE / 原生 HLS / 直连 / 未知）
node tools/test-modules.js   # 双向模式五个模块的装配顺序、重复注入、依赖缺失
```

> 覆盖：首点接管、再点停止、换标签页先拆旧的、捕获被拒要提示且不留残留状态、页面不允许注入时退回图标角标、延迟值落盘、标签页关闭自动收尾。

> `package.js` 会在打包前做一轮清单检查：MV3、名称/描述长度、禁用词（不得出现其他浏览器名）、四档图标齐全、`update_url` 必须不存在、以及**每一项权限都能在代码里找到调用依据**。任何一项不过直接退出。

> ⚠ `getMediaStreamId` 校验的是「扩展是否被用户在**当前页面**调用过」，CDP 的 `Runtime.evaluate` 即使带 `userGesture: true` 也不算。所以**捕获这一步无法自动化**，必须真人点一次工具栏图标。这一点没有绕过方式，是 activeTab 的安全边界。

### 远程仓库

| 远程 | 地址 | 说明 |
|---|---|---|
| `origin` | `gitee.com/the-chicken-god-comes/AudioDelaySync` | 主仓，`master` 默认追踪它，裸 `git push` 推这里 |
| `github` | `github.com/cxknotjj/web-av-sync` | GitHub 镜像，用于对外分发 |

两个一起推：

```bash
git pushall        # 配置在 .git/config 的别名，等价于 origin + github 各推一次
```

> 别名只存在于本机 `.git/config`，克隆出来的仓库没有。换机器时补一条：
> `git config alias.pushall '!git push origin master && git push github master'`

***

## 发布到 Edge 加载项商店

注册免费（Partner Center → Edge 计划），审核通常 3\~7 个工作日。

**上传的是上架版：`dist/audio-delay-sync-<version>-store.zip`**，不是完整版。它没有 `debugger` 权限，安装警告少两条，体积也小一半。完整版留给自用和 GitHub 分发。

同一个 zip 也能直接投 Chrome 商店（`chrome.*` API 与 manifest 在两边完全一致），要改的只有商店侧的信息：

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
| `kind` | 播放方式：`mse` / `hls` / `dash` / `direct` / `stream` / `unknown` / `none` |
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
| 全屏前正常、全屏后只剩 `attach-ok` 不再有新事件 | **浏览器把调试会话掐了** | 见「全屏会把调试会话掐掉」，`fullscreenchange` 里已自动重连；如果还断，看 SW 里 `captureReattach` 的返回值 |
| 页面顶部黄条一直挂着、再点启用双向报 `Another debugger is already attached` | 上一轮抓取失败时没 detach（`sourceopen` 建 SourceBuffer 抛错那条分支漏了） | 已修：`enhFail()` 在 `enhMode === 'capture'` 时统一发 `captureStop`，超时降级不再重复发 |

**`mux: false` 在还没进链路② 时是正常的**

mux.js 现在是按需注入：`pickRoute()` 不再看 `typeof muxjs`，`startNativeCapture()` 先调 `ensureMux()` → SW 的 `loadMux()`，拿到 ok 才开调试通道。所以 `adsState.mux` 在点「启用双向」之前一直是 false，不是故障。

如果已经进了链路② 仍显示 `mux: false`，说明这一层没有对应的 host 权限、`chrome.scripting.executeScript` 注入失败。它会走 fallback 降到③，面板上看到的是「重新拉一路」。

这份清单只有一处权威来源：`bg-auth.js` 的 `contentScriptFiles()`。**它同时供两条注入路径使用**（点图标后的 `chrome.scripting.executeScript`、站点授权后的 `registerContentScripts`）。以前 `background.js` 自己维护过一份 `CONTENT_SCRIPTS` 常量，两套清单走岔过一次：同一条链路只有走某一条注入路径时才正常。现在两处都调同一个函数。


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
