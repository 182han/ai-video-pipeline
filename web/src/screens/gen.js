// ============================================================
// 生成中（独立页）：工作流进度 + 暂停/继续 + 退出观看
// ------------------------------------------------------------
// 数据：GET /api/tasks/:id（steps 里的键即已完成/进行中的环节）
// 后端没有 paused 专用事件，父级 JobBar 每 5 秒轮询；这里同样按 4 秒轮询详情。
// ============================================================
import { navigate } from '../router.js';
import { PauseButton, statusMeta, isRunningTask } from '../components/pauseControl.js';

const { React } = window;
const html = window.htm.bind(React.createElement);
const { useEffect, useState } = React;

const STEP_LABEL = {
  prompt_optimize: '提示词优化',
  storyboard: '分镜拆解',
  clip_generation: '视频生成',
  concatenation: '拼接',
  loop_processing: '循环',
  audio_mix: '配乐',
  transcoding: '转码',
  final_qc: '质检'
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
          <p className="font-display text-[20px] text-ink3">当前没有进行中的任务</p>
          <button
            onClick=${() => navigate('/create-smart')}
            className="mt-3 h-9 px-4 rounded-[6px] bg-accent text-onaccent text-[13px]"
          >去创作</button>
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
          ${task.status === 'completed' ? '已完成' : (task.status === 'failed' ? '已结束' : '正在生成')}
        </h1>
        <span className=${'text-[12px] ' + st.cls}>${st.text}</span>
        <span className="flex-1"></span>
        <${PauseButton} taskId=${task.taskId} status=${task.status} onChanged=${() => {}} />
        <button
          onClick=${() => navigate('/')}
          className="h-8 px-3 rounded-[6px] border border-white/[.10] text-[12px] text-ink2 hover:bg-white/[.05]"
        >退出观看</button>
      </div>

      <p className="mt-1.5 text-[12px] text-ink3 font-num">
        ${task.taskId}
        ${cost != null ? ' · 已花 ¥' + Number(cost).toFixed(2) : ''}
        ${task.failureCode ? ' · ' + task.failureCode : ''}
      </p>

      ${st.note && html`
        <p className="mt-2 text-[12px] text-warn">${st.note}${task.recoverable ? ' · 可补跑' : ''}</p>
      `}
      ${err && html`<p className="mt-2 text-[12px] text-danger">${err}</p>`}

      <div className="mt-5 rounded-[8px] border border-white/[.08] bg-s1 px-4 py-3">
        ${STEP_ORDER.map((k) => {
          const isDone = !!(task.steps && task.steps[k]);
          const isRunning = !isDone && k === currentKey && (task.status === 'generating' || task.status === 'paused');
          const dot = isDone ? 'bg-accent' : (isRunning ? 'bg-warn' : 'bg-white/[.14]');
          const label = isDone ? '完成' : (isRunning ? (task.status === 'paused' ? '已暂停' : '进行中') : '等待');
          const step = task.steps && task.steps[k];
          return html`
            <div key=${k} className="flex items-center gap-2.5 py-[7px] border-b border-white/[.05] last:border-0">
              <span className=${'w-[6px] h-[6px] rounded-full ' + dot}></span>
              <span className=${'text-[12.5px] ' + (isDone || isRunning ? 'text-ink' : 'text-ink3')}>
                ${STEP_LABEL[k]}
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
          已完成 ${done.length} / ${STEP_ORDER.length} 个环节
        </span>
        <span className="flex-1"></span>
        <button
          onClick=${() => navigate('/library')}
          className="h-8 px-3 rounded-[6px] border border-white/[.10] text-[12px] text-ink2 hover:bg-white/[.05]"
        >去库看成片</button>
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
