// ==========================================
// DashScope 临时文件上传（2026-11-13）
// ------------------------------------------------------------
// 用途：wan3.0 图生视频要求 first_frame 的 url；用户不想用自己的公网存储时，
// 用百炼官方「上传本地文件获取临时 URL」接口：
//   GET  {base}/uploads?action=getPolicy&model=...
//   POST {upload_host}  (multipart)
//   → oss://dashscope-instant/...（48 小时，私有）
// 调用视频接口时需加 Header：X-DashScope-OssResourceResolve: enable
//
// 官方文档：
//   https://help.aliyun.com/zh/model-studio/get-temporary-file-url
//   https://www.alibabacloud.com/help/en/model-studio/wan3-video-generation-api-reference
// ==========================================

const fs = require('fs');
const path = require('path');

function resolveUploadsEndpoint(baseUrl) {
  let b = String(baseUrl || 'https://dashscope.aliyuncs.com/api/v1').trim().replace(/\/+$/, '');
  if (!/\/api\/v1$/i.test(b)) b += '/api/v1';
  return b + '/uploads';
}

function mimeOf(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'image/png';
}

async function getUploadPolicy({ apiKey, baseUrl, model = 'wan3.0-video' } = {}) {
  if (!apiKey) throw new Error('DashScope 临时上传缺少 API Key');
  const url = `${resolveUploadsEndpoint(baseUrl)}?action=getPolicy&model=${encodeURIComponent(model)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(30000)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.message || data.error?.message || data.code || `HTTP ${res.status}`;
    throw new Error(`获取 DashScope 上传凭证失败 (${res.status}): ${msg}`);
  }
  const d = data.data || data;
  if (!d || !d.upload_host || !d.upload_dir) {
    throw new Error('DashScope 上传凭证缺少 upload_host/upload_dir: ' + JSON.stringify(data).slice(0, 200));
  }
  return d;
}

/**
 * 上传一张本地图片到 DashScope 临时 OSS，返回 oss:// 地址。
 * @returns {Promise<{url:string,key:string,expireInSeconds?:number}>}
 */
async function uploadFile(filePath, { apiKey, baseUrl, model = 'wan3.0-video' } = {}) {
  if (!filePath || !fs.existsSync(filePath)) throw new Error('临时上传的文件不存在: ' + filePath);
  const st = fs.statSync(filePath);
  if (!st.isFile() || st.size === 0) throw new Error('临时上传的文件为空');
  const policy = await getUploadPolicy({ apiKey, baseUrl, model });

  const fileName = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}${path.extname(filePath) || '.png'}`;
  const key = `${String(policy.upload_dir).replace(/\/+$/, '')}/${fileName}`;
  const buf = fs.readFileSync(filePath);

  const form = new FormData();
  form.append('OSSAccessKeyId', String(policy.oss_access_key_id || ''));
  form.append('Signature', String(policy.signature || ''));
  form.append('policy', String(policy.policy || ''));
  form.append('x-oss-object-acl', String(policy.x_oss_object_acl || 'private'));
  form.append('x-oss-forbid-overwrite', String(policy.x_oss_forbid_overwrite || 'true'));
  form.append('key', key);
  form.append('success_action_status', '200');
  form.append('file', new Blob([buf], { type: mimeOf(filePath) }), fileName);

  const res = await fetch(policy.upload_host, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(120000)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`DashScope 临时上传失败 (${res.status}): ${text.slice(0, 200)}`);
  }
  return {
    url: `oss://${key}`,
    key,
    expireInSeconds: Number(policy.expire_in_seconds) || null
  };
}

module.exports = { resolveUploadsEndpoint, getUploadPolicy, uploadFile };
