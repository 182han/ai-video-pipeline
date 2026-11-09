// ============================================================
// Video Studio · React 版入口
// ------------------------------------------------------------
// 零 npm / 零打包：React 与 htm 来自 web/vendor（UMD，挂 window）；
// 浏览器原生 ES Module 加载本文件与各屏组件；样式由 Tailwind 独立 CLI 生成。
// 路由：以 /app 为前缀，pathname 直接映射，不用 hash（见 ./router.js）。
// ============================================================
import { currentRoute } from './router.js';
import { AppShell } from './screens/shell.js';
import { Boundary } from './components/boundary.js';

const { React, ReactDOM } = window;
const html = window.htm.bind(React.createElement);
const { useEffect, useState } = React;

function Router() {
  const [route, setRoute] = useState(currentRoute());
  const [stale, setStale] = useState(false);

  useEffect(() => {
    const onPop = () => setRoute(currentRoute());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // 旧进程没有 imageGen 探针；前端文件是新的、后端接口是旧的时会误以为功能已生效。
  // 这里用一个常驻提示，避免「界面有入口、后端报未知类型」再次发生。
  useEffect(() => {
    fetch('/api/status', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (j && !j.imageGen) setStale(true); })
      .catch(() => {});
  }, []);

  // 登录页仍由 public/login.html 承担（效果已确认）；工作台整体挂在 /app。
  return html`
    ${stale && html`
      <div className="fixed bottom-0 left-0 right-0 z-[9999] bg-warn text-black text-center
                      text-[12px] leading-[1.6] py-1.5 px-3">
        服务端代码是旧版本（缺少 imageGen 探针）。当前页面可能已更新，但后端接口还没加载；
        请重启：<code className="font-num">cd app && node server.js</code>
      </div>
    `}
    <${Boundary}><${AppShell} route=${route} /></${Boundary}>
  `;
}

ReactDOM.createRoot(document.getElementById('root')).render(html`<${Router} />`);
