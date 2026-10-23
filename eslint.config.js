'use strict';

/* ================================================================
 * ESLint 只做两件事：找没用的变量、找没定义的变量。
 *
 * 拆分 ads-enhance.js 那次，`routeWhy` 漏了 `S.` 前缀直接抛 ReferenceError，
 * 点「启用双向」就炸 —— 正是 no-undef 能当场抓住的那类问题。
 * 其余风格规则先不开：这个项目有自己的排版习惯，一上来堆规则只会
 * 把真正的报错埋掉。
 * ================================================================ */

const globals = require('globals');

module.exports = [
  {
    ignores: [
      'dist/**',
      'test-env/**',        /* 本机脚手架，不进仓库 */
      'node_modules/**',
      'mux.min.js'          /* 第三方压缩包 */
    ]
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        ...globals.webextensions,
        ...globals.serviceworker,
        /* build-info.js 写在 globalThis 上的构建标记 */
        ADS_BUILD: 'readonly',
        /* mux.min.js 注入后才有（链路② 按需加载） */
        muxjs: 'readonly'
        /* Service Worker 三个文件之间的跨文件符号不写在这里：
           各自文件顶部的 global / exported 注释才是唯一口径 */
      }
    },
    rules: {
      /* args / caughtErrors 都放宽：回调签名要跟事件对齐，用不到的参数很常见；
         这个项目里 `catch (e) {}` 是有意的静默（扩展上下文随时可能失效），
         真正没用的变量仍然会被抓出来。 */
      'no-unused-vars': ['error', {
        args: 'none',
        caughtErrors: 'none',
        varsIgnorePattern: '^_'
      }],
      'no-undef': 'error'
    }
  },
  {
    /* 构建/测试脚本跑在 Node 里 */
    files: ['tools/**/*.js', 'eslint.config.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node }
    }
  }
];
