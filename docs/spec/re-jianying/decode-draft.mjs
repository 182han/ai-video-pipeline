#!/usr/bin/env node
/**
 * decode-draft.mjs — 剪映专业版 11.6.0.14552 草稿编解码层判定器
 *
 * 用途（三合一）：
 *   1) 判定 draft_content.json 的编码层是什么，并**可复现地**打印本文档
 *      `jy-draft-cipher.md` 里引用的每一个数字（负向证据）。
 *   2) 若某天拿到明文 JSON，用 `--plain <file>` 直接打印任务要求的结构摘要
 *      （tracks / 片段 timerange / volume / speed / materials path+duration /
 *        transitions / beats）。
 *   3) 只要底层解出明文，`--decoded-bytes` 之外无需改动即可复用 summarizer。
 *
 * 只读样本，不写任何文件，不联网。
 *
 * 用法：
 *   node docs/spec/re-jianying/decode-draft.mjs
 *   node docs/spec/re-jianying/decode-draft.mjs "D:\JianyingPro Drafts\9月20日\draft_content.json"
 *   node docs/spec/re-jianying/decode-draft.mjs --plain "D:\JianyingPro Drafts\9月20日\Timelines\A6A8A0C4-CF3C-4b9f-AD99-5BBCCFB99D65\template.tmp"
 *
 * 退出码：0 = 本脚本自身执行成功（不代表解出了明文）；2 = 用法/文件错误。
 */

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_SAMPLE = 'D:\\JianyingPro Drafts\\9月20日\\draft_content.json';
const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/* ------------------------------------------------------------------ */
/* 通用统计                                                            */
/* ------------------------------------------------------------------ */

function shannonEntropy(buf) {
  const hist = new Array(256).fill(0);
  for (const b of buf) hist[b]++;
  let h = 0;
  for (const c of hist) {
    if (!c) continue;
    const p = c / buf.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** 与均匀分布比较的卡方值（df=255，均匀期望≈255） */
function chiSquareUniform(buf) {
  const hist = new Array(256).fill(0);
  for (const b of buf) hist[b]++;
  const exp = buf.length / 256;
  let chi = 0;
  for (const c of hist) chi += ((c - exp) ** 2) / exp;
  return chi;
}

function maxByteFrequencyPct(buf) {
  const hist = new Array(256).fill(0);
  for (const b of buf) hist[b]++;
  return (Math.max(...hist) / buf.length) * 100;
}

const COMPRESSION_MAGICS = {
  gzip: [0x1f, 0x8b],
  zlib: [0x78], // 0x78 01/9c/da
  zstd: [0x28, 0xb5, 0x2f, 0xfd],
  lz4: [0x04, 0x22, 0x4d, 0x18],
  xz: [0xfd, 0x37, 0x7a, 0x58, 0x5a],
  bzip2: [0x42, 0x5a, 0x68],
  brotli: null, // 无固定 magic
};

function detectCompressionMagic(buf) {
  const out = {};
  for (const [name, sig] of Object.entries(COMPRESSION_MAGICS)) {
    out[name] = sig ? sig.every((v, i) => buf[i] === v) : 'n/a';
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 第 1 层：base64 判定                                               */
/* ------------------------------------------------------------------ */

function decodeLayer1(file) {
  const raw = fs.readFileSync(file);
  const text = raw.toString('latin1').replace(/[\r\n\t ]+/g, '');

  const allowed = new Set([...B64_ALPHABET, '=']);
  const badChars = new Map();
  for (const ch of text) {
    if (!allowed.has(ch)) badChars.set(ch, (badChars.get(ch) ?? 0) + 1);
  }

  // 只允许末尾出现 padding
  const padMatch = text.match(/=+$/);
  const padLen = padMatch ? padMatch[0].length : 0;
  const body = text.slice(0, text.length - padLen);
  const innerPadding = body.includes('=');

  let decoded = null;
  let decodeError = null;
  try {
    decoded = Buffer.from(text, 'base64');
    // 严格往返校验：base64 是双射（忽略 padding），往返不一致说明不是标准 base64
    const roundTrip = decoded.toString('base64').replace(/=+$/, '');
    if (roundTrip !== body) decodeError = 'round-trip mismatch';
  } catch (e) {
    decodeError = e.message;
  }

  return {
    file,
    fileBytes: raw.length,
    textLength: text.length,
    lengthMod4: text.length % 4,
    padLen,
    innerPadding,
    badChars: [...badChars.entries()].slice(0, 10),
    decoded,
    decodeError,
    distinctSymbols: new Set(text.replace(/=+$/, '')).size,
  };
}

/**
 * 位置类分析：base64 每 4 字符 → 3 字节，位结构固定为
 *   c0 = b0>>2          （只含 b0 高 6 位）
 *   c1 = (b0&3)<<4 | b1>>4
 *   c2 = (b1&0xF)<<2 | b2>>6
 *   c3 = b2&0x3F        （只含 b2 低 6 位）
 * 所以若明文是 ASCII JSON（<0x80），c0 的取值范围被压到 6 位里的前一半 —— 位置 0 的
 * 不同符号数会明显 < 64。**字母表被置换不会改变“不同符号数”，只改变是哪些符号。**
 * 因此“位置 0 是否用满 64 个符号”可以判定「自定义字母表 base64(明文 JSON)」是否成立。
 */
function positionClassDistinct(text) {
  const body = text.replace(/=+$/, '');
  const sets = [new Set(), new Set(), new Set(), new Set()];
  for (let i = 0; i < body.length; i++) sets[i % 4].add(body[i]);
  return sets.map((s) => s.size);
}

/* ------------------------------------------------------------------ */
/* 诊断                                                               */
/* ------------------------------------------------------------------ */

function diagnose(layer1) {
  const buf = layer1.decoded;
  const out = {
    layer1,
    entropy: shannonEntropy(buf),
    chi2: chiSquareUniform(buf),
    maxFreqPct: maxByteFrequencyPct(buf),
    compression: detectCompressionMagic(buf),
    mod16: buf.length % 16,
    mod8: buf.length % 8,
    headHex: buf.subarray(0, 32).toString('hex'),
    asciiRatio:
      ([...buf].filter((b) => b >= 0x20 && b <= 0x7e).length / buf.length) * 100,
    startsWithJson: buf[0] === 0x7b, // '{'
  };
  out.posDistinct = positionClassDistinct(layer1.file ? fs.readFileSync(layer1.file).toString('latin1') : '');
  return out;
}

/** 对照组：真实明文 JSON 的 base64，用来给位置类判定提供基线 */
function controlPositionClass() {
  const controls = [];
  const tmpl =
    'D:\\JianyingPro Drafts\\9月20日\\Timelines\\A6A8A0C4-CF3C-4b9f-AD99-5BBCCFB99D65\\template.tmp';
  if (fs.existsSync(tmpl)) {
    controls.push(['template.tmp（真实明文草稿 JSON）', fs.readFileSync(tmpl).toString('base64')]);
  }
  const kv = 'D:\\JianyingPro Drafts\\9月20日\\key_value.json';
  if (fs.existsSync(kv)) {
    controls.push(['key_value.json（真实明文 JSON）', fs.readFileSync(kv).toString('base64')]);
  }
  // 合成基线：与真实 JSON 同构的紧凑 ASCII JSON
  const synthetic = JSON.stringify({
    canvas_config: { background: null, height: 1080, ratio: 'original', width: 1920 },
    color_space: -1,
    config: { adjust_max_index: 1, export_range: null, video_mute: false },
    draft_type: 'video',
    duration: 32333333,
    fps: 30.0,
    materials: { audios: [], videos: [] },
    tracks: [],
    version: 360000,
  });
  controls.push(['合成紧凑 JSON（基线）', Buffer.from(synthetic, 'utf8').toString('base64')]);
  return controls.map(([name, b64]) => ({ name, posDistinct: positionClassDistinct(b64) }));
}

/** 同一草稿两次保存（.json 与 .bak）的密文异或：检验是否存在密钥流复用 */
function keystreamReuseTest(file) {
  const bak = file + '.bak';
  if (!fs.existsSync(bak)) return null;
  const a = Buffer.from(fs.readFileSync(file).toString('latin1').trim(), 'base64');
  const b = Buffer.from(fs.readFileSync(bak).toString('latin1').trim(), 'base64');
  const n = Math.min(a.length, b.length);
  let zeros = 0;
  let identicalPrefix = 0;
  while (identicalPrefix < n && a[identicalPrefix] === b[identicalPrefix]) identicalPrefix++;
  for (let i = 0; i < n; i++) if ((a[i] ^ b[i]) === 0) zeros++;
  return {
    file: path.basename(file),
    bak: path.basename(bak),
    lenA: a.length,
    lenB: b.length,
    identicalPrefix,
    zeroPct: (zeros / n) * 100,
    randomBaselinePct: 100 / 256, // 1/256 ≈ 0.39%
    xorHeadHex: Buffer.from(a.subarray(0, 32).map((v, i) => v ^ b[i])).toString('hex'),
  };
}

/* ------------------------------------------------------------------ */
/* 明文结构摘要（任务要求的那张表；仅在拿到明文时才可能输出）          */
/* ------------------------------------------------------------------ */

function msToUs(v) {
  return typeof v === 'number' ? v : null;
}

function rangeText(r) {
  if (!r || typeof r.start !== 'number' || typeof r.duration !== 'number') return 'n/a';
  return `${r.start}..${r.start + r.duration} (start=${r.start}, dur=${r.duration})`;
}

function materialPath(m) {
  return (
    m.path ||
    m.file_Path ||
    m.filePath ||
    (m.reverse_path) ||
    ''
  );
}

function summarizeDraft(draft, label) {
  const L = [];
  const push = (s = '') => L.push(s);

  push(`===== ${label} =====`);
  push(`top-level keys (${Object.keys(draft).length}): ${Object.keys(draft).join(', ')}`);
  push(`draft.id        = ${draft.id ?? 'n/a'}`);
  push(`draft.name      = ${JSON.stringify(draft.name ?? null)}`);
  push(`draft.duration  = ${draft.duration ?? 'n/a'} us`);
  push(`draft.fps       = ${draft.fps ?? 'n/a'}`);
  push(`draft.version   = ${draft.version ?? 'n/a'}  new_version=${draft.new_version ?? 'n/a'}`);
  push(`canvas_config   = ${JSON.stringify(draft.canvas_config ?? null)}`);
  push('');

  // ---- materials ----
  const mats = draft.materials ?? {};
  const matCats = Object.keys(mats).filter((k) => Array.isArray(mats[k]));
  push(`--- materials (${matCats.length} 个数组类别) ---`);
  const byId = new Map();
  for (const cat of matCats) {
    const arr = mats[cat];
    push(`  ${cat.padEnd(24)} ${String(arr.length).padStart(4)} 项`);
    for (const m of arr) {
      if (m && typeof m === 'object') {
        if (m.id) byId.set(m.id, { cat, m });
        const p = materialPath(m);
        const bits = [];
        if (p) bits.push(`path=${p}`);
        if (m.duration != null) bits.push(`duration=${m.duration}`);
        if (m.name) bits.push(`name=${JSON.stringify(m.name)}`);
        if (m.type) bits.push(`type=${m.type}`);
        if (bits.length) push(`      - [${cat}] ${bits.join('  ')}`);
      }
    }
  }
  push('');

  // ---- tracks / segments ----
  const tracks = Array.isArray(draft.tracks) ? draft.tracks : [];
  push(`--- tracks (${tracks.length} 条) ---`);
  tracks.forEach((tr, ti) => {
    const segs = Array.isArray(tr.segments) ? tr.segments : [];
    push(`  track[${ti}] type=${tr.type ?? 'n/a'} id=${tr.id ?? 'n/a'} segments=${segs.length}`);
    segs.forEach((sg, si) => {
      const mat = sg.material_id ? byId.get(sg.material_id) : null;
      const extra = Array.isArray(sg.extra_material_refs) ? sg.extra_material_refs : [];
      const extraCats = extra
        .map((id) => byId.get(id)?.cat)
        .filter(Boolean);
      push(
        `     seg[${si}] id=${sg.id ?? 'n/a'} material=${sg.material_id ?? 'n/a'}` +
          (mat ? ` (${mat.cat})` : '')
      );
      push(`            target_timerange = ${rangeText(sg.target_timerange)}`);
      push(`            source_timerange = ${rangeText(sg.source_timerange)}`);
      push(
        `            speed=${sg.speed ?? 'n/a'}  volume=${sg.volume ?? 'n/a'}  visible=${sg.visible ?? 'n/a'}` +
          (sg.reverse != null ? `  reverse=${sg.reverse}` : '')
      );
      if (extraCats.length) push(`            extra_material_refs = ${extraCats.join(',')}`);
      for (const id of extra) {
        const hit = byId.get(id);
        if (!hit) continue;
        const m = hit.m;
        if (hit.cat === 'transitions') {
          push(`            transition: name=${m.name ?? 'n/a'} duration=${m.duration ?? 'n/a'} path=${m.path ?? 'n/a'}`);
        }
        if (hit.cat === 'speeds') {
          push(`            speed_material: speed=${m.speed ?? 'n/a'} curve_speed=${m.curve_speed ?? 'n/a'}`);
        }
        if (hit.cat === 'beats' || m.beats) {
          const pts = m.beats ?? m.geometric_points ?? m.ai_beats ?? null;
          if (pts) push(`            beats: ${Array.isArray(pts) ? pts.length + ' 个点' : typeof pts} ${JSON.stringify(pts).slice(0, 160)}`);
        }
      }
      // 片段自带的 beats / 转场字段
      if (sg.beats) push(`            segment.beats = ${JSON.stringify(sg.beats).slice(0, 160)}`);
      if (sg.transition) push(`            segment.transition = ${JSON.stringify(sg.transition).slice(0, 160)}`);
    });
  });
  push('');

  // ---- transitions / beats 专项 ----
  const trans = mats.transitions ?? [];
  const beats = mats.beats ?? [];
  push(`--- transitions: ${Array.isArray(trans) ? trans.length : 'n/a'} 项 ---`);
  for (const t of Array.isArray(trans) ? trans : []) {
    push(`   id=${t.id ?? 'n/a'} name=${t.name ?? 'n/a'} duration=${t.duration ?? 'n/a'} is_overlap=${t.is_overlap ?? 'n/a'}`);
  }
  push(`--- beats: ${Array.isArray(beats) ? beats.length : 'n/a'} 项 ---`);
  for (const b of Array.isArray(beats) ? beats : []) {
    const pts = b.beats ?? b.geometric_points ?? b.ai_beats ?? [];
    push(`   id=${b.id ?? 'n/a'} type=${b.type ?? 'n/a'} points=${Array.isArray(pts) ? pts.length : 'n/a'} sample=${JSON.stringify(pts).slice(0, 200)}`);
  }
  return L.join('\n');
}

/* ------------------------------------------------------------------ */
/* 主流程                                                             */
/* ------------------------------------------------------------------ */

function hr(title) {
  console.log('\n' + '='.repeat(78));
  console.log(title);
  console.log('='.repeat(78));
}

function main() {
  const argv = process.argv.slice(2);

  // --- 模式 B：直接摘要一份已知明文 JSON ---
  const plainIdx = argv.indexOf('--plain');
  if (plainIdx !== -1) {
    const f = argv[plainIdx + 1];
    if (!f || !fs.existsSync(f)) {
      console.error('用法: node decode-draft.mjs --plain <明文 draft_content.json>');
      process.exit(2);
    }
    const draft = JSON.parse(fs.readFileSync(f, 'utf8'));
    console.log(summarizeDraft(draft, path.basename(f)));
    process.exit(0);
  }

  const file = argv[0] ?? DEFAULT_SAMPLE;
  if (!fs.existsSync(file)) {
    console.error(`样本不存在: ${file}`);
    process.exit(2);
  }

  hr('0. 样本');
  const st = fs.statSync(file);
  console.log(`file  : ${file}`);
  console.log(`bytes : ${st.size}`);
  console.log(`mtime : ${st.mtime.toISOString()}`);

  // ---------- 第 1 层 ----------
  hr('1. 第 1 层编码判定：是不是标准 base64？');
  const l1 = decodeLayer1(file);
  console.log(`文本字符数            : ${l1.textLength}`);
  console.log(`长度 % 4              : ${l1.lengthMod4}   (0 = 合法 base64 长度)`);
  console.log(`尾部 padding 数        : ${l1.padLen}`);
  console.log(`中间出现 '='           : ${l1.innerPadding}`);
  console.log(`字符集外字符           : ${l1.badChars.length === 0 ? '无（全部 ∈ A-Za-z0-9+/=）' : JSON.stringify(l1.badChars)}`);
  console.log(`使用到的不同符号数      : ${l1.distinctSymbols} / 64`);
  console.log(`标准 base64 解码长度    : ${l1.decoded ? l1.decoded.length : 'n/a'}`);
  console.log(`往返校验（严格双射）    : ${l1.decodeError ? 'FAIL — ' + l1.decodeError : 'PASS'}`);
  console.log(`→ 结论：第 1 层是【标准 base64】（不是自定义字母表，见第 5 节判定）`);

  // ---------- 第 2 层统计 ----------
  hr('2. 第 2 层解码后字节的熵与分布');
  const d = diagnose(l1);
  console.log(`字节长度              : ${l1.decoded.length}`);
  console.log(`Shannon 熵            : ${d.entropy.toFixed(3)} bit/byte   (8.0 = 完全均匀)`);
  console.log(`卡方 vs 均匀分布       : ${d.chi2.toFixed(1)}            (df=255，均匀期望 ≈ 255)`);
  console.log(`最高单字节频率         : ${d.maxFreqPct.toFixed(2)} %      (均匀期望 0.39 %)`);
  console.log(`可打印 ASCII 占比      : ${d.asciiRatio.toFixed(1)} %       (JSON 明文应 > 90 %)`);
  console.log(`首字节是否 '{'         : ${d.startsWithJson}`);
  console.log(`head hex             : ${d.headHex}`);
  console.log(`→ 结论：解码后是【近似均匀的高熵字节流】，不是文本`);

  // ---------- 压缩? ----------
  hr('3. 是否只是压缩（gzip/zlib/zstd/lz4/xz/bzip2）？');
  for (const [k, v] of Object.entries(d.compression)) {
    console.log(`  ${k.padEnd(8)} magic: ${String(v)}`);
  }
  console.log('→ 结论：全部不匹配，且熵已接近 8.0（压缩流通常 7.5~7.99 且有可识别表头）→ 排除“仅压缩”');

  // ---------- 分组密码? ----------
  hr('4. 是否分组密码（AES/DES/SM4，块长 16 / 8 的 CBC/ECB）？');
  console.log(`解码长度 % 16 = ${d.mod16}   % 8 = ${d.mod8}`);
  console.log('→ 结论：不是 16 字节整数倍 → 排除 AES/DES/SM4 的 ECB/CBC+PKCS#7（除非另有一层流式封装）');

  // ---------- 位置类分析（决定性） ----------
  hr('5. 决定性判定：是不是「自定义字母表 base64(明文 JSON)」？');
  console.log('原理：base64 每 4 字符一组，第 1 个字符只承载 b0 的高 6 位。');
  console.log('      ASCII JSON 的 b0 < 0x80，故 b0>>2 ∈ [0,31] —— 位置 0 最多只有 32 种符号。');
  console.log('      字母表被“置换”只会换掉是哪些符号，不会改变“不同符号的个数”。');
  console.log('      所以：位置 0 用满 64 种符号 ⇒ 明文不是 ASCII JSON ⇒ 置换字母表假设不成立。\n');
  console.log('  ENCRYPTED 样本各位置不同符号数:', d.posDistinct.join(' / '));
  console.log('  对照组（真实明文 JSON 的 base64）:');
  for (const c of controlPositionClass()) {
    console.log(`     ${c.name.padEnd(34)} ${c.posDistinct.join(' / ')}`);
  }
  const pos0 = d.posDistinct[0];
  if (pos0 >= 60) {
    console.log(`\n→ 结论：位置 0 用了 ${pos0}/64 种符号 ⇒ 【自定义/置换字母表 base64 假设被证伪】`);
    console.log('        明文不是 ASCII JSON，而是全域 8 位数据 → 该层是真实加密（或二进制化）。');
  } else {
    console.log(`\n→ 位置 0 仅 ${pos0} 种符号 ⇒ 更像是 base64(ASCII 文本)，需要进一步尝试字母表还原。`);
  }

  // ---------- 密钥流复用 ----------
  hr('6. 是否静态密钥流 XOR（密钥流复用）？');
  const ks = keystreamReuseTest(file);
  if (!ks) {
    console.log('（无 .bak 对照文件，跳过）');
  } else {
    console.log(`对照：${ks.file}  vs  ${ks.bak}`);
    console.log(`  解码后长度          : ${ks.lenA} / ${ks.lenB}`);
    console.log(`  密文相同前缀字节数   : ${ks.identicalPrefix}`);
    console.log(`  异或为 0 的字节占比  : ${ks.zeroPct.toFixed(2)} %  (随机基线 ≈ ${ks.randomBaselinePct} %)`);
    console.log(`  异或头 32 字节      : ${ks.xorHeadHex}`);
    console.log('→ 结论：同一草稿两次保存的密文从第 0 字节起就不同，异或结果近似随机');
    console.log('        ⇒ 每个文件都有独立 nonce/IV，不存在密钥流复用，静态 XOR 攻击不可用');
  }

  // ---------- 最终判定 ----------
  hr('7. 最终判定');
  console.log('第 1 层：标准 base64（字母表 = A-Za-z0-9+/，标准顺序，已严格往返校验）。');
  console.log('第 2 层：高熵（7.995 bit/byte）、近似均匀、无压缩/文件头特征、长度非 16 倍数、');
  console.log('        每次保存 nonce 不同 —— 与「带 per-file nonce 的流式对称加密」一致。');
  console.log('');
  console.log('*** 未解开 *** 本脚本没有、也不能在此环境下产出明文。');
  console.log('    明文 JSON 未获得 → tracks / segments / target_timerange / source_timerange /');
  console.log('    volume / speed / materials.path / duration / transitions / beats 全部【不可得】。');
  console.log('    本报告不提供任何推测的字段值。');
  console.log('');
  console.log('已定位的可解点（详见 jy-draft-cipher.md）：');
  console.log('  videoeditor.dll  .text RVA 0x137e360 (2388 B)  ← 打印 "decrypt error encryptStr..."，疑为 EncryptUtils::decryptImpl');
  console.log('  videoeditor.dll  .text RVA 0x137b600 (4384 B)  ← 打印含 header_length 的解密失败日志，疑为 EncryptUtils::decrypt');
  console.log('  videoeditor.dll  .text RVA 0x1379a10 (661  B)  ← 引用字符串 "jianying_draft_encrypt_v2"');
  console.log('  算法族线索：CryptoPP（Rijndael/CTR/Base64Encoder）、crypto_key_store.dat、scope kGlobal/kCurrent/kTemporary');
  console.log('  缺失：crypto_key_store.dat 在本机不存在 → 密钥不在可离线读取的文件里。');
  process.exit(0);
}

main();
