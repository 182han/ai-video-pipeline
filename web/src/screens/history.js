// ============================================================
// 历史记录 + 垃圾箱
// ------------------------------------------------------------
// 接口（已核实）：
//   DELETE /api/tasks/:id           → 移入垃圾箱
//   GET    /api/trash               → 垃圾箱列表
//   POST   /api/trash/:id/restore   → 恢复
//   DELETE /api/trash/:id           → 彻底删除
// 没有批量接口，批量 = 逐条调用（会显示进度与失败数）。
// ============================================================
import { TaskDrawer } from '../components/taskDrawer.js';
import { statusMeta } from '../components/pauseControl.js';

const { React } = window;
const html = window.htm.bind(React.createElement);
const { useEffect, useState } = React;

function fetchJson(url, opt) {
  return fetch(url, { credentials: 'same-origin', ...(opt || {}) })
    .then(async (r) => {
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
      return j;
    });
}

// 打开剪辑台（/app/edit?task=<id>）。用 pushState + popstate 让 shell 重新解析路由，
// 不整页刷新；剪辑台自己会读 location.search 的 task。
function openEdit(taskId) {
  window.history.pushState({}, '', '/app/edit?task=' + encodeURIComponent(taskId));
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function HistoryView({ onChanged }) {
  const [tab, setTab] = useState('all');
  const [tasks, setTasks] = useState([]);
  const [trash, setTrash] = useState([]);
  const [sel, setSel] = useState({});
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [openId, setOpenId] = useState(null);

  async function load() {
    setErr('');
    try {
      if (tab === 'all') {
        const j = await fetchJson('/api/tasks');
        setTasks(Array.isArray(j) ? j : (j.tasks || []));
      } else {
        const j = await fetchJson('/api/trash');
        setTrash(Array.isArray(j) ? j : (j.tasks || j.items || []));
      }
    } catch (e) { setErr(e.message); }
  }

  useEffect(() => { load(); }, [tab]);

  async function moveToTrash(t) {
    if (!window.confirm('把这条记录移入垃圾箱？\n\n' + (t.prompt || '').slice(0, 40))) return;
    setBusy(t.taskId);
    try {
      await fetchJson('/api/tasks/' + encodeURIComponent(t.taskId), { method: 'DELETE' });
      await load();
      if (onChanged) onChanged();
    } catch (e) { setErr('移入垃圾箱失败：' + e.message); }
    finally { setBusy(''); }
  }

  async function restoreOne(id) {
    setBusy(id);
    try {
      await fetchJson('/api/trash/' + encodeURIComponent(id) + '/restore', { method: 'POST' });
      await load();
      if (onChanged) onChanged();
    } catch (e) { setErr('恢复失败：' + e.message); }
    finally { setBusy(''); }
  }

  async function purgeOne(id) {
    setBusy(id);
    try {
      await fetchJson('/api/trash/' + encodeURIComponent(id), { method: 'DELETE' });
      await load();
    } catch (e) { setErr('彻底删除失败：' + e.message); }
    finally { setBusy(''); }
  }

  const selIds = Object.keys(sel).filter((k) => sel[k]);
  const trashIds = trash.map((t) => t.taskId || t.id);

  async function batch(kind) {
    if (!selIds.length) { setErr('先勾选要处理的记录'); return; }
    const label = kind === 'purge' ? '彻底删除' : '恢复';
    if (kind === 'purge' && !window.confirm('彻底删除选中的 ' + selIds.length + ' 条？此操作不可恢复。')) return;
    setErr('');
    let ok = 0, fail = 0;
    for (const id of selIds) {
      try {
        if (kind === 'purge') await fetchJson('/api/trash/' + encodeURIComponent(id), { method: 'DELETE' });
        else await fetchJson('/api/trash/' + encodeURIComponent(id) + '/restore', { method: 'POST' });
        ok++;
      } catch { fail++; }
    }
    setSel({});
    await load();
    if (onChanged) onChanged();
    setErr(`${label}完成：成功 ${ok} 条${fail ? `，失败 ${fail} 条` : ''}`);
  }

  return html`
    <div className="px-6 py-5">
      <div className="flex items-center gap-3 mb-3">
        <h1 className="font-display text-[21px] font-medium tracking-[.02em] text-ink m-0">历史记录</h1>
        <span className="text-[11px] text-ink3 font-num">
          ${tab === 'all' ? tasks.length + ' 条' : '垃圾箱 ' + trash.length + ' 条'}
        </span>
        <span className="flex-1"></span>
        <button onClick=${() => setTab('all')}
          className=${'h-8 px-3 rounded-[6px] text-[12px] ' +
            (tab === 'all' ? 'bg-accent text-onaccent' : 'border border-white/[.10] text-ink2 hover:bg-white/[.05]')}
        >全部</button>
        <button onClick=${() => setTab('trash')}
          className=${'h-8 px-3 rounded-[6px] text-[12px] ' +
            (tab === 'trash' ? 'bg-accent text-onaccent' : 'border border-white/[.10] text-ink2 hover:bg-white/[.05]')}
        >垃圾箱</button>
      </div>

      ${err && html`<p className="mb-2 text-[12px] text-danger">${err}</p>`}

      ${tab === 'trash' && html`
        <div className="flex items-center gap-3 mb-2.5">
          <label className="flex items-center gap-1.5 text-[12px] text-ink2">
            <input type="checkbox"
              checked=${trashIds.length > 0 && selIds.length === trashIds.length}
              onChange=${(e) => {
                const on = e.target.checked;
                const m = {};
                trashIds.forEach((id) => { m[id] = on; });
                setSel(m);
              }}
              className="w-[15px] h-[15px] accent-accent" />
            全选
          </label>
          <span className="text-[11px] text-ink3 font-num">已选 ${selIds.length}</span>
          <span className="flex-1"></span>
          <button onClick=${() => batch('restore')}
            className="h-8 px-3 rounded-[6px] border border-white/[.10] text-[12px] text-ink2 hover:bg-white/[.05]">恢复</button>
          <button onClick=${() => batch('purge')}
            className="h-8 px-3 rounded-[6px] border border-danger/50 text-[12px] text-danger hover:bg-danger/[.08]">彻底删除</button>
        </div>
      `}

      ${tab === 'all' && html`
        ${tasks.length === 0 && html`<p className="py-9 text-center text-[12px] text-ink3">还没有记录</p>`}
        <div className="rounded-[8px] border border-white/[.08] overflow-hidden bg-s1">
          ${tasks.map((t) => {
            const st = statusMeta(t.status, t);
            return html`
              <div key=${t.taskId} className="flex items-center gap-3 px-3 py-2.5 border-b border-white/[.05] last:border-0">
                <span className=${'w-[6px] h-[6px] rounded-full shrink-0 ' + st.dot}></span>
                <button onClick=${() => setOpenId(t.taskId)}
                  className="flex-1 min-w-0 text-left">
                  <b className="block text-[12.5px] font-normal text-ink truncate">
                    ${(t.prompt || '(无提示词)').slice(0, 70)}
                  </b>
                  <span className="block text-[10px] text-ink3 font-num">
                    ${(t.createdAt ? new Date(t.createdAt).toLocaleString('zh-CN') : '-')}
                    ${' · ' + (t.model || '-')}
                    ${t.cost && t.cost.amount != null ? ' · ¥' + Number(t.cost.amount).toFixed(2) : ''}
                  </span>
                </button>
                <span className=${'text-[11px] shrink-0 ' + st.cls}>${st.text}</span>
                ${t.adjust && html`<span className="text-[10px] text-accent shrink-0">已调节</span>`}
                ${['completed', 'partial'].includes(t.status) && t.outputPath && html`
                  <button onClick=${() => openEdit(t.taskId)}
                    className="h-7 px-2 rounded-[5px] text-[11px] text-accent hover:bg-white/[.06]"
                    title="在剪辑台打开调节面板"
                  >剪辑</button>
                `}
                <button onClick=${() => moveToTrash(t)} disabled=${busy === t.taskId}
                  className="h-7 px-2 rounded-[5px] text-[11px] text-ink3 hover:text-danger hover:bg-white/[.06] disabled:opacity-40"
                >删除</button>
              </div>
            `;
          })}
        </div>
      `}

      ${tab === 'trash' && html`
        ${trash.length === 0 && html`<p className="py-9 text-center text-[12px] text-ink3">垃圾箱是空的</p>`}
        <div className="rounded-[8px] border border-white/[.08] overflow-hidden bg-s1">
          ${trash.map((t) => {
            const id = t.taskId || t.id;
            return html`
              <div key=${id} className="flex items-center gap-3 px-3 py-2.5 border-b border-white/[.05] last:border-0">
                <input type="checkbox" checked=${!!sel[id]}
                  onChange=${(e) => setSel((m) => ({ ...m, [id]: e.target.checked }))}
                  className="w-[15px] h-[15px] accent-accent" />
                <span className="flex-1 min-w-0">
                  <b className="block text-[12.5px] font-normal text-ink truncate">
                    ${(t.prompt || '(无提示词)').slice(0, 70)}
                  </b>
                  <span className="block text-[10px] text-ink3 font-num">${t.taskId || id}</span>
                </span>
                <button onClick=${() => restoreOne(id)} disabled=${busy === id}
                  className="h-7 px-2 rounded-[5px] text-[11px] text-ink2 hover:bg-white/[.06] disabled:opacity-40">恢复</button>
                <button onClick=${() => purgeOne(id)} disabled=${busy === id}
                  className="h-7 px-2 rounded-[5px] text-[11px] text-danger hover:bg-white/[.06] disabled:opacity-40">彻底删除</button>
              </div>
            `;
          })}
        </div>
      `}

      ${openId && html`
        <${TaskDrawer} taskId=${openId} onClose=${() => setOpenId(null)} />
      `}
    </div>
  `;
}
