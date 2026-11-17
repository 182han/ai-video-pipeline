// 错误边界：任何一处渲染抛错时，只降级这一块，不再整页白屏。
// 背景：真实数据的字段形态与预期不一致（例如 prompts 是对象数组而非字符串）会让
// React 抛「Objects are not valid as a React child」，整棵树卸载 → 白屏。
// 有了边界，出错时至少能看到「哪一块坏了 + 错误原文」，不至于两眼一抹黑。
const { React } = window;
const html = window.htm.bind(React.createElement);
import { t as tr } from '../i18n/index.js';

export class Boundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { err: null };
  }

  static getDerivedStateFromError(err) {
    return { err };
  }

  componentDidCatch(err, info) {
    // 保留到控制台，方便把原文发回来排查
    console.error('[Boundary]', err, info && info.componentStack);
  }

  render() {
    if (!this.state.err) return this.props.children;
    if (this.props.fallback) return this.props.fallback(this.state.err);
    return html`
      <div className="p-4 text-[12px] text-danger">
        ${tr('editor.boundary.renderFailed', { msg: String(this.state.err && this.state.err.message) })}
      </div>
    `;
  }
}
