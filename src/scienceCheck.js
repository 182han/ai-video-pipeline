// 生成前科学预检：只做规则检查，不做图像语义判断（图像语义需人工/视觉模型终审）。
function normalize(s) { return String(s || '').toLowerCase(); }

function checkCard(card) {
  if (!card || !card.science) {
    return { ok: false, level: 'unknown', errors: ['缺少 science 字段'], warnings: [] };
  }
  const s = card.science;
  const errors = [];
  const warnings = [];
  const text = normalize([card.prompt, card.imagePrompt, card.feature].filter(Boolean).join(' '));
  if (s.forbidden) {
    for (const term of String(s.forbidden).split(/[、,，]/).map(x => x.trim()).filter(Boolean)) {
      if (text.includes(normalize(term))) errors.push(`提示词出现禁止项：${term}`);
    }
  }
  if (s.risk === 'high' && card.scienceStatus !== 'passed') {
    warnings.push('高风险题材：生成后必须人工/视觉模型科学审查通过');
  }
  return { ok: errors.length === 0, level: errors.length ? 'fail' : warnings.length ? 'warn' : 'pass', errors, warnings };
}

module.exports = { checkCard };
