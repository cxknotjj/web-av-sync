'use strict';

/* ================================================================
 * 构建标记：这个包是「完整版」还是「上架版」
 *
 * 两个版本只差一处 —— 链路②（用浏览器调试协议抓原生 HLS 的 ts 切片）：
 *
 *   完整版  capture: true   manifest 带 debugger 权限，三条链路都在
 *   上架版  capture: false  manifest 不带 debugger，链路②整个不存在
 *
 * tools/package.js 打上架包时只改这一行的 true → false，其余源码一个字不动。
 * 所以仓库里永远只有一份代码，不存在「两份分支要同步」的问题。
 *
 * 挂在 globalThis 上而不是普通变量：service worker 靠 importScripts 引进来，
 * 内容脚本靠 manifest 的 js 列表引进来，两边都要能读到。
 * ================================================================ */

globalThis.ADS_BUILD = { capture: true };
