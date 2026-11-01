// UI 预览服务（只给视觉验收用，不碰真实数据、不跑流水线、不接管 3001）
//   · 静态下发 app/web（挂在 /app）
//   · /api/* 全部返回假数据，形状与真实接口一致
//   · 端口默认 3199，可用 PORT 覆盖
// 用法：node scripts/_ui-preview.mjs
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '..');
const WEB = path.join(APP_ROOT, 'web');
const PORT = Number(process.env.PORT || 3199);

const app = express();

// ---------- 假数据 ----------
const now = Date.now();
const iso = (min) => new Date(now - min * 60000).toISOString();

const TASKS = [
  {
    taskId: 'demo_running_01', status: 'paused', prompt: '清晨的喀斯特峰林，低雾在谷间缓慢流动，侧逆光，长焦压缩',
    model: 'seedance', resolution: '1080p', preset: 'final', totalClips: 4, clipDuration: 5,
    createdAt: iso(18), cost: { amount: 3.2 },
    steps: {
      prompt_optimize: { name: '提示词优化', duration: 1200, qcDetails: { passed: true } },
      storyboard: { name: '分镜拆解', duration: 800, qcDetails: { passed: true } },
      clip_generation: { name: '片段生成', duration: 38000, qcDetails: { passed: true } }
    }
  },
  {
    taskId: 'demo_done_02', status: 'completed', prompt: '雪山金光，日照金山，长焦压缩，暖调，缓慢横移',
    model: 'seedance', resolution: '1080p', preset: 'final', totalClips: 2, clipDuration: 10,
    totalDuration: 19.2, createdAt: iso(180), outputPath: 'C:\\demo\\output\\demo_done_02_final.mp4',
    cost: { amount: 3.2 }, colorMatch: { enabled: true },
    steps: {
      prompt_optimize: { name: '提示词优化', duration: 1100, qcDetails: { passed: true } },
      storyboard: { name: '分镜拆解', duration: 700, qcDetails: { passed: true } },
      clip_generation: { name: '片段生成', duration: 61000, qcDetails: { passed: true } },
      concatenation: {
        name: '拼接', duration: 3200,
        qcDetails: { passed: true, colorMatch: { state: 'applied', reason: '已对齐首段色调', applied: 2, total: 2, luts: [{}, {}] } }
      },
      loop_processing: { name: '循环', duration: 2100, qcDetails: { passed: true } },
      audio_mix: { name: '配乐', duration: 1800, qcDetails: { passed: true } },
      transcoding: { name: '转码', duration: 5400, qcDetails: { passed: true } },
      final_qc: {
        name: '终检', duration: 9000,
        qcDetails: {
          passed: true,
          details: {
            colorContinuity: { passed: true, level: 'pass', colorMatchState: 'applied', colorMatchReason: '已对齐首段色调' }
          }
        }
      }
    }
  },
  {
    taskId: 'demo_failed_03', status: 'failed', failureCode: 'pause_timeout', recoverable: true,
    pauseTimedOutAt: iso(60), prompt: '海岸蓝调，浪拍礁石，慢门拉丝',
    model: 'kling', resolution: '720p', totalClips: 3, clipDuration: 5, createdAt: iso(400), cost: { amount: 1.6 }
  },
  {
    taskId: 'demo_done_04', status: 'completed', prompt: '极光在长夜天空流动，前景雪原，冷绿主调',
    model: 'dashscope', resolution: '1080p', totalClips: 3, clipDuration: 8, totalDuration: 23.2,
    createdAt: iso(1440), outputPath: 'C:\\demo\\output\\demo_done_04_final.mp4', cost: { amount: 4.8 }
  }
];

const TRASH = [
  { taskId: 'trash_01', prompt: '废弃：城市夜景车流长曝光', status: 'completed' },
  { taskId: 'trash_02', prompt: '废弃：沙漠日落航拍', status: 'failed' }
];

const BGM = [
  { id: 'm1', title: '山间清晨', cat: '轻音乐', mood: '舒缓宁静', bpm: 72, author: 'Studio A', license: 'CC0', duration: 186 },
  { id: 'm2', title: '海边黄昏', cat: '轻音乐', mood: '空灵梦幻', bpm: 64, author: 'Studio A', license: 'CC0', duration: 204 },
  { id: 'm3', title: '极地风声', cat: '环境音', mood: '自然声景', bpm: 0, author: 'Field Rec', license: 'CC0', duration: 240 }
];

const LIBRARY = {
  groups: [
    {
      label: '1080p', count: 3, totalCost: 4.8, totalDurationSec: 15,
      items: [
        { id: 'c1', url: '/clips/demo1.mp4', prompt: '缓慢推近，雾在流动，侧逆光', model: 'Seedance 2.5', favorite: true },
        { id: 'c2', url: '/clips/demo2.mp4', prompt: '轻微下摇，末段雾散，冷青主调', model: 'Seedance 2.5', favorite: false },
        { id: 'c3', url: '/clips/demo3.mp4', prompt: '几乎不动，只有雾在动，长焦压缩', model: 'Seedance 2.5', favorite: false }
      ]
    },
    {
      label: '720p', count: 1, totalCost: 1.6, totalDurationSec: 10,
      items: [{ id: 'c4', url: '/clips/demo4.mp4', prompt: '横移，前景树枝掠过，暖调金光', model: '可灵', favorite: false }]
    }
  ],
  totals: { count: 4, totalCost: 6.4, totalDurationSec: 25, favorites: 1 },
  facets: { resolutions: ['1080p', '720p'], themes: [], models: ['Seedance 2.5', '可灵'] }
};

const TEMPLATES = {
  landscape: { name: '自然风景', emoji: '🏔', keywords: ['山', '湖', '森林', '日落'], styleEnhancers: ['电影感光线', '黄金时刻'], negative: '人物, 文字, 水印' },
  space: { name: '深空宇宙', emoji: '✦', keywords: ['星云', '银河', '星轨'], styleEnhancers: ['天文摄影', '低噪点'], negative: '人物' },
  sea: { name: '海岸线', emoji: '🌊', keywords: ['礁石', '浪', '蓝调'], styleEnhancers: ['慢门', '拉丝'], negative: '船只' }
};

const QC_ITEMS = [
  { key: 'duration', name: '时长校验' }, { key: 'blackFrame', name: '黑帧检测' },
  { key: 'blur', name: '模糊检测' }, { key: 'nsfw', name: 'NSFW 合规' },
  { key: 'concat', name: '拼接质检' }, { key: 'seam', name: '接缝质量' },
  { key: 'colorContinuity', name: '镜头色彩连续性' }, { key: 'loop', name: '循环质检' },
  { key: 'transcode', name: '转码质检' }, { key: 'final', name: '最终综合质检' }
];

const json = (body) => (req, res) => res.json(body);
app.use(express.json());

app.get('/api/auth/me', json({ authenticated: true, user: { id: 'u1', username: 'preview' } }));
app.get('/api/tasks', json({ tasks: TASKS, total: TASKS.length }));
app.get('/api/tasks/:id', (req, res) => {
  const t = TASKS.find((x) => x.taskId === req.params.id);
  if (!t) return res.status(404).json({ error: '任务不存在' });
  res.json(t);
});
app.get('/api/tasks/:id/pause-state', (req, res) => res.json({ paused: false, status: 'generating' }));
app.get('/api/trash', json(TRASH));
app.get('/api/bgm', json({ tracks: BGM, total: BGM.length, defaultTrackId: 'm1', categoryNames: {}, moodNames: {} }));
app.get('/api/library', json(LIBRARY));
app.get('/api/qc-items', json({ items: QC_ITEMS }));
app.get('/api/models', json([
  { id: 'seedance', name: 'Seedance 2.5（字节）', resolutions: ['480p', '720p'], maxDuration: 30, available: true },
  { id: 'kling', name: '可灵 Kling 3.0（快手）', resolutions: ['720p', '1080p', '4K'], maxDuration: 15, available: true },
  { id: 'dashscope', name: '万相 3.0（DashScope）', resolutions: ['720P', '1080P'], maxDuration: 12, available: false }
]));
app.get('/api/templates', json({ templates: TEMPLATES }));
app.get('/api/rules', json({ rules: '【任务】优化沉浸式环境放松视频提示词，风格：解压治愈延时风光 / 深空宇宙影片，无叙事无剧情。\n约束规则：\n1. 保留用户原始场景主体…\n2. 镜头动态（最重要）：延时摄影…' }));
app.get('/api/users', json({
  users: [{ id: 'u1', username: 'preview', createdAt: iso(10000) }, { id: 'u2', username: 'studio', createdAt: iso(5000) }],
  authEnabled: true, selfId: 'u1'
}));
app.post('/api/test-api-key', json({ success: true, message: '连接正常（预览桩）' }));
app.get('/api/stats', json({ tasks: TASKS.length }));

// ---------- 静态 ----------
app.use('/app', express.static(WEB, { index: false, redirect: false }));
app.get(/^\/app(\/.*)?$/, (req, res) => res.sendFile(path.join(WEB, 'index.html')));

app.listen(PORT, '127.0.0.1', () => {
  console.log('[ui-preview] http://127.0.0.1:' + PORT + '/app  （假数据，勿用于生产）');
});
