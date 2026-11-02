#!/usr/bin/env node
// 验收：剪映「调节」复刻模块（src/processors/adjustChain.js）
// 纯逻辑，不依赖 ffmpeg 与网络。用法：node scripts/verify-adjust-chain.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const m = require('../src/processors/adjustChain');

const results = [];
const t = (name, fn) => {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, msg: e.message }); }
};

// ---------- 1. 参数白名单 / 注入防护 ----------
t('越界值钳到 ±50', () => {
  const p = m.normalizeParams({ brightness: 999, shadow: -999 });
  assert.strictEqual(p.brightness, 50);
  assert.strictEqual(p.shadow, -50);
});

t('非数字被丢弃（注入防护）', () => {
  assert.strictEqual(m.hasAdjust({ brightness: '1; rm -rf /' }), false);
  assert.strictEqual(m.hasAdjust({ brightness: NaN }), false);
  assert.strictEqual(m.hasAdjust({ brightness: Infinity }), false);
});

t('全 0 / 空参数不算有调节', () => {
  assert.strictEqual(m.hasAdjust({}), false);
  assert.strictEqual(m.hasAdjust(null), false);
  assert.strictEqual(m.hasAdjust({ brightness: 0, contrast: 0 }), false);
});

t('HSL 越界钳到 ±100，非数组置零', () => {
  const p = m.normalizeParams({ hsl: [[200, -300, 0], 'x'] });
  assert.strictEqual(p.hsl[0][0], 100);
  assert.strictEqual(p.hsl[0][1], -100);
  assert.deepStrictEqual(p.hsl[1], [0, 0, 0]);
});

// ---------- 2. 运算正确性 ----------
t('恒等：空参数不改像素', () => {
  const rgb = [0.3, 0.5, 0.7];
  assert.deepStrictEqual(m.adjustChain(rgb, {}), rgb);
  assert.deepStrictEqual(m.adjustChain(rgb, null), rgb);
});

t('亮度 0 为恒等，+50 提亮（中灰 128 → 223）', () => {
  assert.deepStrictEqual(m.brightness([0.2, 0.4, 0.6], 0), [0.2, 0.4, 0.6]);
  const v = Math.round(m.brightness([128 / 255, 128 / 255, 128 / 255], 50)[0] * 255);
  assert.ok(Math.abs(v - 223) <= 2, '实测 ' + v);
});

t('对比度 +50：端点保持、中间拉大', () => {
  const lo = m.contrast([0, 0, 0], 50)[0];
  const hi = m.contrast([1, 1, 1], 50)[0];
  assert.ok(lo <= 0.02 && hi >= 0.98);
});

t('阴影 +50 提亮暗部、白色不变', () => {
  const dark = m.shadow([0.1, 0.1, 0.1], 50)[0];
  const white = m.shadow([1, 1, 1], 50)[0];
  assert.ok(dark > 0.1, '暗部应变亮: ' + dark);
  assert.ok(Math.abs(white - 1) < 1e-6);
});

t('饱和度 -50 时趋近灰（三通道差值缩小）', () => {
  const before = [0.8, 0.2, 0.2];
  const after = m.saturation(before, -50);
  const spread = (v) => Math.max(...v) - Math.min(...v);
  assert.ok(spread(after) < spread(before));
});

// ---------- 3. 产物 ----------
t('buildCubeText：17³ 行数 = 5 + 4913', () => {
  const txt = m.buildCubeText({ shadow: 50 });
  const lines = txt.trim().split('\n');
  assert.strictEqual(lines.length, 5 + 4913);
  assert.strictEqual(lines[1], 'LUT_3D_SIZE 17');
  assert.ok(/^\d\.\d{6} \d\.\d{6} \d\.\d{6}$/.test(lines[5]), '数据行格式: ' + lines[5]);
});

t('escapeFilterPath：盘符冒号必须转义', () => {
  assert.strictEqual(m.escapeFilterPath('C:\\a\\b.cube'), 'C\\:/a/b.cube');
  assert.ok(m.escapeFilterPath('D:\\x y\\z.cube').indexOf('\\:') > 0);
});

t('buildSpatialFilters：只对空间类产出滤镜', () => {
  assert.deepStrictEqual(m.buildSpatialFilters({ brightness: 50 }), []);
  assert.deepStrictEqual(m.buildSpatialFilters({ saturation: 30 }), []);
  assert.strictEqual(m.buildSpatialFilters({ sharpen: 50 }).length, 1);
  assert.strictEqual(m.buildSpatialFilters({ grain: 50 })[0].indexOf('noise='), 0);
  assert.strictEqual(m.buildSpatialFilters({ vignette: 50 })[0].indexOf('vignette='), 0);
});

t('buildSpatialFilters：参数含注入字符时被白名单挡掉', () => {
  const f = m.buildSpatialFilters({ sharpen: '50; rm -rf /' });
  assert.strictEqual(f.length, 0);
});

// ---------- 4. 报告 ----------
let pass = 0;
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  → ' + r.msg}`);
  if (r.ok) pass++;
}
console.log(`\n${pass}/${results.length} 通过`);
process.exit(pass === results.length ? 0 : 1);
