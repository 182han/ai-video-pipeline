// ============================================================
// 图生视频（i2v）能力表（2026-11-11）
// ------------------------------------------------------------
// 背景：用户 2026-11-11 明确「人工确认 = 确认后用它继续生成视频」，
// 这与 2026-11-10 记录的「不接 i2v」相反；以用户最新口径为准。
//
// 规则（AGENTS §4.8 不糊弄）：
//   · 只有「请求字段已按厂商官方文档核实 + 代码已实现 + 有离线验收」的模型才列入本表；
//   · 没列入的模型，任务创建阶段直接 400，并在前端说清楚「支持哪些」，
//     绝不在运行时悄悄退化成文生视频（那会让用户以为图生效了）。
//   · 真实计费调用尚未验证（没有用户 Key / 未获计费同意）→ 交付里必须写「真实调用未验证」。
// ============================================================

const MODELS = Object.freeze({
  kling: {
    input: 'bare-base64',
    verified: 'docs',
    note: '可灵 v1：POST /v1/videos/image2video，image 传裸 base64（文档明确禁止 data: 前缀），≤10MB、短边 ≥300px'
  },
  seedance: {
    input: 'data-url',
    verified: 'docs-partial',
    note: '火山官方：content 追加 {type:"image_url", image_url:{url}, role:"first_frame"}；官方称支持 URL / Base64，具体编码形态未实测'
  },
  'openai-video': {
    input: 'json-image-url-or-dataurl',
    verified: 'real-2026-11-16-url-and-dataurl',
    note: 'WhaleTV / new-api：POST /v1/video/generations JSON，image 支持 URL/Base64；'
      + '**公网 URL 与 data URL（data:image/...;base64,...）两条 5 秒任务都已实测 SUCCESS**，'
      + '完成态给 result_url 签名直链（24h）；本地图直接发 data URL，不需要公网图床/代理'
  },
  dashscope: {
    input: 'oss-temp-upload',
    verified: 'docs(temporary-upload)',
    note: 'wan3.0-video：first_frame 用百炼临时上传的 oss://（getPolicy→OSS，48h 私有），请求加 X-DashScope-OssResourceResolve: enable；不需要用户自己的公网存储'
  },
  mock: {
    input: 'none',
    verified: 'n/a',
    note: '合成测试素材，只用于验证链路，不产生费用'
  }
});

function getI2VInfo(model) {
  return Object.prototype.hasOwnProperty.call(MODELS, model) ? MODELS[model] : null;
}

function listI2VModels() {
  return Object.keys(MODELS);
}

module.exports = { MODELS, getI2VInfo, listI2VModels };
