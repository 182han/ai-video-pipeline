// ==========================================
// 小智 · 每会话串行队列（2026-11-19 B 目标）
// ------------------------------------------------------------
// 为什么需要：agent 链路是异步的（真实模型 2–4s）。同一会话连发两句时，
// 两个请求会并发跑：可能拿到同一份「当前计划」→ 出两张计划卡 / 乱序覆盖。
// 交接 §10.1 E6 明确要求「每会话串行队列 + 忙碌态」。
//
// 语义：
//   · 同一 sessionId：FIFO 串行；前一句失败不影响后一句（错误被隔离）。
//   · 不同 sessionId：并行，互不阻塞。
//   · 队列在空闲后自动清理（不泄漏 Map）。
// ==========================================
'use strict';

const QUEUE_VERSION = 'assistant-turn-queue.v1';
const chains = new Map(); // key -> 该会话当前队尾 Promise
const counts = new Map(); // key -> 正在排队 + 执行中的任务数

function keyOf(sessionId) {
  const s = String(sessionId === undefined || sessionId === null ? '' : sessionId).trim();
  return s || '(default)';
}

/**
 * 把 fn 排进某会话的串行队列；返回 fn 的结果（成功/失败原样透出）。
 * @param {string} sessionId
 * @param {() => Promise<any>} fn
 */
function enqueue(sessionId, fn) {
  if (typeof fn !== 'function') throw new Error('turnQueue.enqueue 需要函数');
  const key = keyOf(sessionId);
  counts.set(key, (counts.get(key) || 0) + 1);
  const prev = chains.get(key) || Promise.resolve();
  // 前一个任务失败也要继续执行后一个（错误只属于它自己的调用方）。
  const run = prev.then(() => fn(), () => fn());
  const tracked = run.then(
    (value) => { finish(key, tracked); return value; },
    (err) => { finish(key, tracked); throw err; }
  );
  chains.set(key, tracked);
  return run;
}

function finish(key, tracked) {
  const n = (counts.get(key) || 1) - 1;
  if (n <= 0) counts.delete(key); else counts.set(key, n);
  if (chains.get(key) === tracked && n <= 0) chains.delete(key);
}

/** 当前排队/执行中的数量（含正在执行的那个）。 */
function pending(sessionId) {
  return counts.get(keyOf(sessionId)) || 0;
}
function isBusy(sessionId) {
  return pending(sessionId) > 0;
}
/** 仅供测试/诊断：内部 Map 大小（空闲时应为 0）。 */
function _size() {
  return { chains: chains.size, counts: counts.size };
}

module.exports = {
  QUEUE_VERSION,
  enqueue,
  pending,
  isBusy,
  _size
};
