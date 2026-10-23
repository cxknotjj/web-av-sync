'use strict';

/* ================================================================
 * 界面文案的多语言（中文 / 英文）
 *
 * 扩展的原始文案是中文，写在调用点的第二个参数里；英文来自
 * _locales/en/messages.json。取不到翻译就退回中文原句 —— 界面上
 * 永远不会露出一个 key 名。
 *
 * 用法：T('uiStop', '停止')
 *   uiStop   messages.json 里的键（只用 ASCII，Chrome 不接受中文键名）
 *   停止     中文原文，也是英文缺失时的兜底
 *
 * 为什么不用 chrome.i18n 直接替换全部文案：_locales 是静态 JSON，没法
 * 表达「'还差 ' + 1.2 + 's'」这种拼接；把原文留在代码里既能读，也能在
 * 翻译缺失时降级，还省掉一次全项目扫描。
 * ================================================================ */

(function () {
  window.ADS = window.ADS || {};
  if (window.ADS.i18n) return;

  let lang = 'zh';
  try {
    const raw = (window.chrome && chrome.i18n && chrome.i18n.getUILanguage())
      || (navigator && navigator.language) || 'zh';
    lang = /^zh/i.test(String(raw)) ? 'zh' : 'en';
  } catch (e) {}

  /**
   * 取一条界面文案。
   * @param {string} key messages.json 里的键
   * @param {string} zh 中文原文（英文缺失时用它）
   * @returns {string}
   */
  function t(key, zh) {
    if (lang === 'zh') return zh;
    let s = '';
    try { s = chrome.i18n.getMessage(key) || ''; } catch (e) {}
    return s || zh;
  }

  window.ADS.i18n = { t: t, lang: lang };
})();
