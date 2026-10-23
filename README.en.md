# Audio Delay Sync

**English** · [简体中文](README.md)

A browser extension that adds an adjustable delay to **the current tab's audio**, to fix audio/video desync.

It doesn't replace the player, touch the seek bar, or change video quality — it only delays the audio that finally reaches your speakers. How much delay and when to stop are controlled from a panel in the bottom-right corner of the page.

![In use](store/screenshot-4-live-delay.png)

<sub>The player keeps working; a panel appears in the bottom-right corner.</sub>

***

## When you need it

Audio arriving a little after the picture is always awkward. Common causes:

| Scenario | Typical delay |
| --- | --- |
| Bluetooth headphones / speakers | 100–300 ms |
| Casting to a TV or projector | tens to hundreds of ms |
| External sound card, DSP, amplifier | depends on the device |
| The player's own A/V desync | varies |

Nudge the number up while watching the lips, until they match.

***

## Installation

**From the store (recommended)**: [Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/dppjkonmajnmkgepepheieignphmbkfe)

The store build is the **lighter build** (no Route ②; native HLS sites fall back to Route ③). See [Two builds](#two-builds) below.

**From source**

1. Download this repository (`git clone`, or download and unzip)
2. Open `edge://extensions` (`chrome://extensions` in Chrome)
3. Turn on **Developer mode** (top-right)
4. Click **Load unpacked** and select the repository directory
5. Pin the extension icon to the toolbar

Requires Chromium **116 or later**.

***

## How to use

1. Open a video page and **let it start playing** — the extension can't take over a tab that isn't producing sound
2. **Click the toolbar icon** (or press `Alt+Shift+D`); audio is handed to the extension and the panel appears in the bottom-right corner
3. Drag the slider or scroll the wheel until sound matches the lips
4. Click the icon again (or press the shortcut again) to stop; audio returns to the page immediately

Drag the panel anywhere; click `−` to collapse it into a strip, `×` to stop and close.

The shortcut can be changed on the browser's extension shortcuts page (`edge://extensions/shortcuts`). No need to leave fullscreen to find the icon.

### What's on the panel

| Element | Purpose |
| --- | --- |
| Big number | Current delay in seconds. A minus sign means audio is advanced |
| Slider | Drag to adjust, range −10 s to +10 s |
| `−1s` `−100` `Reset` `+100` `+1s` | Quick presets |
| Level meter | Moves when there's sound, still when there isn't. **Use it as the only indicator of output**, not the page's own volume bar |
| Hint text | Current mode and whether this page supports bidirectional mode. In bidirectional mode a route indicator is added, with the right side showing "safe advance" or the current status |
| Stop | End the takeover; audio returns to the page |

### Three ways to adjust

- **Drag the slider**: click and drag
- **Mouse wheel**: with the pointer over the panel, one notch = 100 ms, hold `Shift` for 1 s. Scroll up = larger value (audio later). Affects the panel only and never scrolls the page
- **Keyboard**: while hovering the panel, `←` `→` step 100 ms, `Shift + ←/→` step 1 s, `Home` resets to zero. Only active on hover, so it won't fight the player's own arrow keys

***

## Advancing audio (bidirectional mode)

By default the extension can only make audio **later**. It captures audio the browser has already rendered — there is no "future" audio in that stream, so it physically can't push it earlier.

Bidirectional mode takes a different approach: it grabs audio the **page has already downloaded but not yet played**, and plays it earlier. That requires the video to be a streaming source ("download while playing"), not a fully downloaded file.

### How to enable

1. Start the video
2. Click the icon to take over; the panel shows "Bidirectional needs authorization"
3. Click it and choose **Allow** in the browser prompt
4. The page reloads automatically; click "Enable bidirectional" on the panel

If the panel shows "Refresh page to apply" instead of "Bidirectional needs authorization", the site was authorized before but the script missed this page load. Clicking the button fixes it and reloads — no prompt this time.

### What you'll see

A route indicator tells you which path is in use and what it costs:

| Display | Meaning |
| --- | --- |
| `① Reuse page segments — zero traffic` | Cheapest. The page uses an MSE player (hls.js and the like) |
| `② Capture downloaded segments — zero traffic` | Also no extra download. The browser shows an "is debugging this browser" bar at the top of the page |
| `③ Fetch a second stream — ~2× traffic` | Fallback. This one really downloads the data again |

The right side also shows "safe advance N s" — how far audio can currently be moved earlier. It depends on how far ahead the buffer reaches, so it isn't fixed. While aligning or waiting for data, this area shows status text such as "aligning…" or "audio reloading, video continues".

**What is that "is debugging this browser" bar?** The browser shows it; the extension can't hide it. It means the extension is reading segment data the page has already downloaded — that channel is the only way to reach those bytes. It disappears when you leave bidirectional mode.

### Cost

- ①② use no extra traffic; ③ roughly doubles it
- While bidirectional mode is active, the page's original video is muted and sound comes from the extension's pipeline
- Audio can only be advanced to what has already been downloaded; going further stalls waiting for data

### What happens when the buffer can't keep up

What happens depends on the route.

**Routes ① and ③**: the extension **holds both picture and sound**, waiting for segments to download, instead of letting the picture run on with no sound. During the wait the panel shows "waiting for buffer · N s to go"; a shrinking number means downloading is healthy, and playback resumes when enough data arrives. If the panel is collapsed or hidden in fullscreen, a toast explains "buffer can't keep up with the advance, pausing to download…" (at most once every 20 s).

Two exceptions:

- **Buffer keeps growing**: it keeps waiting; a paused picture is expected.
- **Buffer doesn't move at all** (no new data for a few seconds): the site can't feed that much advance. The extension **automatically lowers the advance to what the buffer can sustain** and resumes; the panel number drops accordingly and a toast appears. To try a larger advance again, let the video buffer longer.

**Route ②**: the picture is **never paused** — this route's data comes from the player's own downloads, so pausing the player would cut off its own data supply. When the buffer can't keep up, audio is re-buffered in the background and the panel shows "audio reloading, video continues"; the picture keeps playing:

- No data after 2 s of silence: the extension automatically lowers the advance to what the buffer can sustain, and sound returns;
- Still not a single segment after 8 s of silence: it automatically degrades to Route ③ (about double traffic) rather than staying silent;
- No degradation during ad breaks: ad segments don't go through this route, and audio reconnects automatically when the main feature returns.

A pause you triggered yourself is unaffected; clicking "Stop" or leaving bidirectional mode resumes the video automatically — it's never left paused.

### After seeking

In bidirectional mode, seeking immediately moves the audio to the new position and **drops the buffer you skipped** — otherwise memory would accumulate data that will never be played again.

If the new position isn't downloaded yet:

- **Routes ① / ③**: the picture is held while waiting, with "waiting for buffer · N s to go" on the panel; playback resumes automatically when data arrives. If nothing arrives within 15 s (the site dropped that range, or you seeked too far), it falls back to the page's own audio with a notice.
- **Route ②**: the picture keeps playing while audio re-buffers in the background, with "audio reloading, video continues"; it reconnects automatically if it can catch up, and degrades to Route ③ after 8 s if it can't — never stuck in silence.

### Two builds

| | Full build | Store build |
|---|---|---|
| Routes | ①②③ | ①③ (no ②) |
| Install warnings | Two extra (debugger backend + all-site data) | Only the usual ones |
| Where | GitHub Releases | [Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/dppjkonmajnmkgepepheieignphmbkfe) |

The only difference is Route ②. It needs the `debugger` permission, whose install warnings ("access the page debugger backend" and "read and change all your data on all websites") are too heavy for the store. On native HLS sites the store build uses Route ③ — the same functionality, just one extra download of that stream.

**Don't install both builds in the same browser** — different extension IDs; they'll be treated as two separate extensions.

### Interface language

The panel, the toasts, the extension name and its description all ship in Chinese and English and follow the **browser's UI language**: a Chinese browser gets Chinese, everything else gets English. There is no separate switch — change the browser's UI language and restart it.

A missing translation falls back to the Chinese original rather than showing a raw `key`. To add a third language, see the "UI strings" section of [`DEVELOPMENT.md`](DEVELOPMENT.md).

***

## FAQ

**I clicked the icon and nothing happened**

Make sure the video **is producing sound**. Muted, paused, or zero-volume tabs can't be captured; a red message at the top of the page explains why.

**It took over, the page's volume bar looks normal, but there's no sound**

That's expected, not a bug. While capturing, the browser force-mutes the tab and sound comes from the extension. Watch the level meter on the panel — if it moves, audio is flowing. If it doesn't, click the page once and try again.

**The panel doesn't appear**

A few pages disallow script injection (browser-internal pages, the extension store, the PDF viewer). Audio can't be captured there anyway; the icon briefly shows a red `!` badge.

**Two panels appeared on the page**

Fixed; builds from 1.0.1 include the fix. On sites that embed the player in an iframe (most video sites), early builds drew one panel per frame: one over the player and one on the blank area beside it that only said "bidirectional not supported on this page". Now it only appears in the frame that actually contains the player. If you still see it, send me the URL.

**I changed the number but hear no difference**

- Make sure the video is playing and the level meter is moving
- Very small delays (tens of ms) are genuinely subtle; try ±1000 ms
- If the number changes while dragging but the sound doesn't move at all, the takeover may have died — stop and take over again

**The panel says "bidirectional not supported on this page"**

No video element was found. The page may still be loading, the player may live in another frame, or the content hasn't loaded. Wait until the page is fully loaded and the video is playing.

**The panel says "bidirectional needs authorization" and clicking it errors**

Authorization must happen inside the click gesture. If clicking does nothing, use the toolbar icon instead — icon clicks always carry a gesture.

**After seeking in bidirectional mode, audio is out of sync**

Fixed in builds from 1.0.1: when the seek bar moves, the extension moves audio to the new position and drops the skipped buffer. Older builds would leave the picture jumped ahead and the sound behind — reload the extension.

**Traffic doubled in bidirectional mode**

That means Route ③ "fetch a second stream" — the fallback when the page has no reusable segments. Hover the indicator to see why: either the site plays a plain mp4 (no segments at all), or segment capture failed and it degraded automatically.

**It can only advance two or three seconds before stalling**

That's the buffer limit. How far you can advance equals how far ahead the video has downloaded. Let it buffer longer to advance more.

**The picture freezes and the panel says "waiting for buffer · N s to go"**

It's not frozen — the extension is holding the picture while segments download (only Routes ① and ③ hold the picture). The requested advance is beyond what's downloaded; letting the picture run would mean "picture with no sound". A shrinking number is normal waiting; if it never changes, the site can't feed that much and the extension lowers the advance automatically after a few seconds.

**The panel says "audio reloading, video continues" and there's no sound**

That's Route ②'s normal intermediate state: after a seek, audio re-buffers in the background while the picture keeps playing. It usually reconnects within seconds; if it can't within 8 s, the extension degrades to Route ③ (about double traffic) rather than staying silent. If it happens often, the site is slow to deliver segments — the extension handles it automatically, no manual action needed.

**I hit reset-to-zero and audio is still slightly behind**

Fixed in 1.0.1 (the zero-delay offset on Route ② was about 1.6 s). If you still see it, check the right side of the panel: "audio reloading, video continues" means audio is re-buffering — just wait for it to reconnect; if it shows "safe advance" but still sounds off, stop and take over again.

**Slight clicking noise**

Delays are smoothed over 60 ms while dragging. Very rapid, large drags can occasionally produce a small artifact — inherent to the audio processing nodes and can't be fully eliminated.

**Switching tabs / going fullscreen**

Switching tabs stops the previous takeover. In fullscreen the panel follows into fullscreen and keeps its position.

***

## Release notes

### 1.0.2

- Segment decoding on Route ② is ~28× faster (11.4 ms → 0.4 ms per 175 KB segment), so high-bitrate sites drop fewer frames
- mux.js now loads only when bidirectional mode starts, instead of being injected into every page and every iframe (112 KB each)
- Iframes without a player on authorised sites no longer poll every 0.4 s, which cuts idle background work noticeably
- While the tab is in the background, state refresh drops from once per second to once every 5 s
- Fixed leaving bidirectional mode overwriting your own mute state: if the player was already muted, or you muted it yourself mid-session, exiting no longer blasts audio
- Repeated stop / take-over cycles no longer accumulate event listeners, so long sessions don't degrade
- The panel's diagnostic fields now include the reason a delay push failed, making "I clicked and nothing happened" much easier to pin down
- Fixed enabling bidirectional after the video has already been playing for a while: the sound got stuck at the start and the mode gave up after ~15 s (MSE players)
- The interface is available in Chinese and English and follows the browser's UI language; in English the extension name, description and every panel string are translated

### 1.0.1

- Route ② now prefers video and lets audio catch up asynchronously: after a seek the picture no longer freezes waiting for buffer; audio catches up in the background and degrades to Route ③ after 8 s if it can't
- Fixed ~1.6 s of residual delay on Route ② after dragging the delay to 0
- Fixed Route ② getting stuck on "audio reloading" with no way out
- Fixed Route ② staying on "audio reloading" after an ad break at the 5-minute mark
- Fixed positive delays being zeroed on the DelayNode, which disabled delaying entirely
- Fixed "safe advance" jumping between 0 and 10 s on the panel
- Fixed Route ① accumulating raw segments during bidirectional playback (unbounded memory growth)
- Fixed two panels appearing when the player is inside an iframe

***

## Known limitations

| Limitation | Notes |
| --- | --- |
| Chromium only | Firefox has no `tabCapture` |
| Delay only by default | Advancing requires bidirectional mode and a streaming page |
| Captures the whole tab | Notification sounds and ads are delayed too; per-track audio isn't possible |
| One tab at a time | Browser limitation |
| Original player is muted while capturing | Expected; see above |
| Browser-internal pages unsupported | Settings pages, extension store, PDF viewer |

***

## Privacy

Collects nothing, uploads nothing. All code ships inside the extension; it works offline.

Audio stays in your computer's memory for exactly as long as you set, then goes to the speakers — never written to disk, never transmitted.

***

## License

[MIT](LICENSE) © 2026 cxknotjj

Use it, modify it, ship it commercially, even closed-source — just keep the copyright notice.

Bundles [mux.js](https://github.com/videojs/mux.js) 7.0.3 (Apache-2.0, © Brightcove, Inc.).
See [`LICENSE-APACHE-2.0.txt`](LICENSE-APACHE-2.0.txt) and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for origin and usage.

***

## Hacking on it / how it works

Implementation details, the full comparison of the three data routes, measured numbers, dev environment setup, and debugging methods are in
[`DEVELOPMENT.md`](DEVELOPMENT.md) (written in Chinese).

Bidirectional mode is split into five modules; injection order is dependency order:

| File | Responsibility |
| --- | --- |
| `ads-enh-core.js` | Shared state and constants, buffer geometry, audio alignment, route selection |
| `ads-enh-panel.js` | Panel text: route indicator, safe advance, state publishing |
| `ads-enh-route.js` | The three routes: reuse MSE / capture segments / fetch a second stream |
| `ads-enh-sync.js` | Sync loop: 250 ms alignment ticks, buffer waits, seeks |
| `ads-enhance.js` | Lifecycle: enter/exit bidirectional mode, failure degradation |

DEVELOPMENT.md also answers questions like "why not just hook fetch" and "why is the debugger required", and lists which values to inspect when debugging bidirectional mode.
