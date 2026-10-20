'use strict';

/* ================================================================
 * 面板与提示的样式常量
 *
 * 抽出来的原因：两个 shadow root 的内联 CSS 有 270 多行，
 * 混在逻辑里会把 content.js 撑到看不出结构。
 * 这里只放字符串，不碰 DOM。
 * ================================================================ */

window.ADS_STYLE = {
  /* 提示条用 ok / 失败两套配色，所以做成函数 */
  toast: function (ok) {
    const accent = ok ? '#3fb950' : '#f85149';
    const bg = ok ? 'rgba(10, 18, 13, .96)' : 'rgba(20, 14, 14, .96)';
    const edge = ok ? 'rgba(63, 185, 80, .45)' : 'rgba(248, 81, 73, .45)';
    return `
      <style>
    :host {
      all: initial;
      position: fixed;
      top: 20px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 2147483647;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
    }
    .toast {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      max-width: 460px;
      padding: 11px 12px 11px 14px;
      border-radius: 9px;
      background: ${bg};
      border: 1px solid ${edge};
      box-shadow: 0 8px 28px rgba(0, 0, 0, .45);
      color: #e6edf3;
      font-size: 12.5px;
      line-height: 1.55;
    }
    .bar {
      width: 2px;
      align-self: stretch;
      border-radius: 1px;
      background: ${accent};
      flex: none;
    }
    .txt { flex: 1; user-select: text; }
    .x {
      flex: none;
      width: 18px;
      height: 18px;
      padding: 0;
      border: 0;
      border-radius: 4px;
      background: transparent;
      color: #8b949e;
      font-size: 14px;
      line-height: 1;
      cursor: pointer;
      font-family: inherit;
    }
    .x:hover { background: rgba(255, 255, 255, .1); color: #e6edf3; }
      </style>
      <div class="toast">
        <span class="bar"></span>
        <span class="txt"></span>
        <button class="x" type="button" title="关闭">×</button>
      </div>`;
  },

  panel: `
    <style>
    :host {
      all: initial;
      position: fixed;
      right: 18px;
      bottom: 18px;
      z-index: 2147483647;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
      -webkit-font-smoothing: antialiased;
    }

    .panel {
      width: 268px;
      border-radius: 10px;
      background: rgba(15, 18, 22, .94);
      backdrop-filter: blur(12px);
      border: 1px solid rgba(255, 255, 255, .09);
      box-shadow: 0 8px 28px rgba(0, 0, 0, .45);
      color: #e6edf3;
      overflow: hidden;
      user-select: none;
    }

    .head {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px 10px;
      cursor: move;
      background: rgba(255, 255, 255, .03);
      border-bottom: 1px solid rgba(255, 255, 255, .06);
    }

    .dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #3fb950;
      flex: none;
    }

    .title {
      font-size: 11.5px;
      font-weight: 500;
      letter-spacing: .2px;
      color: #e6edf3;
    }

    .grow { flex: 1; }

    .icon {
      width: 18px;
      height: 18px;
      border: 0;
      border-radius: 4px;
      background: transparent;
      color: #8b949e;
      cursor: pointer;
      font-size: 13px;
      line-height: 1;
      padding: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: inherit;
    }

    .icon:hover { background: rgba(255, 255, 255, .08); color: #e6edf3; }

    .body { padding: 10px 12px 11px; }

    .panel.collapsed .body { display: none; }

    .readout {
      display: flex;
      align-items: baseline;
      justify-content: center;
      gap: 3px;
      margin-bottom: 8px;
    }

    .num {
      font: 500 25px/1.1 ui-monospace, "SF Mono", Consolas, monospace;
      font-variant-numeric: tabular-nums;
      letter-spacing: -.5px;
      color: #8b949e;
      transition: color .18s;
    }

    .num.pos { color: #22d3ee; }

    .unit { font-size: 11px; color: #6b7280; }

    input[type="range"] {
      -webkit-appearance: none;
      appearance: none;
      width: 100%;
      height: 16px;
      background: transparent;
      cursor: pointer;
      display: block;
      margin: 0;
    }

    input[type="range"]::-webkit-slider-runnable-track {
      height: 3px;
      border-radius: 2px;
      /* 两段填充：从 0 点向上界画，negative 时就是中点往左 */
      background: linear-gradient(to right,
        rgba(255,255,255,.12) 0%, rgba(255,255,255,.12) var(--lo, 50%),
        rgba(34,211,238,.85) var(--lo, 50%), rgba(34,211,238,.85) var(--hi, 50%),
        rgba(255,255,255,.12) var(--hi, 50%), rgba(255,255,255,.12) 100%);
    }

    input[type="range"]::-webkit-slider-thumb {
      -webkit-appearance: none;
      width: 12px;
      height: 12px;
      margin-top: -4.5px;
      border-radius: 50%;
      background: #e6edf3;
      border: 2px solid #22d3ee;
    }

    .steps {
      display: grid;
      grid-template-columns: repeat(5, 1fr);
      gap: 4px;
      margin: 8px 0 0;
    }

    .steps button {
      padding: 4px 0;
      font-size: 10.5px;
      color: #8b949e;
      background: rgba(255, 255, 255, .05);
      border: 1px solid rgba(255, 255, 255, .07);
      border-radius: 4px;
      cursor: pointer;
      font-family: inherit;
    }

    .steps button:hover { color: #e6edf3; background: rgba(255, 255, 255, .1); }

    .mode {
      display: flex;
      align-items: center;
      gap: 6px;
      margin: 7px 0 0;
    }

    .mode-tag {
      padding: 2px 7px;
      border-radius: 4px;
      background: rgba(255, 255, 255, .06);
      color: #8b949e;
      font-size: 10px;
    }

    .mode-tag.enh {
      background: rgba(34, 211, 238, .16);
      color: #22d3ee;
    }

    .mode-btn {
      margin-left: auto;
      padding: 3px 9px;
      font-size: 10px;
      font-family: inherit;
      color: #8b949e;
      background: transparent;
      border: 1px solid rgba(255, 255, 255, .12);
      border-radius: 4px;
      cursor: pointer;
    }

    .mode-btn:hover { color: #e6edf3; border-color: rgba(255, 255, 255, .26); }
    .mode-btn[hidden] { display: none; }

    .meter {
      height: 2px;
      margin-top: 9px;
      border-radius: 1px;
      background: rgba(255, 255, 255, .07);
      overflow: hidden;
    }

    .bar {
      height: 100%;
      width: 0;
      background: #3fb950;
      transition: width .12s linear;
    }

    .foot {
      display: flex;
      align-items: center;
      margin-top: 9px;
      gap: 8px;
    }

    .tip {
      font-size: 10px;
      color: #6b7280;
      flex: 1;
      line-height: 1.4;
    }

    .stop {
      padding: 4px 10px;
      font-size: 10.5px;
      color: #f85149;
      background: transparent;
      border: 1px solid rgba(248, 81, 73, .35);
      border-radius: 4px;
      cursor: pointer;
      font-family: inherit;
      flex: none;
    }

    .stop:hover { background: rgba(248, 81, 73, .1); }
    </style>

    <div class="panel">
      <div class="head">
        <span class="dot"></span>
        <span class="title">音画偏移</span>
        <span class="grow"></span>
        <button class="icon" data-act="collapse" title="收起">−</button>
        <button class="icon" data-act="close" title="停止并关闭">×</button>
      </div>
      <div class="body">
        <div class="readout">
          <span class="num" data-el="num">0.000</span>
          <span class="unit">s</span>
        </div>
        <input type="range" min="-10000" max="10000" step="100" value="0" data-el="slider">
        <div class="steps">
          <button data-step="-1000">−1s</button>
          <button data-step="-100">−100</button>
          <button data-step="0">归零</button>
          <button data-step="100">+100</button>
          <button data-step="1000">+1s</button>
        </div>
        <div class="mode">
          <span class="mode-tag" data-el="modeTag">延迟</span>
          <button class="mode-btn" data-act="mode" data-el="modeBtn" hidden>启用双向</button>
        </div>
        <div class="meter"><div class="bar" data-el="bar"></div></div>
        <div class="foot">
          <span class="tip" data-el="tip">滚轮 / ←→ 微调 100ms</span>
          <button class="stop" data-act="stop">停止</button>
        </div>
      </div>
    </div>`
};
