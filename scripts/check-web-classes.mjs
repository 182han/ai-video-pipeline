// 样式覆盖校验：把组件渲染出的 className 拿去和生成的 app.css 对账，
// 找出「用了但 Tailwind 没生成」的类（这类问题不会报错，只是样式静默失效）。
import fs from 'node:fs';
import path from 'node:path';

const APP = 'C:/Users/14872/Desktop/测试/app';
const css = fs.readFileSync(path.join(APP, 'web/styles/app.css'), 'utf8');
const srcRoot = path.join(APP, 'web/src');

// 从源码里收集 className 字面量（字符串内），够覆盖所有静态类
const classes = new Set();
const skip = /^(flex|grid|block|hidden|inline|static|relative|absolute|fixed|sticky|truncate|underline|italic)$/;
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js')) {
      const s = fs.readFileSync(p, 'utf8');
      const re = /className=(?:"([^"]*)"|\$?\{?['"]([^'"]*)['"]|'([^']*)')/g;
      let m;
      while ((m = re.exec(s))) {
        const raw = m[1] || m[2] || m[3] || '';
        raw.split(/\s+/).forEach((c) => {
          const t = c.trim();
          if (!t || t.indexOf('$') >= 0 || t.indexOf('{') >= 0) return;
          classes.add(t);
        });
      }
      // 模板里带变量的拼接：把 'xxx ' + 形式的常量片段也收进来
      const re2 = /'([a-z][a-z0-9_:./[\]\-]*(?:\s+[a-z][a-z0-9_:./[\]\-]*)*)\s'?\+?/g;
      while ((m = re2.exec(s))) {
        m[1].split(/\s+/).forEach((c) => { if (c && c.indexOf('${') < 0) classes.add(c); });
      }
    }
  }
})(srcRoot);

// Tailwind 的转义规则：把类名里的特殊字符转义后去 CSS 里找
function esc(cls) {
  return cls.replace(/([!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, '\\$1');
}
function hasRule(cls) {
  // Tailwind 会把任意值里的逗号写成 CSS 转义 \2c（后跟空格）
  let e = esc(cls).replace(/,/g, '\\2c ');
  const needle = '.' + e;
  let i = css.indexOf(needle);
  while (i >= 0) {
    const next = css[i + needle.length];
    // 下一个字符是结尾分隔符才算命中；避免 .flex 命中 .flex-col
    if (next === undefined || /[{\s,>:~+)]/.test(next)) return true;
    i = css.indexOf(needle, i + 1);
  }
  // 兜底：任意值类按「值」比对（Tailwind 的转义规则很绕，值对得上即说明规则生成过）
  const m = cls.match(/\[(.+)\]$/);
  if (m) {
    const flat = css.replace(/\\\\2c\\s?/g, ',');
    const val = m[1].replace(/_/g, ' ');
    if (flat.indexOf(val) >= 0) return true;
    const fn = val.match(/[a-z-]*\\([^)]*\\)/i);
    if (fn && flat.indexOf(fn[0]) >= 0) return true;
  }
  return false;
}

const missing = [];
for (const c of classes) {
  if (skip.test(c)) continue;
  if (c.startsWith('group') || c.startsWith('peer')) continue;
  if (!hasRule(c)) missing.push(c);
}

console.log('从源码收集到类名: ' + classes.size);
if (!missing.length) {
  console.log('全部类名都在 app.css 中找到了对应规则 ✓');
} else {
  const uniq = [...new Set(missing)].sort();
  console.log('未生成规则的类名 ' + uniq.length + ' 个：');
  uniq.slice(0, 40).forEach((c) => console.log('  - ' + c));
  if (uniq.length > 40) console.log('  … 其余 ' + (uniq.length - 40) + ' 个省略');
}
