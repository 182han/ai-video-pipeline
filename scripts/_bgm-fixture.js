// 配乐测试公共 fixture（非套件；文件名不以 verify- 开头，不进 verify-all 注册表）。
// 目的：让配乐测试不再依赖真实 assets/bgm（那里只有 2 首 mp3，且历史 trackId 多已失效）。
// 用法：在任何 require('../src/processors/audioMixer') 之前调用 ensureIsolatedBgm()。
//   - 若进程已有 BGM_DIR（外部显式隔离），直接沿用；
//   - 否则生成临时 BGM 目录（ffmpeg 合成正弦 mp3 + 自带 manifest），并把 process.env.BGM_DIR 指过去。
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

function makeTempBgmDir(prefix) {
  const config = require('../config');
  const ffmpeg = config.FFMPEG_PATH || 'ffmpeg';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), (prefix || 'bgm_fixture_') + '-'));
  const sub = (rel) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    return p;
  };
  const tone = (rel, freq, durSec) => {
    const p = sub(rel);
    execSync(
      `"${ffmpeg}" -y -hide_banner -loglevel error -f lavfi -i "sine=frequency=${freq}:duration=${durSec}" `
      + `-c:a libmp3lame -q:a 5 "${p}"`,
      { stdio: 'ignore', timeout: 120000 }
    );
    if (!fs.existsSync(p) || fs.statSync(p).size === 0) throw new Error('BGM fixture 生成失败: ' + p);
    return p;
  };
  // 覆盖现有配乐套件引用的 trackId
  tone('calm/fixture_calm01.mp3', 440, 60);   // calm_01
  tone('calm/fixture_calm02.mp3', 660, 90);   // calm_02（mix 需要 ≥75s）
  tone('nature/fixture_nat01.mp3', 523, 60);  // nature_01
  tone('nature/fixture_nat02.mp3', 349, 60);  // nature_02
  const manifest = [
    { id: 'calm_01', file: 'calm/fixture_calm01.mp3', title: 'fixture calm 01', author: 'fixture', license: 'test-only', durationSec: 60, mood: ['calm'], bpm: null, instruments: 'sine' },
    { id: 'calm_02', file: 'calm/fixture_calm02.mp3', title: 'fixture calm 02', author: 'fixture', license: 'test-only', durationSec: 90, mood: ['calm'], bpm: null, instruments: 'sine' },
    { id: 'nature_01', file: 'nature/fixture_nat01.mp3', title: 'fixture nature 01', author: 'fixture', license: 'test-only', durationSec: 60, mood: ['nature'], bpm: null, instruments: 'sine' },
    { id: 'nature_02', file: 'nature/fixture_nat02.mp3', title: 'fixture nature 02', author: 'fixture', license: 'test-only', durationSec: 60, mood: ['nature'], bpm: null, instruments: 'sine' }
  ];
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return dir;
}

// 必须在 require audioMixer 之前调用
function ensureIsolatedBgm(prefix) {
  if (process.env.BGM_DIR) return { dir: path.resolve(process.env.BGM_DIR), reused: true };
  const dir = makeTempBgmDir(prefix);
  process.env.BGM_DIR = dir;
  process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} });
  return { dir, reused: false };
}

module.exports = { makeTempBgmDir, ensureIsolatedBgm };
