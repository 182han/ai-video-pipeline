// ==========================================
// USD 预算闸门（真实账单口径）
// ==========================================
// 背景（2026-11-14）：用户账户只剩 $196，且同一账户同时为
// 「文生视频 / 文生图 / 大模型」付费。此前只有前端按人民币余额做提示，
// 服务端没有任何余额概念，重复提交 + 无上限提交都会直接扣钱。
//
// 单价来源（WhaleTV usage-logs-20261108-20261114.csv 的真实扣费）：
//   wan3.0-video  720P  $0.10 / 秒
//   wan3.0-video  1080P $0.20 / 秒
//   wan2.7-image        $0.03 / 张
//   deepseek-v4-flash   实测约 $0.003 / 次（按 token，取保守均值）
// 注意：这是「按成功生成量」的预算估计，不是对账单；实际以网关账单为准。
//
// 状态落在 data/budget.json（原子写），服务重启不丢。
// 测试用 BUDGET_FILE / BUDGET_USD 覆盖，避免污染真实余额。

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = process.env.BUDGET_FILE
  ? path.resolve(process.env.BUDGET_FILE)
  : path.join(DATA_DIR, 'budget.json');

const DEFAULT_BALANCE_USD = (() => {
  const n = parseFloat(process.env.BUDGET_USD);
  return Number.isFinite(n) && n >= 0 ? n : 196;
})();

// 真实单价（美元）。分辨率大小写/别名在这里归一。
const RATES = {
  video: { '480p': 0.05, '720p': 0.10, '1080p': 0.20, '4k': 0.40, '2160p': 0.40 },
  videoFallback: 0.10,
  image: 0.03,
  llmPerCall: 0.003
};

const MAX_ENTRIES = 500;

function round4(n) {
  return Math.round((Number(n) || 0) * 10000) / 10000;
}

function normalizeRes(r) {
  return String(r || '').trim().toLowerCase();
}

function videoRate(resolution) {
  const key = normalizeRes(resolution);
  return RATES.video[key] !== undefined ? RATES.video[key] : RATES.videoFallback;
}

function emptyState() {
  return {
    currency: 'USD',
    initialUsd: DEFAULT_BALANCE_USD,
    balanceUsd: DEFAULT_BALANCE_USD,
    spentUsd: 0,
    updatedAt: new Date().toISOString(),
    entries: []
  };
}

function load() {
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    const j = JSON.parse(raw);
    const state = {
      currency: 'USD',
      initialUsd: Number(j.initialUsd) || 0,
      balanceUsd: Number(j.balanceUsd),
      spentUsd: Number(j.spentUsd) || 0,
      updatedAt: j.updatedAt || new Date().toISOString(),
      entries: Array.isArray(j.entries) ? j.entries.slice(-MAX_ENTRIES) : []
    };
    if (!Number.isFinite(state.balanceUsd) || state.balanceUsd < 0) return emptyState();
    return state;
  } catch (e) {
    return emptyState();
  }
}

let state = load();

function persist() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, FILE);
  } catch (e) {
    console.error('[budget] 写入失败:', e.message);
  }
}

// 首次加载时把初始余额落盘，避免每次重启都按 env 重算
if (!fs.existsSync(FILE)) persist();

function estimateVideo({ clips, seconds, resolution }) {
  const n = Math.max(1, Math.floor(Number(clips) || 1));
  const sec = Math.max(0, Number(seconds) || 0);
  const rate = videoRate(resolution);
  return round4(n * sec * rate);
}

function estimateImage(count) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  return round4(n * RATES.image);
}

function estimateLlm(calls) {
  const n = Math.max(0, Math.floor(Number(calls) || 0));
  return round4(n * RATES.llmPerCall);
}

// 一个视频任务的整单预估：生成秒数 × 分辨率单价 + 可选图片/LLM 附加
function estimateTask({ clips, seconds, resolution, images = 0, llmCalls = 0 }) {
  const video = estimateVideo({ clips, seconds, resolution });
  const image = estimateImage(images);
  const llm = estimateLlm(llmCalls);
  const usd = round4(video + image + llm);
  return {
    usd,
    breakdown: {
      video,
      image,
      llm,
      clips: Math.max(1, Math.floor(Number(clips) || 1)),
      seconds: Math.max(0, Number(seconds) || 0),
      resolution: normalizeRes(resolution),
      videoRate: videoRate(resolution)
    }
  };
}

function status() {
  return {
    currency: 'USD',
    initialUsd: round4(state.initialUsd),
    balanceUsd: round4(state.balanceUsd),
    spentUsd: round4(state.spentUsd),
    updatedAt: state.updatedAt,
    rates: {
      video: { ...RATES.video },
      image: RATES.image,
      llmPerCall: RATES.llmPerCall
    },
    entries: state.entries.slice(-20)
  };
}

function canAfford(usd) {
  const n = Number(usd) || 0;
  if (n <= 0) return true;
  return n <= state.balanceUsd + 1e-9;
}

class InsufficientBudgetError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'InsufficientBudgetError';
    this.code = 'INSUFFICIENT_BUDGET';
    this.detail = detail;
  }
}

// 预留/扣款：成功才扣，失败抛 INSUFFICIENT_BUDGET（调用方转 402）
function reserve({ usd, kind = 'video', taskId = null, meta = null }) {
  const amount = round4(usd);
  if (amount <= 0) return status();
  if (!canAfford(amount)) {
    throw new InsufficientBudgetError(
      `余额不足：本次需要 $${amount.toFixed(2)}，剩余 $${round4(state.balanceUsd).toFixed(2)}`,
      { neededUsd: amount, ...status() }
    );
  }
  state.balanceUsd = round4(state.balanceUsd - amount);
  state.spentUsd = round4(state.spentUsd + amount);
  state.updatedAt = new Date().toISOString();
  state.entries.push({
    at: state.updatedAt,
    kind,
    taskId,
    usd: amount,
    balanceAfterUsd: state.balanceUsd,
    meta: meta || undefined
  });
  if (state.entries.length > MAX_ENTRIES) state.entries = state.entries.slice(-MAX_ENTRIES);
  persist();
  return status();
}

// 任务结束后结算：按「实际成功生成的片段数 × 时长 × 单价」修正预扣。
// - 全部成功：actual = 预扣，退 0；
// - 中途失败：按成功片段数计费，退回没用掉的秒数；
// - 一个都没成功：全额退回。
// 幂等：同一条 video 账目只结算一次（settled 标记）。
function settle(taskId, actualUsd) {
  if (!taskId) return null;
  for (let i = state.entries.length - 1; i >= 0; i--) {
    const e = state.entries[i];
    if (e.kind === 'video' && e.taskId === taskId && !e.settled) {
      const reserved = round4(e.usd);
      const actual = Math.max(0, Math.min(reserved, round4(actualUsd)));
      const refund = round4(reserved - actual);
      if (refund > 0) {
        state.balanceUsd = round4(state.balanceUsd + refund);
        state.spentUsd = Math.max(0, round4(state.spentUsd - refund));
      }
      e.settled = true;
      e.actualUsd = actual;
      e.refundUsd = refund;
      state.updatedAt = new Date().toISOString();
      persist();
      return { taskId, reservedUsd: reserved, actualUsd: actual, refundUsd: refund, balanceUsd: state.balanceUsd };
    }
  }
  return null;
}

// 对账/手动修正：把剩余余额设成实际值（initial 会按 spent 反推，便于审计）
function setBalance(usd) {
  const n = round4(usd);
  if (!Number.isFinite(n) || n < 0) {
    const e = new Error('balanceUsd 必须是非负数');
    e.code = 'BAD_BUDGET';
    throw e;
  }
  state.balanceUsd = n;
  state.initialUsd = round4(n + state.spentUsd);
  state.updatedAt = new Date().toISOString();
  state.entries.push({
    at: state.updatedAt,
    kind: 'set',
    usd: 0,
    balanceAfterUsd: n,
    meta: { note: '手动对账' }
  });
  if (state.entries.length > MAX_ENTRIES) state.entries = state.entries.slice(-MAX_ENTRIES);
  persist();
  return status();
}

module.exports = {
  FILE,
  RATES,
  videoRate,
  estimateVideo,
  estimateImage,
  estimateLlm,
  estimateTask,
  status,
  canAfford,
  reserve,
  settle,
  setBalance,
  InsufficientBudgetError
};
