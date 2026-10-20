// ==========================================
// 生成费用：服务端唯一价目表
// ==========================================
//
// 背景（2026-10-20）：
//   价目表此前只手写在 public/index.html 的「创建前费用预估」弹窗里，
//   服务端没有任何价格字段。于是：
//     1) 任务/片段都没有落过费用，事后无法回答「这一段花了多少钱」；
//     2) 前端弹窗、片段库、任务详情三处各写一份价格，迟早对不上。
//   本模块把价目表收敛到服务端，生成时快照进片段（clip.cost），
//   历史片段回填时按当前版本回算并标 backfilled。
//
// 口径（与前端旧弹窗保持一致，避免历史数字前后矛盾）：
//   siliconflow / agnes / seedance —— 按「个」计价（原表按 5 秒标价，一口价）
//   kling / dashscope            —— 按「秒」计价（分辨率不同单价不同）
//   mock                         —— 0 元
//
// 注意：模型 API 不返回账单金额，这里算的是「按价目表 × 实际调用次数」的
// 实际支出估算，不是对账单。账单可能因折扣、汇率、调价而不同。

const PRICE_VERSION = 1;

// Seedance 按具体模型 id 定价（与前端旧表一致）
const SEEDANCE_PRICES = {
  'doubao-seedance-2.0-mini-250928': { unit: 0.58, label: '约¥0.58/个（5秒,480P,4折优惠）' },
  'doubao-seedance-2.0-fast-250928': { unit: 1.86, label: '约¥1.86/个（5秒,480P）' },
  'doubao-seedance-2.0-250928': { unit: 2.31, label: '约¥2.31/个（5秒,480P）' },
  'doubao-seedance-2.5-250928': { unit: 3.36, label: '约¥3.36/个（5秒,480P）' },
  'seedance-2.5': { unit: 3, label: '约¥3.00/个（5秒）' }
};

const PER_CLIP = {
  mock: { unit: 0, label: '测试模式，不产生费用' },
  siliconflow: { unit: 2, label: '¥2.00/个（5秒）' },
  agnes: { unit: 3, label: '¥3.00/个（5秒）' }
};

// 按秒计价：按分辨率取单价
const PER_SECOND = {
  kling: {
    prices: { '4k': 3, '2160p': 3, '1080p': 1.2, '720p': 0.6 },
    fallback: 0.6,
    label: '按秒计价：4K ¥3/s · 1080p ¥1.2/s · 720p ¥0.6/s'
  },
  dashscope: {
    prices: { '1080p': 1.2, '720p': 0.6, '480p': 0.3 },
    fallback: 1.2,
    label: '按秒计价：720P ¥0.6/s · 1080P ¥1.2/s · 480P ¥0.3/s'
  }
};

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function round4(n) {
  return Math.round((Number(n) || 0) * 10000) / 10000;
}

function normalizeResolution(r) {
  return String(r || '').trim().toLowerCase();
}

/**
 * 计算单次调用单价（不含重试次数）。
 *
 * @param {object} opts
 *   model            任务模型 id（mock/siliconflow/agnes/seedance/kling/dashscope）
 *   resolution       分辨率档位（480p/720p/1080p/4K，大小写不敏感）
 *   clipDurationSec  单段时长（秒）；按秒计价的模型必须给
 *   modelId          seedance 的具体模型 id（可选）
 * @returns {{unitPrice:number,basis:string,amountPerAttempt:number,currency:string,label:string,priceVersion:number,detail:string}}
 */
function computeUnitPrice(opts = {}) {
  const model = String(opts.model || '').trim().toLowerCase();
  const resolution = normalizeResolution(opts.resolution);
  const duration = Number(opts.clipDurationSec);
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : null;

  if (!model) {
    return {
      unitPrice: 0,
      basis: 'unknown',
      amountPerAttempt: 0,
      currency: 'CNY',
      label: '未知模型，无法计价',
      priceVersion: PRICE_VERSION,
      detail: 'model 为空'
    };
  }

  if (model === 'mock') {
    return {
      unitPrice: 0,
      basis: 'free',
      amountPerAttempt: 0,
      currency: 'CNY',
      label: PER_CLIP.mock.label,
      priceVersion: PRICE_VERSION,
      detail: 'mock'
    };
  }

  // 按秒计价：kling / dashscope
  if (PER_SECOND[model]) {
    const conf = PER_SECOND[model];
    const perSec = conf.prices[resolution] !== undefined ? conf.prices[resolution] : conf.fallback;
    if (!safeDuration) {
      return {
        unitPrice: perSec,
        basis: 'per_second',
        amountPerAttempt: 0,
        currency: 'CNY',
        label: conf.label,
        priceVersion: PRICE_VERSION,
        detail: `缺少片段时长，无法算出单次金额（单价 ¥${perSec}/s）`
      };
    }
    return {
      unitPrice: perSec,
      basis: 'per_second',
      amountPerAttempt: round2(perSec * safeDuration),
      currency: 'CNY',
      label: conf.label,
      priceVersion: PRICE_VERSION,
      detail: `¥${perSec}/s × ${safeDuration}s`
    };
  }

  // seedance：按具体模型 id 一口价
  if (model === 'seedance') {
    const modelId = String(opts.modelId || '').trim();
    const conf = SEEDANCE_PRICES[modelId] || { unit: 1, label: '约¥1.00/个（未识别型号，按保底价估算）' };
    return {
      unitPrice: conf.unit,
      basis: 'per_clip',
      amountPerAttempt: round2(conf.unit),
      currency: 'CNY',
      label: conf.label,
      priceVersion: PRICE_VERSION,
      detail: modelId ? `型号 ${modelId} 一口价 ¥${conf.unit}/个` : `未传型号，按 ¥${conf.unit}/个 估算`
    };
  }

  // 其余按个计价
  const conf = PER_CLIP[model];
  if (!conf) {
    return {
      unitPrice: 0,
      basis: 'unknown',
      amountPerAttempt: 0,
      currency: 'CNY',
      label: '未知模型，未配置价格',
      priceVersion: PRICE_VERSION,
      detail: `model=${model} 不在价目表内`
    };
  }
  return {
    unitPrice: conf.unit,
    basis: 'per_clip',
    amountPerAttempt: round2(conf.unit),
    currency: 'CNY',
    label: conf.label,
    priceVersion: PRICE_VERSION,
    detail: `一口价 ¥${conf.unit}/个`
  };
}

/**
 * 计算一个片段的实际支出 = 单次单价 × 实际调用次数。
 * attempts 至少按 1 次算；失败但已经发出去的调用同样计费。
 */
function computeClipCost(opts = {}, attempts = 1) {
  const unit = computeUnitPrice(opts);
  const n = Math.max(1, Math.floor(Number(attempts) || 1));
  const amount = round2(unit.amountPerAttempt * n);
  return {
    ...unit,
    attempts: n,
    amount,
    currency: unit.currency || 'CNY',
    computed: unit.basis !== 'unknown',
    backfilled: false
  };
}

function formatCny(amount) {
  return '¥' + (round2(amount)).toFixed(2);
}

module.exports = {
  PRICE_VERSION,
  computeUnitPrice,
  computeClipCost,
  formatCny,
  round2,
  round4,
  PRICE_TABLE: {
    version: PRICE_VERSION,
    perClip: PER_CLIP,
    perSecond: PER_SECOND,
    seedance: SEEDANCE_PRICES
  }
};
