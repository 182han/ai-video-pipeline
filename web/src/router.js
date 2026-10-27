// 极简路由：/app 前缀 + pathname 映射，不引第三方 router。
export function currentRoute() {
  const p = location.pathname.replace(/^\/app/, '') || '/';
  return p === '' ? '/' : p;
}

export function navigate(to) {
  if (to === currentRoute()) return;
  history.pushState({}, '', '/app' + (to === '/' ? '' : to));
  window.dispatchEvent(new PopStateEvent('popstate'));
}
