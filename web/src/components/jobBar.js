// ============================================================
// 顶部「后台任务条」：任何页面都能看到正在生成/暂停的任务
// ------------------------------------------------------------
// 后端没有 paused 专用 WS 事件（契约 §4），所以按 5 秒轮询 /api/tasks。
// 只在存在 generating/paused 任务时轮询，空闲时停表。
// ============================================================
const { React } = window;
const html = window.htm.bind(React.createElement);
const { useEffect, useState } = React;

import { navigate } from '../router.js';
import { t as tr, getLocale } from '../i18n/index.js';
import { statusMeta, PauseButton, isRunningTask, callPause } from './pauseControl.js';

const CJK_RE = /[\u3000-\u303F\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/;

// E11：英文界面不显示中文任务名（有 promptEn 用 promptEn，否则英文占位）。
function jobPromptText(task) {
  const t = task || {};
  if (getLocale() !== 'en') return t.prompt || '';
  if (t.promptEn) return String(t.promptEn);
  const raw = String(t.prompt || '');
  if (!raw) return '';
  return CJK_RE.test(raw) ? tr('common.promptEnMissing') : raw;
}

export function useTasksPoll() {
  const [tasks, setTasks] = useState([]);

  useEffect(() => {
    let alive = true;
    let timer = null;

    async function load() {
      try {
        const r = await fetch('/api/tasks', { credentials: 'same-origin' });
        if (!r.ok) return;
        const j = await r.json();
        if (!alive) return;
        setTasks(Array.isArray(j) ? j : (j.tasks || []));
      } catch { /* 轮询失败不打扰用户 */ }
    }

    load();
    timer = setInterval(load, 5000);
    return () => { alive = false; if (timer) clearInterval(timer); };
  }, []);

  return [tasks, () => {
    fetch('/api/tasks', { credentials: 'same-origin' })
      .then((r) => r.json())
      .then((j) => setTasks(Array.isArray(j) ? j : (j.tasks || [])))
      .catch(() => {});
  }];
}

export function JobBar({ tasks, onChanged }) {
  const t = tasks.find(isRunningTask);
  if (!t) return null;
  const st = statusMeta(t.status, t);

  return html`
    <div className="shrink-0 flex items-center gap-3 h-10 px-6 border-b border-white/[.08] bg-warn/[.07]">
      <span className=${'w-[6px] h-[6px] rounded-full ' + st.dot}></span>
      <span className=${'text-[12px] shrink-0 ' + st.cls}>${st.text}</span>
      <span className="text-[12px] text-ink truncate max-w-[560px]">
        ${(jobPromptText(t) || tr('tasks.job.noPrompt')).slice(0, 60)}
      </span>
      <span className="flex-1"></span>
      <${PauseButton} taskId=${t.taskId} status=${t.status} compact=${true} onChanged=${onChanged} />
      <button
        onClick=${() => navigate('/gen')}
        className="h-7 px-2.5 rounded-[5px] text-[12px] text-ink2 hover:bg-white/[.05] transition-colors"
      >${tr('tasks.job.viewProgress')}</button>
    </div>
  `;
}
