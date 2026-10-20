// ==========================================
// 视频处理模块 - 基于 FFmpeg
// 功能：拼接、转码、无缝循环、提取帧
// ==========================================

const fs = require('fs');
const path = require('path');
const { execSync, exec } = require('child_process');
const config = require('../config');

const OUTPUT_DIR = path.join(__dirname, '..', 'output');

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// FFmpeg 路径（优先用配置的，其次系统 PATH）
const FFMPEG_PATH = config.FFMPEG_PATH || 'ffmpeg';
const FFPROBE_PATH = config.FFPROBE_PATH || 'ffprobe';

class VideoProcessor {
  constructor() {
    this.hasFFmpeg = this._checkFFmpeg();
    console.log(`FFmpeg 可用: ${this.hasFFmpeg}`);
    if (this.hasFFmpeg && FFMPEG_PATH !== 'ffmpeg') {
      console.log(`FFmpeg 路径: ${FFMPEG_PATH}`);
    }
  }

  _checkFFmpeg() {
    try {
      execSync(`"${FFMPEG_PATH}" -version`, { stdio: 'ignore' });
      return true;
    } catch (e) {
      return false;
    }
  }

  // ===== 1. 拼接视频 =====
  //
  // 执行只关心成功/失败的 ffmpeg 命令。
  // 本环境（DSH 沙箱）里 execSync 带 stdio:'pipe' 会 spawn EPERM（与 AGENTS.md §2.3 一致），
  // 降级为 stdio:'ignore' 重跑；生产环境第一次就能成功，行为不变。
  _runFFmpeg(cmd) {
    try {
      execSync(cmd, { stdio: 'pipe' });
      return { success: true };
    } catch (e) {
      if (!(e && (e.code === 'EPERM' || /EPERM|EACCES/.test(String(e.message || ''))))) {
        return { success: false, error: e.message };
      }
      try {
        execSync(cmd, { stdio: 'ignore' });
        return { success: true, fallback: true };
      } catch (e2) {
        return { success: false, error: e2.message };
      }
    }
  }

  // 需要读取 stderr 的命令（解码校验）：直接把 stderr 重定向到临时文件再读，
  // 不依赖管道捕获，沙箱与生产环境行为一致。
  _runCaptureStderr(cmd) {
    const os = require('os');
    const tmp = path.join(os.tmpdir(), `vp_err_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.txt`);
    const readTmp = () => { try { return fs.readFileSync(tmp, 'utf8'); } catch (e) { return ''; } };
    try {
      execSync(`${cmd} 2> "${tmp}"`, { stdio: 'ignore' });
      return { ok: true, stderr: readTmp() };
    } catch (e) {
      return {
        ok: false,
        stderr: readTmp() || String((e && e.stderr) || e.message || ''),
        error: e.message
      };
    } finally {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e) {}
    }
  }


  async concatenate(clips, outputPath) {
    if (this.hasFFmpeg) {
      return this._concatenateFFmpeg(clips, outputPath);
    }
    return this._mockConcatenate(clips, outputPath);
  }

  _concatenateFFmpeg(clips, outputPath) {
    const listPath = outputPath + '.txt';
    const cleanup = () => {
      try { if (fs.existsSync(listPath)) fs.unlinkSync(listPath); } catch (e) {}
      try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (e) {}
    };

    // 先探测各片段的音轨情况 —— 它决定后面两条路径怎么写滤镜：
    //   全部有音轨 -> concat v=1:a=1
    //   全部无音轨 -> concat v=1:a=0（-map 只取视频）
    //   混合       -> copy 路径会【静默丢音频】，必须跳过；重编码前给无音轨片段补等长静音
    // 历史缺陷：重编码兜底曾硬编码 `[i:v][i:a]`，遇到无音轨片段直接
    //   `Stream specifier ':a' matches no streams` 失败（连 -c copy 也不通时即无兜底）。
    const audioFlags = clips.map(c => this._hasAudioStream(c));
    const allHaveAudio = audioFlags.every(Boolean);
    const noneHaveAudio = audioFlags.every(f => f === false);
    const mixedAudio = !allHaveAudio && !noneHaveAudio;

    // 路径 1：-c copy 直拼（快）
    // 混合音轨时禁用：实测 concat demuxer + -c copy 对「有音轨 + 无音轨」混合输入
    // 退出码 0、时长正确，但产物只剩 video 流 —— 音频被静默丢弃，
    // 而 _validateConcatDuration 只校验时长，抓不到这种丢失。必须走重编码。
    if (mixedAudio) {
      console.warn('[concat] 检测到片段音轨不一致（部分有音轨、部分无），跳过 -c copy 直拼'
        + '（否则会静默丢弃音频），改走重编码补静音');
    } else {
      try {
        const listContent = clips.map(c => `file '${c.replace(/'/g, "'\\''")}'`).join('\n');
        fs.writeFileSync(listPath, listContent, 'utf8');
        const cmd = `"${FFMPEG_PATH}" -y -f concat -safe 0 -i "${listPath}" -c copy "${outputPath}"`;
        const run = this._runFFmpeg(cmd);
        if (!run.success) throw new Error(run.error || 'ffmpeg 拼接命令失败');

        // 改动点 2：退出码为 0 不代表拼全了（输入损坏时会静默只拼出前几段），必须实测时长
        const v = this._validateConcatDuration(outputPath, clips);
        if (v.ok) {
          try { fs.unlinkSync(listPath); } catch (e) {}
          return { success: true, outputPath, durationCheck: v };
        }
        // 不可判定（探测不到时长）时不做重编码兜底：
        // 重编码同样无法校验结果，只会白白多花一次编码时间并可能覆盖可用产物。
        // 此时保留 copy 产物，但把 unverified 标记透传给上层，让质检如实记录「未验证」。
        if (v.undetermined) {
          console.warn('[concat] 时长不可判定，保留 copy 产物但标记未验证：' + v.reason);
          try { fs.unlinkSync(listPath); } catch (e) {}
          return { success: true, outputPath, durationCheck: v, unverified: true };
        }
        console.warn('[concat] copy 产物时长校验失败，改用重编码兜底：' + v.reason);
        cleanup();
      } catch (e) {
        cleanup();
      }
    }

    // 路径 2：重编码直拼兜底
    //
    // 滤镜必须按音轨情况构造，不能一律写 `[i:v][i:a]`：
    //   - 有音轨片段：`[i:v][i:a]` + `concat=v=1:a=1`
    //   - 无音轨片段：只取 `[i:v]` + `concat=v=1:a=0`，输出 `-map [outv]`
    //   - 混合：先把无音轨片段补上等长静音轨（anullsrc），统一成有音轨后再拼接，
    //           这样既不会失败，也不会像 -c copy 那样静默丢音频
    const paddedTemps = [];
    try {
      let concatInputs = clips;
      let needAudio = allHaveAudio;

      if (mixedAudio) {
        concatInputs = [];
        for (let i = 0; i < clips.length; i++) {
          if (audioFlags[i]) {
            concatInputs.push(clips[i]);
          } else {
            // 给无音轨片段补一条与视频等长的静音轨
            const padded = `${outputPath}.pad${i}.mp4`;
            const padCmd = `"${FFMPEG_PATH}" -y -i "${clips[i]}" -f lavfi -i "anullsrc=r=44100:cl=stereo" `
              + `-shortest -map 0:v -map 1:a -c:v copy -c:a aac "${padded}"`;
            const padRun = this._runFFmpeg(padCmd);
            if (!padRun.success) throw new Error(padRun.error || 'ffmpeg 补静音命令失败');            if (!fs.existsSync(padded) || fs.statSync(padded).size === 0) {
              throw new Error(`第 ${i + 1} 个片段补静音失败`);
            }
            paddedTemps.push(padded);
            concatInputs.push(padded);
          }
        }
        needAudio = true;
      }

      const inputs = concatInputs.map(c => `-i "${c}"`).join(' ');
      let filterParts;
      let maps;
      if (needAudio) {
        filterParts = concatInputs.map((_, i) => `[${i}:v][${i}:a]`).join('');
        maps = '-map "[outv]" -map "[outa]"';
      } else {
        // 全无音轨：只拼视频，显式标记 a=0
        filterParts = concatInputs.map((_, i) => `[${i}:v]`).join('');
        maps = '-map "[outv]"';
      }
      const filter = `${filterParts}concat=n=${concatInputs.length}:v=1:a=${needAudio ? 1 : 0}[outv]`
        + (needAudio ? '[outa]' : '');
      const cmd = `"${FFMPEG_PATH}" -y ${inputs} -filter_complex "${filter}" ${maps} "${outputPath}"`;
      const run = this._runFFmpeg(cmd);
      if (!run.success) throw new Error(run.error || 'ffmpeg 重编码拼接命令失败');

      const v = this._validateConcatDuration(outputPath, clips);
      const cleanupTemps = () => {
        paddedTemps.forEach(p => { try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) {} });
      };
      if (v.ok) {
        cleanupTemps();
        return {
          success: true,
          outputPath,
          durationCheck: v,
          reencoded: true,
          hasAudio: needAudio,
          silencePadded: paddedTemps.length
        };
      }
      if (v.undetermined) {
        // 同上：重编码已完成但无法校验，保留产物并标记未验证，不谎报成功也不丢弃结果
        console.warn('[concat] 重编码后时长仍不可判定，保留产物但标记未验证：' + v.reason);
        cleanupTemps();
        return { success: true, outputPath, durationCheck: v, reencoded: true, unverified: true, hasAudio: needAudio };
      }
      cleanupTemps();
      cleanup();
      return { success: false, error: '拼接产物时长校验失败: ' + v.reason };
    } catch (e2) {
      paddedTemps.forEach(p => { try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) {} });
      cleanup();
      return { success: false, error: '拼接失败: ' + e2.message };
    }
  }

  // 探测单个媒体时长（秒）；失败返回 0
  _probeDurationSec(mediaPath) {
    try {
      const cmd = `"${FFPROBE_PATH}" -v error -show_entries format=duration -of csv=p=0 "${mediaPath}"`;
      const out = this._execText(cmd);
      const d = parseFloat(String(out).trim());
      return isFinite(d) && d > 0 ? d : 0;
    } catch (e) {
      return 0;
    }
  }

  // 校验拼接产物时长 ≈ 各输入时长之和（容差 ±max(0.5s, 2%)）
  // 注意：探测失败不等于校验通过。输入时长全部探测失败时，本函数无法判断产物
  // 是否被截断，此时必须返回不可判定（ok:false + undetermined:true），由调用方
  // 决定回退重编码还是判失败 —— 绝不能悄悄当成「校验通过」放行。
  _validateConcatDuration(outputPath, clips) {
    let expected = 0;
    let probed = 0;
    for (const c of clips) {
      const d = this._probeDurationSec(c);
      if (d > 0) { expected += d; probed++; }
    }
    if (probed === 0 || expected <= 0) {
      return {
        ok: false,
        undetermined: true,
        reason: '无法探测任何输入片段时长，拼接完整性不可判定'
      };
    }
    const actual = this._probeDurationSec(outputPath);
    if (actual <= 0) {
      return { ok: false, reason: '无法探测拼接产物时长（产物可能损坏）' };
    }
    const tolerance = Math.max(0.5, expected * 0.02);
    const ok = Math.abs(actual - expected) <= tolerance;
    return {
      ok,
      actual: Math.round(actual * 100) / 100,
      expected: Math.round(expected * 100) / 100,
      tolerance: Math.round(tolerance * 100) / 100,
      reason: ok
        ? `时长校验通过 (${actual.toFixed(2)}s ≈ 期望 ${expected.toFixed(2)}s)`
        : `拼接被截断 (${actual.toFixed(2)}s，期望 ${expected.toFixed(2)}s，容差 ±${tolerance.toFixed(2)}s)`
    };
  }

  // ===== 1.5 片段库拼接：先归一化不匹配的片段，再走普通拼接 =====
  //
  // 为什么需要它（2026-10-20 实测）：
  //   - 同分辨率、帧率不同（720p@16 + 720p@30）：-c copy 直拼退出码 0，
  //     但产物有 190 处 DTS 错误、时长 11.31s（应 12.1s）；现有重编码兜底同样坏。
  //   - 跨分辨率（480p + 720p）：-c copy 能出片，但流内分辨率在第 8 秒从 854×480
  //     跳到 1280×720，播放器会异常。
  //   所以拼接前必须：按目标分辨率/帧率检查每一段，不匹配的单独重编码，
  //   全部对齐后再交给 concatenate()（保留它已有的音轨混合与时长校验）。
  async concatenateSegments(segments, outputPath, options = {}) {
    const list = Array.isArray(segments) ? segments.filter(s => s && s.path) : [];
    if (list.length === 0) return { success: false, error: '没有可拼接的片段' };
    if (!this.hasFFmpeg) return this._mockConcatenate(list.map(s => s.path), outputPath);

    const target = this._resolveTargetSize(options, list);
    const fps = Number(options.fps) || 30;
    const temps = [];
    try {
      const prepared = [];
      let normalized = 0;
      const details = list.map(s => s.detail || this.probeDetail(s.path));
      for (let i = 0; i < details.length; i++) {
        const detail = details[i];
        if (!detail.success) throw new Error(`第 ${i + 1} 段无法探测: ${detail.error || ''}`);
        const seg = list[i];
        const inSec = Math.max(0, Number(seg.inSec) || 0);
        const outSec = (seg.outSec !== undefined && seg.outSec !== null)
          ? Number(seg.outSec)
          : detail.duration;
        const dur = Math.max(0.05, outSec - inSec);
        const needsTrim = inSec > 0.02 || (detail.duration - outSec) > 0.02;
        const fpsMismatch = detail.fpsNum !== null && Math.abs(detail.fpsNum - fps) > 0.01;
        const sarBad = detail.sar && detail.sar !== '1:1' && detail.sar !== '0:1';
        const needsNorm = needsTrim
          || detail.width !== target.width
          || detail.height !== target.height
          || fpsMismatch
          || detail.codec !== 'h264'
          || (detail.pixFmt && detail.pixFmt !== 'yuv420p')
          || sarBad;

        if (!needsNorm) {
          prepared.push(seg.path);
          continue;
        }

        const tmp = path.join(path.dirname(outputPath), `.lib_norm_${process.pid}_${Date.now()}_${i}.mp4`);
        const vf = `scale=${target.width}:${target.height}:force_original_aspect_ratio=decrease,`
          + `pad=${target.width}:${target.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p`;
        const ss = inSec > 0.02 ? `-ss ${inSec.toFixed(3)}` : '';
        const tt = needsTrim ? `-t ${dur.toFixed(3)}` : '';
        const audio = detail.hasAudio ? '-c:a aac -ar 44100 -ac 2' : '-an';
        const cmd = `"${FFMPEG_PATH}" -y ${ss} -i "${seg.path}" ${tt} -vf "${vf}" `
          + `-c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p ${audio} "${tmp}"`;
        const run = this._runFFmpeg(cmd);
        if (!run.success) throw new Error(`第 ${i + 1} 段归一化失败: ${run.error || ''}`);
        if (!fs.existsSync(tmp) || fs.statSync(tmp).size === 0) {
          throw new Error(`第 ${i + 1} 段归一化失败（产物为空）`);
        }
        temps.push(tmp);
        prepared.push(tmp);
        normalized += 1;
      }

      const result = await this.concatenate(prepared, outputPath);
      if (!result.success) return { ...result, normalized, target, fps };

      // 时长校验之外再做一次完整解码：混帧率拼接会产出「退出码 0 但解码报错」的坏片，
      // 只校验时长抓不到。
      const decode = this._fullDecodeCheck(outputPath);
      if (!decode.ok) {
        return {
          success: false,
          error: `拼接产物无法完整解码：${decode.summary || '未知错误'}`,
          normalized,
          target,
          fps,
          durationCheck: result.durationCheck,
          decodeCheck: decode
        };
      }

      return {
        ...result,
        normalized,
        target,
        fps,
        decodeCheck: decode
      };
    } catch (e) {
      return { success: false, error: '片段库拼接失败: ' + e.message };
    } finally {
      for (const t of temps) {
        try { if (fs.existsSync(t)) fs.unlinkSync(t); } catch (e) {}
      }
    }
  }

  _resolveTargetSize(options, segments) {
    const map = { '480p': [854, 480], '720p': [1280, 720], '1080p': [1920, 1080], '4k': [3840, 2160], '4K': [3840, 2160] };
    const key = String(options.resolution || '').trim();
    if (map[key]) return { width: map[key][0], height: map[key][1], label: key };
    if (Number(options.width) > 0 && Number(options.height) > 0) {
      return { width: Number(options.width), height: Number(options.height), label: 'custom' };
    }
    // 没指定目标：取像素面积最大的片段，避免把高分辨率往低分辨率压
    let best = { width: 1280, height: 720, label: '720p' };
    let bestArea = 0;
    for (const s of segments) {
      const d = s.detail || this.probeDetail(s.path);
      if (d.success && d.width && d.height) {
        const area = d.width * d.height;
        if (area > bestArea) { bestArea = area; best = { width: d.width, height: d.height, label: 'auto' }; }
      }
    }
    return best;
  }

  probeDetail(videoPath) {
    try {
      const cmd = `"${FFPROBE_PATH}" -v error -show_format -show_streams -of json "${videoPath}"`;
      const info = JSON.parse(this._execText(cmd));
      const v = (info.streams || []).find(s => s.codec_type === 'video');
      const a = (info.streams || []).find(s => s.codec_type === 'audio');
      return {
        success: true,
        duration: parseFloat(info.format && info.format.duration) || 0,
        width: v && v.width,
        height: v && v.height,
        codec: v && v.codec_name,
        fps: v && v.r_frame_rate,
        fpsNum: this._parseFps(v && v.r_frame_rate),
        pixFmt: v && v.pix_fmt,
        sar: (v && v.sample_aspect_ratio) || '1:1',
        hasAudio: !!a,
        sizeBytes: (() => { try { return fs.statSync(videoPath).size; } catch (e) { return null; } })()
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  _parseFps(fps) {
    const s = String(fps || '');
    if (s.includes('/')) {
      const [a, b] = s.split('/').map(Number);
      if (b) return a / b;
    }
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }

  _fullDecodeCheck(videoPath) {
    const r = this._runCaptureStderr(`"${FFMPEG_PATH}" -v error -i "${videoPath}" -f null -`);
    if (r.ok) return { ok: true, errors: 0 };
    const stderr = String(r.stderr || '');
    const lines = stderr.split(/\r?\n/).filter(l => l.trim() && !/^ffmpeg version|^  built with|^  configuration|^  lib/.test(l));
    return {
      ok: false,
      errors: lines.length,
      summary: lines.slice(0, 3).join(' / ').slice(0, 300)
    };
  }

  _mockConcatenate(clips, outputPath) {
    // Mock 模式：创建一个文本文件假装是拼接后的视频
    const content = `Mock Concatenated Video\nClips: ${clips.length}\nGenerated: ${new Date().toISOString()}\nClip list:\n${clips.map((c, i) => `  ${i + 1}. ${c}`).join('\n')}`;
    fs.writeFileSync(outputPath, content, 'utf8');
    return { success: true, outputPath, mock: true };
  }

  // ===== 2. 转码 =====
  async transcode(inputPath, outputPath, options = {}) {
    const resolution = options.resolution || '720p';
    const fps = options.fps || 30;
    const codec = options.codec || 'libx264';

    if (this.hasFFmpeg) {
      return this._transcodeFFmpeg(inputPath, outputPath, resolution, fps, codec);
    }
    return this._mockTranscode(inputPath, outputPath, resolution, fps);
  }

  _transcodeFFmpeg(inputPath, outputPath, resolution, fps, codec) {
    const sizeMap = {
      '480p': '854x480',
      '720p': '1280x720',
      '1080p': '1920x1080',
      '4K': '3840x2160'
    };
    const size = sizeMap[resolution] || '1280x720';
    const [width, height] = size.split('x');

    const cmd = `"${FFMPEG_PATH}" -y -i "${inputPath}" -vf "scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2" -c:v ${codec} -crf 23 -preset medium -r ${fps} -c:a aac -b:a 128k -pix_fmt yuv420p "${outputPath}"`;

    try {
      const run = this._runFFmpeg(cmd);
      if (!run.success) return { success: false, error: run.error };
      return { success: true, outputPath, resolution, fps };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  _mockTranscode(inputPath, outputPath, resolution, fps) {
    const content = `Mock Transcoded Video\nResolution: ${resolution}\nFPS: ${fps}\nSource: ${inputPath}\nGenerated: ${new Date().toISOString()}`;
    fs.writeFileSync(outputPath, content, 'utf8');
    return { success: true, outputPath, resolution, fps, mock: true };
  }

  // ===== 3. 无缝循环（首尾帧交叉淡入淡出）=====
  async makeSeamlessLoop(inputPath, outputPath, fadeDuration = 1) {
    if (this.hasFFmpeg) {
      return this._makeLoopFFmpeg(inputPath, outputPath, fadeDuration);
    }
    return this._mockLoop(inputPath, outputPath, fadeDuration);
  }

  // ===== 真无缝循环（首尾交叉淡化）=====
  //
  // 历史：原实现用 filter_complex 但 offset 写成 `total_duration-${fadeDuration}`，
  // `total_duration` 不是 ffmpeg 合法记号，每次报错后落入 catch 的「复制原文件」兜底，
  // 实际等于直通；后一度明确改成 copyFileSync 直通。直通时循环回绕会硬跳切。
  //
  // 现实现（2026-10-19）用 xfade 做真实交叉淡化。公式与实测依据：
  //   设源时长 D，淡化 F，则产物长度 = D - F
  //   [main] = 源 [0, D-F)          —— 主体
  //   [head] = 源 [0, F)            —— 把「开头 F 秒」叠到末尾
  //   xfade=transition=fade:duration=F:offset=D-2F
  //
  // 关键点（实测踩过的坑，改之前务必先读）：
  //   1) xfade 的 offset 是相对【第一段输入】时间轴。第二段必须自己有内容覆盖到
  //      offset..offset+F 区间，否则淡化不生效、产物看似正常但没有任何融合
  //      （实测表现为末尾亮度全程不变，时长却「正确」——这是最隐蔽的失败模式）。
  //      因此这里让 head 段从 0 开始、由 xfade 负责把它挪到 offset 处，不要给 head
  //      加 setpts 偏移（加了反而与 xfade 的内部锚定冲突）。
  //   2) main 必须 trim 到 D-F，否则产物会比预期多出 (F) 秒。
  //   3) 数值全部 toFixed 后再拼进滤镜：Windows 浮点会产生 34.499999999 之类的尾数，
  //      直接插值会让 ffmpeg 解析异常或产生 ±1 帧误差。
  //   4) 不做 copyFileSync 兜底：失败就返回 success:false，由上层判 fail。
  //      「直通冒充循环」正是过去最严重的假实现，不能以任何形式复活。
  //
  // 验收口径（scripts/verify-loop.js）：产物时长 == D-F，且产物【末尾】帧与
  // 【开头】帧相似度显著高于原始直通（实测 35s 样片：0.49 → 0.96）。
  //
  // 成片会比拼接产物短 F 秒，这是真无缝的必然代价（首尾必须重叠）。
  // 新建任务路径与改配乐重建路径都已使用同一 F（见 pipeline.js），保证两条路径时长一致。
  _makeLoopFFmpeg(inputPath, outputPath, fadeDuration) {
    const F = Number.isFinite(Number(fadeDuration)) ? Number(fadeDuration) : 0.5;

    const info = this.getVideoInfo(inputPath);
    if (!info.success || !(info.duration > 0)) {
      return {
        success: false,
        error: '循环处理失败：无法读取源视频时长' + (info.error ? `（${info.error}）` : '')
      };
    }
    const D = info.duration;

    // 素材过短无法做淡化：直接判失败，不静默直通
    if (D <= 2 * F + 0.1) {
      return {
        success: false,
        error: `循环处理失败：素材时长 ${D.toFixed(2)}s 过短，无法做 ${F}s 首尾交叉淡化（至少需要 ${(2 * F + 0.1).toFixed(1)}s）`,
        sourceDuration: D
      };
    }

    const ds = D.toFixed(3);
    const fs_ = F.toFixed(3);
    const mainEnd = (D - F).toFixed(3);
    const offset = (D - 2 * F).toFixed(3);

    const filters = [
      `[0:v]trim=start=0:end=${mainEnd},setpts=PTS-STARTPTS[mt]`,
      `[0:v]trim=start=0:end=${fs_},setpts=PTS-STARTPTS[headt]`,
      `[mt][headt]xfade=transition=fade:duration=${fs_}:offset=${offset}[v]`
    ];

    // 音轨：拼接产物可能没有音频流（未配乐任务），属合法场景，不能因此失败。
    //
    // 音频必须进 filter_complex（用 atrim 截到 D-F 并向尾部淡出），不能用 `-af`：
    // 实测 `-map 0:a -af afade=...` 会保留完整的原始音频流（35s），
    // 容器时长于是被音频撑回 35.015s，而视频其实已经是 34.5s —— 时长校验能抓到，
    // 但产物本身就错了。atrim + asetpts 后视频/音频都精确等于 D-F。
    const hasAudio = this._hasAudioStream(inputPath);
    if (hasAudio) {
      filters.push(`[0:a]atrim=start=0:end=${mainEnd},asetpts=PTS-STARTPTS,afade=t=out:st=${offset}:d=${fs_}[a]`);
    }
    const filterComplex = filters.join(';');

    const audioMap = hasAudio
      ? '-map "[a]" -c:a aac -b:a 128k'
      : '-an';

    const cmd = `"${FFMPEG_PATH}" -y -i "${inputPath}" -filter_complex "${filterComplex}" `
      + `-map "[v]" ${audioMap} -c:v libx264 -crf 23 -preset medium -pix_fmt yuv420p "${outputPath}"`;

    try {
      // 走 _execText 的内置降级路径（本环境 stdio:'pipe' 会 EPERM）
      this._execText(cmd);
    } catch (e) {
      const detail = e.stderr ? e.stderr.toString().trim().split('\n').slice(-3).join(' | ') : '';
      return {
        success: false,
        error: '循环处理失败: ' + (e.message || 'ffmpeg 执行异常') + (detail ? ` 【${detail}】` : ''),
        sourceDuration: D
      };
    }

    // 不用退出码 0 当成功（§4.3）：实测产物时长必须 ≈ D - F
    const outInfo = this.getVideoInfo(outputPath);
    if (!outInfo.success || !(outInfo.duration > 0)) {
      return {
        success: false,
        error: '循环处理失败：产物时长无法探测（不可判定，不视为成功）',
        sourceDuration: D,
        undetermined: true
      };
    }
    const expected = D - F;
    // 容差必须小于淡化时长本身，否则「淡化没生效」的偏差（恰好是 F）会落在容差内被放行。
    // 实测教训：35s 素材、0.5s 淡化，用 max(0.5, 2%)=0.69s 容差时，
    // 音频被 -af 撑回原长的 35.015s 产物（偏差 0.515s）能「通过」，但产物其实是错的。
    const tol = Math.max(0.05, Math.min(F / 3, expected * 0.01));
    if (Math.abs(outInfo.duration - expected) > tol) {
      return {
        success: false,
        error: `循环处理失败：产物时长 ${outInfo.duration.toFixed(2)}s 与期望 ${expected.toFixed(2)}s 不符（容差 ${tol.toFixed(2)}s）`,
        sourceDuration: D,
        outputDuration: outInfo.duration
      };
    }

    return {
      success: true,
      outputPath,
      fadeDuration: F,
      reencoded: true,
      sourceDuration: D,
      outputDuration: outInfo.duration,
      expectedDuration: expected
    };
  }

  _mockLoop(inputPath, outputPath, fadeDuration) {
    const content = `Mock Seamless Loop Video\nFade duration: ${fadeDuration}s\nSource: ${inputPath}\nGenerated: ${new Date().toISOString()}`;
    fs.writeFileSync(outputPath, content, 'utf8');
    return { success: true, outputPath, fadeDuration, mock: true };
  }

  // ===== 4. 提取帧 =====
  extractFrame(videoPath, frameTime, outputPath) {
    if (this.hasFFmpeg) {
      try {
        const cmd = `"${FFMPEG_PATH}" -y -ss ${frameTime} -i "${videoPath}" -vframes 1 "${outputPath}"`;
        const run = this._runFFmpeg(cmd);
        if (!run.success) return { success: false, error: run.error };
        return { success: true, outputPath };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }
    // Mock
    fs.writeFileSync(outputPath, 'Mock frame image', 'utf8');
    return { success: true, outputPath, mock: true };
  }

  // ===== 5. 获取视频信息（ffprobe）=====
  getVideoInfo(videoPath) {
    if (this.hasFFmpeg) {
      try {
        const cmd = `"${FFPROBE_PATH}" -v error -show_format -show_streams -of json "${videoPath}"`;
        const output = this._execText(cmd);
        const info = JSON.parse(output);
        const videoStream = info.streams.find(s => s.codec_type === 'video');
        return {
          success: true,
          duration: parseFloat(info.format.duration),
          width: videoStream?.width,
          height: videoStream?.height,
          codec: videoStream?.codec_name,
          fps: videoStream?.r_frame_rate,
          bitrate: parseInt(info.format.bit_rate)
        };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }
    // Mock
    return {
      success: true,
      duration: 30,
      width: 1280,
      height: 720,
      codec: 'h264',
      fps: '30/1',
      bitrate: 5000000,
      mock: true
    };
  }

  // 探测是否存在音频流（用于无缝循环：无音轨是合法场景，不能当失败）
  // 返回 true/false；探测不到（异常）保守返回 true，交给 ffmpeg 的 -map 0:a 报错暴露，
  // 而不是静默丢掉音频。
  _hasAudioStream(videoPath) {
    try {
      const cmd = `"${FFPROBE_PATH}" -v error -select_streams a -show_entries stream=index -of csv=p=0 "${videoPath}"`;
      const out = this._execText(cmd).trim();
      return out.length > 0;
    } catch (e) {
      return true;
    }
  }

  // 执行命令并返回文本 stdout。
  // 本环境里 spawnSync/execSync 带 stdio:'pipe' 会返回 EPERM（见 AGENTS.md §2.3），
  // 因此内置降级：重定向到临时文件再读。语义与 qualityChecker._exec() 一致，
  // 但独立实现（质检模块的 _exec 是实例私有方法，跨模块 require 会形成循环依赖）。
  _execText(cmd) {
    try {
      return execSync(cmd, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    } catch (e) {
      if (!(e && (e.code === 'EPERM' || /EPERM|EACCES/.test(String(e.message || ''))))) throw e;
      const os = require('os');
      const tmp = path.join(os.tmpdir(), `vp_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.txt`);
      try {
        execSync(`${cmd} > "${tmp}" 2>&1`, { stdio: 'ignore' });
      } catch (e2) {
        if (!fs.existsSync(tmp)) throw e;
      }
      try {
        return fs.readFileSync(tmp, 'utf8');
      } finally {
        try { fs.unlinkSync(tmp); } catch (e3) {}
      }
    }
  }
}

module.exports = new VideoProcessor();
