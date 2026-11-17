// ============================================================
// 产出屏：成片 + 质检 + 导出（2026-11-16 P6 已下线）
// ------------------------------------------------------------
// 状态：**入口与路由已移除**（shell.js 不再 import / 渲染；/output 深链落到「库 · 成片」）。
//   留存原因：保留旧实现作对照，删除死代码需用户同意（AGENTS.md §6）。
//   成片播放/下载/质检徽章已并入库页「成片」tab（inventory.js FinalsPanel）。
// 若将来恢复本页，下面的数据来源说明仍有效：
// ------------------------------------------------------------
// 数据来源：
//   GET /api/qc-items   → { qcItems: [...13 项...], pipelineSteps }
//   GET /api/tasks      → 列表（取最近一条已完成任务作为默认成片）
//   GET /api/tasks/:id  → 详情（finalQC / steps / outputPath）
// 质检清单**从接口取**，不在前端硬编码，避免后端新增检测项时前端漂移。
// 语义严格四态（AGENTS §4.1）：通过 / 不通过 / 按计划跳过 / 未执行。
// ============================================================
const { React } = window;
const html = window.htm.bind(React.createElement);
const { useEffect, useMemo, useState } = React;

import { t as tr } from '../i18n/index.js';

function toOutputUrl(p) {
  if (!p) return null;
  const name = String(p).split(/[\\/]/).pop();
  return name ? '/output/' + encodeURIComponent(name) : null;
}

// 四态判定：顺序很重要，先判 passed，再判合法跳过
function qcState(r) {
  if (!r) return { key: 'missing', text: tr('output.qcState.missing'), cls: 'text-ink3', dot: 'bg-ink3' };
  if (r.passed === true && r.skipped !== true) return { key: 'pass', text: tr('output.qcState.pass'), cls: 'text-accent', dot: 'bg-accent' };
  if (r.legitimateSkip === true) return { key: 'skip', text: tr('output.qcState.skip'), cls: 'text-ink3', dot: 'bg-ink3' };
  if (r.skipped === true) return { key: 'notrun', text: tr('output.qcState.notrun'), cls: 'text-danger', dot: 'bg-danger' };
  if (r.level === 'warn') return { key: 'warn', text: tr('output.qcState.warn'), cls: 'text-warn', dot: 'bg-warn' };
  return { key: 'fail', text: tr('output.qcState.fail'), cls: 'text-danger', dot: 'bg-danger' };
}

// 校色状态（与「镜头色彩连续性」是两件事：这说「有没有做」，那说「做没做好」）
function colorMatchTag(state, reason) {
  switch (state) {
    case 'applied': return { text: tr('output.color.applied'), cls: 'text-accent', title: reason || tr('output.color.appliedTitle') };
    case 'disabled': return { text: tr('output.color.disabled'), cls: 'text-ink3', title: reason || tr('output.color.disabledTitle') };
    case 'skipped': return { text: tr('output.color.skipped'), cls: 'text-warn', title: reason || tr('output.color.skippedTitle') };
    case 'failed': return { text: tr('output.color.failed'), cls: 'text-danger', title: (reason || '') + tr('output.color.failedTitle') };
    default: return null;
  }
}

function useJson(url) {
  const [s, setS] = useState({ loading: true, data: null, error: null });
  useEffect(() => {
    let alive = true;
    setS({ loading: true, data: null, error: null });
    fetch(url, { credentials: 'same-origin' })
      .then(async (r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then((d) => { if (alive) setS({ loading: false, data: d, error: null }); })
      .catch((e) => { if (alive) setS({ loading: false, data: null, error: e.message }); });
    return () => { alive = false; };
  }, [url]);
  return s;
}

export function OutputScreen() {
  const listRes = useJson('/api/tasks');
  const qcRes = useJson('/api/qc-items');
  const [taskId, setTaskId] = useState(null);

  // 默认选最近一条有 outputPath 的任务
  const candidates = useMemo(() => {
    const arr = listRes.data && (Array.isArray(listRes.data) ? listRes.data : listRes.data.tasks) || [];
    return arr.filter((t) => t.status === 'completed' || t.status === 'partial');
  }, [listRes.data]);

  useEffect(() => {
    if (!taskId && candidates.length > 0) setTaskId(candidates[0].taskId);
  }, [candidates, taskId]);

  const detailRes = useJson(taskId ? '/api/tasks/' + encodeURIComponent(taskId) : '/api/tasks/none');
  const task = detailRes.data;
  const qcItems = (qcRes.data && qcRes.data.qcItems) || [];

  const videoUrl = task ? toOutputUrl(task.outputPath) : null;
  // checkFinal 的返回是 { passed, qcVersion, reason, details: { 各检测项 }, fileInfo }
  // 检测结果在 details 里，不是 results。
  const finalResults = (task && task.finalQC && task.finalQC.details) || {};

  // 统计（按四态分开数，不合并）
  const stats = { pass: 0, fail: 0, skip: 0, missing: 0, warn: 0 };
  for (const it of qcItems) {
    const st = qcState(finalResults[it.key]);
    stats[st.key] = (stats[st.key] || 0) + 1;
  }

  return html`
    <div className="flex-1 min-h-0 overflow-auto">
      <div className="mx-auto w-full max-w-[1240px] px-7 py-7">

        <div className="flex items-baseline gap-3">
          <h2 className="font-display text-[26px] tracking-[.02em] text-ink">${tr('output.title')}</h2>
          ${candidates.length > 0 && html`
            <select
              value=${taskId || ''}
              onChange=${(e) => setTaskId(e.target.value)}
              className="h-8 max-w-[420px] rounded-[5px] border border-white/[.08] bg-s3 px-2 text-[12px] text-ink"
            >
              ${candidates.map((t) => html`
                <option key=${t.taskId} value=${t.taskId}>
                  ${(t.prompt || t.taskId).slice(0, 46)}
                </option>
              `)}
            </select>
          `}
          <span className="flex-1"></span>
          <span className="text-[11px] text-ink3 font-num">
            ${tr('output.qcCount', { n: qcItems.length })}
          </span>
        </div>

        ${!taskId && !listRes.loading && html`
          <p className="mt-6 text-[13px] text-ink3">${tr('output.noFinal')}</p>
        `}

        ${task && html`
          <div className="mt-5 grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] gap-6 items-start">

            <!-- 左：成片 -->
            <div>
              <div className="relative rounded-[8px] overflow-hidden bg-black">
                ${videoUrl
                  ? html`<video src=${videoUrl} controls preload="metadata" playsInline
                          className="w-full aspect-video bg-black"></video>`
                  : html`<div className="aspect-video grid place-items-center text-[12px] text-white/60">${tr('output.noVideo')}</div>`}
              </div>

              <div className="mt-3 flex items-center gap-2 flex-wrap">
                <span className="text-[11px] text-ink3 font-num">
                  ${task.resolution || '-'} · ${tr('output.clips', { n: task.totalClips || 0 })} · ${task.totalDuration ? task.totalDuration + 's' : '-'}
                </span>
                <span className="flex-1"></span>
                ${videoUrl && html`
                  <a
                    href=${videoUrl}
                    download
                    className="h-9 px-4 rounded-[6px] bg-accent text-onaccent text-[13px] inline-flex items-center hover:bg-[#095737] transition-colors"
                  >${tr('output.export')}</a>
                `}
                <button
                  disabled
                  title=${tr('output.regenerateTitle')}
                  className="h-9 px-3 rounded-[6px] border border-white/[.10] text-[13px] text-ink2 opacity-40 cursor-not-allowed"
                >${tr('output.regenerate')}</button>
              </div>

              <p className="mt-3 text-[12px] leading-[1.75] text-ink2 line-clamp-3">
                ${task.optimizedPrompt || task.prompt || ''}
              </p>
            </div>

            <!-- 右：质检 -->
            <div>
              <div className="flex items-center gap-3">
                <h3 className="text-[13px] font-medium text-ink">${tr('output.qc')}</h3>
                <span className="flex items-center gap-2 text-[11px] font-num">
                  <span className="text-accent">${tr('output.stats.pass', { n: stats.pass })}</span>
                  <span className="text-danger">${tr('output.stats.fail', { n: stats.fail })}</span>
                  <span className="text-warn">${tr('output.stats.warn', { n: stats.warn })}</span>
                  <span className="text-ink3">${tr('output.stats.skip', { n: stats.skip })}</span>
                  <span className="text-ink3">${tr('output.stats.missing', { n: stats.missing })}</span>
                </span>
              </div>

              <ul className="mt-2 divide-y divide-white/[.05] rounded-[8px] border border-white/[.07] bg-s3 px-3">
                ${qcItems.map((it) => {
                  const r = finalResults[it.key];
                  const st = qcState(r);
                  return html`
                    <li key=${it.key} className="py-[7px]">
                      <div className="flex items-center gap-2">
                        <span className=${'w-[6px] h-[6px] rounded-full shrink-0 ' + st.dot}></span>
                        <span className="text-[12px] text-ink">${it.name}</span>
                        <span className="flex-1"></span>
                        ${it.key === 'colorContinuity' && r && (() => {
                          const tag = colorMatchTag(r.colorMatchState, r.colorMatchReason);
                          return tag
                            ? html`<span className=${'text-[10px] shrink-0 ' + tag.cls} title=${tag.title}>${tag.text}</span>`
                            : null;
                        })()}
                        <span className=${'text-[11px] shrink-0 ' + st.cls}>${st.text}</span>
                      </div>
                      ${r && r.reason && html`
                        <p className="mt-1 ml-[14px] text-[10px] leading-[1.6] text-ink3">${r.reason}</p>
                      `}
                    </li>
                  `;
                })}
              </ul>
              ${qcRes.error && html`<p className="mt-2 text-[11px] text-danger">${tr('output.qcLoadFailed')}${qcRes.error}</p>`}
            </div>
          </div>
        `}

        ${task && task.finalQC && task.finalQC.passed === false && !task.finalQC.skipped && html`
          <p className="mt-5 text-[12px] text-danger">
            ${tr('output.finalQcFail')}
          </p>
        `}
      </div>
    </div>
  `;
}
