// ==========================================
// 配乐计划 -> ffmpeg 参数（纯函数，不碰文件系统）
// ==========================================
// 背景：配乐方式从「逐段落混音」改为「整片多轨混音」。
// 浏览器在时间轴上做的所有编辑，最终被表达成一份 plan（JSON），
// 由这里翻译成 ffmpeg filter_complex。预览与导出走同一套翻译逻辑，
// 因此「听到的」与「导出的」由同一个引擎产生，天然一致。
//
// plan 结构：
// {
//   music:   [ Segment ],   // 轻音乐轨
//   ambient: [ Segment ],   // 环境音轨
//   opts: { loudness, ambientVolume, sampleRate }
// }
//
// Segment 结构：
// {
//   id,              // 片段唯一标识
//   trackId,         // 库存音轨 id
//   filePath,        // 音轨绝对路径（由调用方解析后注入）
//   timelineStart,   // 在成片时间轴上的起点（秒）
//   timelineEnd,     // 在成片时间轴上的终点（秒）
//   sourceIn,        // 源音频内的起点（秒）
//   sourceOut,       // 源音频内的终点（秒）
//   volume,          // 基础音量倍数，1 = 原音量
//   fadeIn,          // 淡入秒数
//   fadeOut,         // 淡出秒数
//   speed,           // 变速倍数，0.5~2，保音高
//   fillMode,        // 'none' | 'loop' | 'stretch'
//   keyframes        // [{ t, v }]，t 为片段内相对秒数，v 为音量倍数
// }

const DEFAULT_SAMPLE_RATE = 44100;
const MIN_FADE = 0.01;
const SPEED_MIN = 0.5;
const SPEED_MAX = 2;

// 数值兜底：非法/缺失一律回退默认值，避免把 NaN 拼进 ffmpeg 参数
function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// 把秒数格式化为 ffmpeg 能稳定解析的字符串（避免科学计数法）
function sec(v) {
  return (Math.round(v * 1000) / 1000).toFixed(3);
}

// ===== 单个片段的合法性校验 =====
// 返回 { ok, reason }，不抛异常，由调用方决定整片失败还是跳过该段
function validateSegment(seg, videoDuration) {
  if (!seg || typeof seg !== 'object') return { ok: false, reason: '片段为空' };
  if (!seg.trackId) return { ok: false, reason: '缺少 trackId' };
  if (!seg.filePath) return { ok: false, reason: `音轨文件未解析: ${seg.trackId}` };

  const start = num(seg.timelineStart, NaN);
  const end = num(seg.timelineEnd, NaN);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return { ok: false, reason: '时间轴起止时间非法' };
  }
  if (end <= start) return { ok: false, reason: '时间轴终点不大于起点' };
  if (start < 0) return { ok: false, reason: '时间轴起点为负' };
  // 超出成片范围的片段：裁到成片末尾（不视为错误，只是被截断）
  if (Number.isFinite(videoDuration) && videoDuration > 0 && start >= videoDuration) {
    return { ok: false, reason: `片段起点 ${sec(start)}s 超出成片时长 ${sec(videoDuration)}s` };
  }

  const speed = clamp(num(seg.speed, 1), SPEED_MIN, SPEED_MAX);
  if (Math.abs(speed - num(seg.speed, 1)) > 1e-6) {
    return { ok: false, reason: `变速倍数超出 ${SPEED_MIN}~${SPEED_MAX} 范围` };
  }
  return { ok: true };
}

// ===== 单个片段 -> 音量表达式 =====
// 支持关键帧：keyframes 为 [{ t, v }]，t 是片段内相对时间（秒），v 是音量倍数。
// 在相邻关键帧之间做线性插值，形成连续的渐强/渐弱曲线。
function buildVolumeExpression(seg, segDuration) {
  const base = num(seg.volume, 1);
  const kfs = Array.isArray(seg.keyframes) ? seg.keyframes.filter(k => k && Number.isFinite(Number(k.t))) : [];
  if (kfs.length === 0) {
    // 无关键帧：常量音量。恒为 1 时返回 null，调用方跳过该滤镜以省开销
    return base === 1 ? null : String(base);
  }
  const pts = kfs
    .map(k => ({ t: clamp(num(k.t, 0), 0, segDuration), v: Math.max(0, num(k.v, base)) }))
    .sort((a, b) => a.t - b.t);
  // 首尾补点，保证区间外也有定义
  if (pts[0].t > 0) pts.unshift({ t: 0, v: base });
  if (pts[pts.length - 1].t < segDuration) pts.push({ t: segDuration, v: base });

  // 生成嵌套 if：按时间落在哪个区间，线性插值
  // ⚠️ 表达式里的逗号必须转义成 ','（反斜杠+逗号），否则会被 filtergraph 当成
  // 滤镜参数分隔符而解析失败——实测报错 "No option name near 'frame'"。
  const C = '\\,'; // filtergraph 层级的逗号
  let expr = String(pts[pts.length - 1].v);
  for (let i = pts.length - 2; i >= 0; i--) {
    const a = pts[i], b = pts[i + 1];
    const span = b.t - a.t;
    const inner = span > 1e-6
      ? `(${a.v}+(${b.v}-${a.v})*(t-${sec(a.t)})/${sec(span)})`
      : String(b.v);
    expr = `if(lt(t${C}${sec(b.t)})${C}${inner}${C}${expr})`;
  }
  // 关键帧音量乘以基础音量
  return base === 1 ? expr : `(${base})*(${expr})`;
}

// ===== 单个片段 -> 音频滤镜链 =====
// 返回该片段从输入流到最终 [aN] 的滤镜片段数组，以及它实际占用的时长。
// 调用方负责把各片段用 adelay 对齐到时间轴位置后再 amix。
function buildSegmentFilters(seg, inputIndex, label, opts = {}) {
  const sr = num(opts.sampleRate, DEFAULT_SAMPLE_RATE);
  const speed = clamp(num(seg.speed, 1), SPEED_MIN, SPEED_MAX);
  const srcIn = Math.max(0, num(seg.sourceIn, 0));
  const srcOut = num(seg.sourceOut, srcIn);
  const timelineStart = Math.max(0, num(seg.timelineStart, 0));
  const timelineEnd = num(seg.timelineEnd, timelineStart);
  const wantDuration = Math.max(0, timelineEnd - timelineStart);

  const filters = [];
  filters.push(`[${inputIndex}:a]aformat=sample_rates=${sr}:channel_layouts=stereo`);

  // 1) 取自源音频的区间
  const srcLen = Math.max(0, srcOut - srcIn);
  if (srcLen > 0) {
    filters[0] += `,atrim=start=${sec(srcIn)}:end=${sec(srcOut)},asetpts=PTS-STARTPTS`;
  } else {
    filters[0] += `,asetpts=PTS-STARTPTS`;
  }

  // 2) 填充模式：素材比目标时长短时才需要
  const fillMode = seg.fillMode || 'none';
  const usableLen = srcLen > 0 ? srcLen / speed : wantDuration;

  if (fillMode === 'loop' && usableLen > 0 && usableLen < wantDuration) {
    // 循环填充：按源区间样本数循环，再裁到目标时长。
    // 注意：size 以采样数计，必须与当前实际采样率一致（历史缺陷就出在这里）。
    const loopSamples = Math.round(srcLen * sr);
    filters[0] += `,aloop=loop=-1:size=${loopSamples},atrim=0:${sec(wantDuration)},asetpts=PTS-STARTPTS`;
  } else if (fillMode === 'stretch') {
    // 匀速拉伸：用 atempo 把源区间拉/压到目标时长（保音高）
    const ratio = wantDuration > 0 && srcLen > 0 ? wantDuration / srcLen : 1;
    const tempo = clamp(ratio, SPEED_MIN, SPEED_MAX);
    if (Math.abs(tempo - 1) > 1e-3) {
      // atempo 单次只支持 0.5~2，超出范围用链式串联（这里已 clamp，留作将来扩展）
      filters[0] += `,atempo=${tempo.toFixed(4)}`;
    }
  } else if (speed !== 1) {
    // 普通变速（保音高）
    filters[0] += `,atempo=${speed.toFixed(4)}`;
  }

  // 3) 音量（含关键帧）
  const volExpr = buildVolumeExpression(seg, wantDuration);
  if (volExpr) filters[0] += `,volume=${volExpr}:eval=frame`;

  // 4) 淡入淡出
  const fadeIn = clamp(num(seg.fadeIn, 0), 0, wantDuration / 2);
  const fadeOut = clamp(num(seg.fadeOut, 0), 0, wantDuration / 2);
  if (fadeIn >= MIN_FADE) filters[0] += `,afade=t=in:st=0:d=${sec(fadeIn)}`;
  if (fadeOut >= MIN_FADE) {
    filters[0] += `,afade=t=out:st=${sec(wantDuration - fadeOut)}:d=${sec(fadeOut)}`;
  }

  // 5) 对齐到时间轴位置（延时插入静音）
  const delayMs = Math.round(timelineStart * 1000);
  if (delayMs > 0) {
    filters[0] += `,adelay=${delayMs}|${delayMs}`;
  }

  // 6) 裁到目标时长，避免 loop/atempo 累积误差导致总长短于预期
  filters[0] += `,atrim=0:${sec(wantDuration)},asetpts=PTS-STARTPTS`;

  filters[0] += `[${label}]`;
  return { filter: filters[0], duration: wantDuration };
}

// ===== 整份 plan -> ffmpeg 完整参数 =====
// 返回：
// {
//   ok, error?,
//   filterComplex,     // 滤镜图
//   audioMap,          // 音频输出标签，如 '[aout]'
//   inputTracks,       // 需要作为输入的音轨文件路径（去重后有序）
//   totalDuration,     // 成片时长
//   warnings
// }
// videoInputIndex 固定为 0（视频是第一个 -i）
function buildMixCommand(plan, videoDuration, opts = {}) {
  const warnings = [];
  const inputs = [];          // 需要追加 -i 的音轨路径（有序去重）
  const inputIndexOf = new Map();
  const filterParts = [];
  const mixInputs = [];

  const sr = num(opts.sampleRate, DEFAULT_SAMPLE_RATE);
  const loudness = num(opts.loudness, -20);
  const ambientVolume = num(opts.ambientVolume, 0.125); // -18dB ≈ 0.125

  const music = Array.isArray(plan && plan.music) ? plan.music : [];
  const ambient = Array.isArray(plan && plan.ambient) ? plan.ambient : [];

  if (music.length === 0 && ambient.length === 0) {
    return { ok: false, error: '配乐计划为空（没有任何音频片段）' };
  }

  const allocateInput = (filePath) => {
    if (inputIndexOf.has(filePath)) return inputIndexOf.get(filePath);
    // 视频占 0，音轨从 1 开始
    const idx = inputs.length + 1;
    inputs.push(filePath);
    inputIndexOf.set(filePath, idx);
    return idx;
  };

  let seq = 0;
  const emitTrack = (segments, trackKind, trackVolume) => {
    const labeled = [];
    for (const seg of segments) {
      const v = validateSegment(seg, videoDuration);
      if (!v.ok) {
        warnings.push(`[${trackKind}] 片段被跳过: ${v.reason}`);
        continue;
      }
      const idx = allocateInput(seg.filePath);
      const label = `${trackKind}${seq++}`;
      // 轨道级音量与片段级音量相乘，交给片段滤镜内的 volume 处理
      const scaled = trackVolume === 1 ? seg : {
        ...seg,
        volume: num(seg.volume, 1) * trackVolume,
        keyframes: Array.isArray(seg.keyframes)
          ? seg.keyframes.map(k => ({ t: k.t, v: num(k.v, 1) * trackVolume }))
          : seg.keyframes
      };
      const built = buildSegmentFilters(scaled, idx, label, { sampleRate: sr });
      filterParts.push(built.filter);
      labeled.push(`[${label}]`);
    }
    if (labeled.length === 0) return null;
    if (labeled.length === 1) {
      // 单片段无需 amix，直接改名，省一层开销
      const outLabel = `${trackKind}out`;
      filterParts.push(`${labeled[0]}anull[${outLabel}]`);
      return `[${outLabel}]`;
    }
    const outLabel = `${trackKind}out`;
    // normalize=0：不让 amix 自动按输入数缩小音量，保持各轨相对音量可控
    filterParts.push(`${labeled.join('')}amix=inputs=${labeled.length}:normalize=0:dropout_transition=0[${outLabel}]`);
    return `[${outLabel}]`;
  };

  const musicOut = emitTrack(music, 'music', 1);
  const ambientOut = emitTrack(ambient, 'ambient', ambientVolume);

  if (!musicOut && !ambientOut) {
    return { ok: false, error: '所有片段均不合法，无法生成混音', warnings };
  }

  // 两轨合并
  let mergedLabel;
  if (musicOut && ambientOut) {
    mergedLabel = 'merged';
    filterParts.push(`${musicOut}${ambientOut}amix=inputs=2:normalize=0:dropout_transition=0[${mergedLabel}]`);
  } else {
    mergedLabel = musicOut ? 'musicout' : 'ambientout';
  }

  // 整体响度归一化 + 对齐到成片时长
  const dur = Number.isFinite(videoDuration) && videoDuration > 0 ? videoDuration : null;
  // loudnorm 默认会把流重采样到 192kHz（实测成片落到 96kHz），体积翻倍且无增益。
  // 在其后显式把采样率拨回目标值——这也是历史静音缺陷的同一个坑，必须钉死。
  const norm = `loudnorm=I=${loudness}:TP=-1.5:LRA=11,aformat=sample_rates=${sr}:channel_layouts=stereo`;
  const tail = dur
    ? `${norm},atrim=0:${sec(dur)},asetpts=PTS-STARTPTS`
    : norm;
  filterParts.push(`[${mergedLabel}]${tail}[aout]`);

  return {
    ok: true,
    filterComplex: filterParts.join(';'),
    audioMap: '[aout]',
    inputTracks: inputs,
    totalDuration: dur,
    warnings
  };
}

module.exports = {
  buildMixCommand,
  buildSegmentFilters,
  buildVolumeExpression,
  validateSegment,
  num,
  sec,
  DEFAULT_SAMPLE_RATE,
  SPEED_MIN,
  SPEED_MAX
};
