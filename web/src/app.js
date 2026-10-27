// ============================================================
// Video Studio · React 版入口
// ------------------------------------------------------------
// 零 npm / 零打包：React 与 htm 来自 web/vendor（UMD，挂 window）；
// 浏览器原生 ES Module 加载本文件与各屏组件；样式由 Tailwind 独立 CLI 生成。
// 路由：以 /app 为前缀，pathname 直接映射，不用 hash（见 ./router.js）。
// ============================================================
import { currentRoute } from './router.js';
import { Workbench } from './screens/workbench.js';
import { Boundary } from './components/boundary.js';

const { React, ReactDOM } = window;
const html = window.htm.bind(React.createElement);
const { useEffect, useState } = React;

function Router() {
  const [route, setRoute] = useState(currentRoute());

  useEffect(() => {
    const onPop = () => setRoute(currentRoute());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // 登录页暂仍由 public/login.html 承担（效果已确认）；工作台从 React 起步。
  return html`<${Boundary}><${Workbench} route=${route} /></${Boundary}>`;
}

ReactDOM.createRoot(document.getElementById('root')).render(html`<${Router} />`);
