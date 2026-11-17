// ============================================================
// i18n · 词条汇总
// ------------------------------------------------------------
// 每个 namespace 一个文件，导出 { zh, en }；此处静态 import 并深合并。
// 新增屏幕：① 新建 messages/<name>.js；② 在下方 NAMESPACES 里加一行。
// 重复 key 会在控制台告警，并由 scripts/verify-i18n.js 拦截。
// ============================================================
import common from './common.js';
import nav from './nav.js';
import shell from './shell.js';
import settings from './settings.js';
import create from './create.js';
import gen from './gen.js';
import inventory from './inventory.js';
import templates from './templates.js';
import editor from './editor.js';
import tasks from './tasks.js';
import assistant from './assistant.js';
import xiaozhi from './xiaozhi.js';
import createSmart from './createSmart.js';
import bgm from './bgm.js';
import studio from './studio.js';

const NAMESPACES = {
  common,
  nav,
  shell,
  settings,
  create,
  gen,
  inventory,
  templates,
  editor,
  tasks,
  assistant,
  xiaozhi,
  createSmart,
  bgm,
  studio
};

export const messages = { zh: {}, en: {} };

function mergeInto(target, source, ns, locale, path) {
  for (const key of Object.keys(source)) {
    const value = source[key];
    const nextPath = path ? path + '.' + key : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (!target[key] || typeof target[key] !== 'object') target[key] = {};
      mergeInto(target[key], value, ns, locale, nextPath);
      continue;
    }
    if (typeof value !== 'string') {
      console.warn('[i18n] non-string leaf', ns, locale, nextPath);
      continue;
    }
    if (target[key] !== undefined) {
      console.warn('[i18n] duplicate key', nextPath, '(' + ns + '/' + locale + ')');
    }
    target[key] = value;
  }
}

for (const [ns, pack] of Object.entries(NAMESPACES)) {
  mergeInto(messages.zh, pack.zh || {}, ns, 'zh', '');
  mergeInto(messages.en, pack.en || {}, ns, 'en', '');
}

export const NAMESPACE_NAMES = Object.keys(NAMESPACES);
