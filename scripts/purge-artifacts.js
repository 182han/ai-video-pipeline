#!/usr/bin/env node
// ==========================================
// 清理运行时垃圾产物（默认 dry-run）
// ==========================================
// 清理范围（2026-11-15 用户确认）：
//   1) output/ 下验收/试验子目录（verify_*、v31-*、real-test-*、_video_probe 等）
//   2) output/ 顶层中间产物（*_concat / *_loop / *_master.mp4）
//   3) clips/ 里没有被任何任务或片段库引用的孤儿文件
//   4) data/spike/（试验残留）
//
// 绝不碰：
//   · 终片（*_final.mp4 / *.bgm.mp4）与剪辑导出（proj_*_edit_*.mp4）
//   · data/keep（手工备份）、data/library、data/photos、data/tasks
//   · clips/_samples（演示样片）
//
// 模式：
//   node scripts/purge-artifacts.js                 # 演练，只打印
//   node scripts/purge-artifacts.js --apply         # 移到 data/trash/artifacts/<ts>/（可人工找回）
//   node scripts/purge-artifacts.js --hard --apply  # 直接删除（不可恢复）

const fs = require('fs');
const path = require('path');

const APP_DIR = path.join(__dirname, '..');
const OUTPUT_DIR = path.join(APP_DIR, 'output');
const CLIPS_DIR = path.join(APP_DIR, 'clips');
const TASKS_DIR = path.join(APP_DIR, 'data', 'tasks');
const LIB_DIR = path.join(APP_DIR, 'data', 'library');
const SPIKE_DIR = path.join(APP_DIR, 'data', 'spike');
const TRASH_ROOT = path.join(APP_DIR, 'data', 'trash', 'artifacts');

const APPLY = process.argv.includes('--apply');
const HARD = process.argv.includes('--hard');

const DIR_PATTERNS = [
  /^verify_/i, /^_verify_/i, /^_tmp_verify$/i, /^_video_probe$/i,
  /^real-test/i, /^v31-/i, /^llm-latency/i, /^previews-1080$/i, /^final-image-set-review$/i
];

function sizeOf(p) {
  try {
    const st = fs.statSync(p);
    if (st.isFile()) return st.size;
    return fs.readdirSync(p).reduce((n, name) => n + sizeOf(path.join(p, name)), 0);
  } catch (e) { return 0; }
}

function collectRefs() {
  const refs = new Set();
  const addPath = (p) => { if (p) refs.add(path.basename(String(p))); };
  if (fs.existsSync(TASKS_DIR)) {
    for (const f of fs.readdirSync(TASKS_DIR)) {
      if (!f.endsWith('.json')) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, f), 'utf8'));
        addPath(j.outputPath); addPath(j.masterPath); addPath(j.loopPath); addPath(j.concatPath);
        for (const c of (j.clips || [])) { addPath(c.videoPath); addPath(c.trimmedPath); }
      } catch (e) { /* ignore */ }
    }
  }
  if (fs.existsSync(LIB_DIR)) {
    for (const f of fs.readdirSync(LIB_DIR)) {
      if (!f.endsWith('.json')) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(LIB_DIR, f), 'utf8'));
        addPath(j.fileName); addPath(j.filePath);
      } catch (e) { /* ignore */ }
    }
  }
  return refs;
}

function listTargets() {
  const out = [];
  const refs = collectRefs();
  if (fs.existsSync(OUTPUT_DIR)) {
    for (const name of fs.readdirSync(OUTPUT_DIR)) {
      const p = path.join(OUTPUT_DIR, name);
      let st; try { st = fs.statSync(p); } catch (e) { continue; }
      if (st.isDirectory() && DIR_PATTERNS.some(re => re.test(name))) {
        out.push({ category: 'output-验收目录', path: p, bytes: sizeOf(p) });
      } else if (st.isFile() && /\.mp4$/i.test(name)
        && (/_(concat|loop|master)\.mp4$/i.test(name) || /_bgm_\d+\.mp4$/i.test(name))
        && !refs.has(name)) {
        // 中间产物：拼接/循环/母版 + 逐段配乐中间文件；被任务引用的不删
        out.push({ category: 'output-中间产物', path: p, bytes: st.size });
      }
    }
  }
  if (fs.existsSync(CLIPS_DIR)) {
    for (const name of fs.readdirSync(CLIPS_DIR)) {
      if (name === '_samples') continue;
      const p = path.join(CLIPS_DIR, name);
      let st; try { st = fs.statSync(p); } catch (e) { continue; }
      if (!st.isFile()) continue;
      if (!refs.has(name)) out.push({ category: 'clips-孤儿文件', path: p, bytes: st.size });
    }
  }
  if (fs.existsSync(SPIKE_DIR)) {
    for (const name of fs.readdirSync(SPIKE_DIR)) {
      const p = path.join(SPIKE_DIR, name);
      out.push({ category: 'data/spike', path: p, bytes: sizeOf(p) });
    }
  }
  return out;
}

function summarize(targets) {
  const byCat = new Map();
  for (const t of targets) {
    if (!byCat.has(t.category)) byCat.set(t.category, { count: 0, bytes: 0 });
    const c = byCat.get(t.category); c.count++; c.bytes += t.bytes;
  }
  return byCat;
}

function fmtMB(n) { return (n / 1048576).toFixed(1) + ' MB'; }

function main() {
  console.log(`模式: ${HARD ? 'HARD（直接删除）' : (APPLY ? 'APPLY（移到回收目录）' : 'DRY-RUN（只打印）')}`);
  const targets = listTargets();
  const byCat = summarize(targets);
  let total = 0;
  for (const [cat, v] of byCat) {
    total += v.bytes;
    console.log(`${cat}: ${v.count} 项, ${fmtMB(v.bytes)}`);
  }
  console.log(`合计: ${targets.length} 项, ${fmtMB(total)}`);

  if (!APPLY) {
    console.log('\n示例（前 12 项）：');
    for (const t of targets.slice(0, 12)) console.log('  - ' + path.relative(APP_DIR, t.path));
    console.log('\n这是演练。确认无误后加 --apply；彻底删除再加 --hard。');
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const trashDir = path.join(TRASH_ROOT, stamp);
  if (!HARD) fs.mkdirSync(trashDir, { recursive: true });
  const manifest = { at: new Date().toISOString(), hard: HARD, total, items: [] };

  let ok = 0, fail = 0;
  for (const t of targets) {
    const rel = path.relative(APP_DIR, t.path);
    try {
      if (HARD) {
        fs.rmSync(t.path, { recursive: true, force: true });
      } else {
        const dest = path.join(trashDir, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.renameSync(t.path, dest);
        manifest.items.push({ from: rel, to: path.relative(APP_DIR, dest), bytes: t.bytes, category: t.category });
      }
      ok++;
    } catch (e) {
      fail++;
      console.error(`失败 ${rel}: ${e.message}`);
    }
  }

  if (!HARD) {
    fs.writeFileSync(path.join(trashDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    console.log(`\n已移入: ${path.relative(APP_DIR, trashDir)}（附 manifest.json，可人工找回）`);
  } else {
    console.log('\n已直接删除（不可恢复）。');
  }
  console.log(`完成：成功 ${ok} 项，失败 ${fail} 项；${HARD ? '释放' : '移出原目录'} ${fmtMB(total)}${HARD ? '' : '（空间要彻底删除回收目录后才释放）'}。`);
  if (fail) process.exit(1);
}

main();
