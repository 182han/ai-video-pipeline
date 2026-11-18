// ============================================================
// 生成中（独立页）：工作流进度 + 暂停/继续 + 退出观看
// ------------------------------------------------------------
// 数据：GET /api/tasks/:id（steps 里的键即已完成/进行中的环节）
// 后端没有 paused 专用事件，父级 JobBar 每 5 秒轮询；这里同样按 4 秒轮询详情。
// ============================================================
import { navigate } from '../router.js';
import { t } from '../i18n/index.js';
import { PauseButton, statusMeta, isRunningTask } from '../components/pauseControl.js';
// 2026-11-18：生成中也显示任务名（prompt 摘要 + 模型 + 时间），不再拿原始 taskId 当标题。
import { taskDisplayName, taskShortId } from '../components/taskName.js';

const { React } = window;
const html = window.htm.bind(React.createElement);
const { useEffect, useState } = React;

const STEP_LABEL = {
  prompt_optimize: 'tasks.step.prompt_optimize',
  storyboard: 'tasks.step.storyboard',
  clip_generation: 'tasks.step.clip_generation',
  concatenation: 'tasks.step.concatenation',
  loop_processing: 'tasks.step.loop_processing',
  audio_mix: 'tasks.step.audio_mix',
  transcoding: 'tasks.step.transcoding',
  final_qc: 'tasks.step.final_qc'
};
const STEP_ORDER = Object.keys(STEP_LABEL);

export function GenView({ tasks }) {
  const running = (tasks || []).find(isRunningTask)
    || (tasks || []).slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0]
    || null;

  const [task, setTask] = useState(running);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!running) { setTask(null); return; }
    let alive = true;
    let timer = null;

    async function load() {
      try {
        const r = await fetch('/api/tasks/' + encodeURIComponent(running.taskId), { credentials: 'same-origin' });
        if (!r.ok) return;
        const j = await r.json();
        if (alive) { setTask(j); setErr(''); }
      } catch (e) { if (alive) setErr(e.message); }
    }

    load();
    timer = setInterval(load, 4000);
    return () => { alive = false; if (timer) clearInterval(timer); };
  }, [running && running.taskId]);

  if (!task) {
    return html`
      <div className="h-full grid place-items-center">
        <div className="text-center">
          <p className="font-display text-[20px] text-ink3">${t('gen.noTask')}</p>
          <button
            onClick=${() => navigate('/create-smart')}
            className="mt-3 h-9 px-4 rounded-[6px] bg-accent text-onaccent text-[13px]"
          >${t('gen.goCreate')}</button>
        </div>
      </div>
    `;
  }

  const st = statusMeta(task.status, task);
  const done = STEP_ORDER.filter((k) => task.steps && task.steps[k]);
  const currentKey = STEP_ORDER.find((k) => !(task.steps && task.steps[k]));
  const cost = task.cost && task.cost.amount != null ? task.cost.amount : null;

  return html`
    <div className="mx-auto w-full max-w-[760px] px-7 py-7">
      <div className="flex items-center gap-3">
        <h1 className="font-display text-[21px] font-medium tracking-[.02em] text-ink m-0">
          ${task.status === 'completed' ? t('gen.title.completed') : (task.status === 'failed' ? t('gen.title.failed') : t('gen.title.generating'))}
        </h1>
        <span className=${'text-[12px] ' + st.cls}>${st.text}</span>
        <span className="flex-1"></span>
        <${PauseButton} taskId=${task.taskId} status=${task.status} onChanged=${() => {}} />
        <button
          onClick=${() => navigate('/')}
          className="h-8 px-3 rounded-[6px] border border-white/[.10] text-[12px] text-ink2 hover:bg-white/[.05]"
        >${t('gen.exit')}</button>
      </div>

      <p className="mt-1.5 text-[12px] text-ink3">
        <span title=${t('tasks.taskIdTooltip', { id: task.taskId })}>${taskDisplayName(task)}</span>
        <span className="font-num"> · ${t('tasks.shortId', { id: taskShortId(task.taskId) })}</span>
        ${cost != null ? t('gen.spent', { amount: Number(cost).toFixed(2) }) : ''}
        ${task.failureCode ? ' · ' + task.failureCode : ''}
      </p>

      ${st.note && html`
        <p className="mt-2 text-[12px] text-warn">${st.note}${task.recoverable ? t('gen.resumable') : ''}</p>
      `}
      ${err && html`<p className="mt-2 text-[12px] text-danger">${err}</p>`}

      <div className="mt-5 rounded-[8px] border border-white/[.08] bg-s1 px-4 py-3">
        ${STEP_ORDER.map((k) => {
          const isDone = !!(task.steps && task.steps[k]);
          const isRunning = !isDone && k === currentKey && (task.status === 'generating' || task.status === 'paused');
          const dot = isDone ? 'bg-accent' : (isRunning ? 'bg-warn' : 'bg-white/[.14]');
          const label = isDone ? t('gen.stepState.done') : (isRunning ? (task.status === 'paused' ? t('gen.stepState.paused') : t('gen.stepState.running')) : t('gen.stepState.waiting'));
          const step = task.steps && task.steps[k];
          return html`
            <div key=${k} className="flex items-center gap-2.5 py-[7px] border-b border-white/[.05] last:border-0">
              <span className=${'w-[6px] h-[6px] rounded-full ' + dot}></span>
              <span className=${'text-[12.5px] ' + (isDone || isRunning ? 'text-ink' : 'text-ink3')}>
                ${t(STEP_LABEL[k])}
              </span>
              <span className="flex-1"></span>
              ${step && step.duration > 0 && html`
                <span className="text-[10px] text-ink3 font-num">${step.duration}ms</span>
              `}
              <span className="text-[11px] text-ink3">${label}</span>
            </div>
          `;
        })}
      </div>

      <div className="mt-4 flex items-center gap-3">
        <span className="text-[11px] text-ink3">
          ${t('gen.progress', { done: done.length, total: STEP_ORDER.length })}
        </span>
        <span className="flex-1"></span>
        <button
          onClick=${() => navigate('/library')}
          className="h-8 px-3 rounded-[6px] border border-white/[.10] text-[12px] text-ink2 hover:bg-white/[.05]"
        >${t('gen.openLibrary')}</button>
      </div>

      ${task.outputPath && html`
        <div className="mt-4">
          <video
            className="w-full rounded-[6px] bg-black"
            src=${'/output/' + encodeURIComponent(String(task.outputPath).split(/[\\/]/).pop())}
            controls preload="metadata" playsInline
          ></video>
        </div>
      `}
    </div>
  `;
}
