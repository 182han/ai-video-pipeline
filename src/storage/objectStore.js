// ==========================================
// 对象存储 - 上传视频等大文件
// ==========================================
// 同时支持：
//   Supabase Storage  (S3 兼容端点)
//   Cloudflare R2     (S3 兼容端点)
//   阿里云 OSS / MinIO / 任何 S3 兼容服务
//
// 通过 .env 的 STORAGE_DRIVER 选择：
//   ''          本地磁盘（不上传）
//   'supabase'  Supabase Storage
//   's3'        通用 S3 / R2 / OSS
//
// 设计原则：
//   1. 上传失败不影响主流程 —— 视频仍在本地，只是没有云端副本
//   2. 上传结果写进 video_assets 表，库里只存 URL 和元数据
//   3. 幂等 —— 同一文件重复上传会覆盖，不会产生副本
// ==========================================

const fs = require('fs');
const path = require('path');
const config = require('../../config');

let client = null;
let s3Mod = null;

// Supabase Storage 其实是 S3 兼容服务，端点格式：
//   https://<project-ref>.supabase.co/storage/v1/s3
function resolveEndpoint() {
  const driver = (config.STORAGE_DRIVER || '').toLowerCase();

  if (driver === 'supabase') {
    if (!config.SUPABASE_URL) {
      throw new Error('STORAGE_DRIVER=supabase 时需设置 SUPABASE_URL');
    }
    return config.SUPABASE_URL.replace(/\/+$/, '') + '/storage/v1/s3';
  }

  if (config.STORAGE.s3.endpoint) {
    return config.STORAGE.s3.endpoint.replace(/\/+$/, '');
  }
  return '';
}

function resolveCredentials() {
  const driver = (config.STORAGE_DRIVER || '').toLowerCase();

  if (driver === 'supabase') {
    // Supabase 的 S3 凭证：
    //   AccessKeyId     = 项目的 project ref（从 URL 提取）
    //   SecretAccessKey = service_role 密钥
    //
    // ⚠️ 重要：Supabase 的 S3 协议目前只认「旧版 JWT 格式」的 service_role key
    //    （以 eyJ 开头，200+ 字符）。新版 sb_secret_... 用于 REST/Storage HTTP API，
    //    是否能通过 S3 签名验证取决于项目配置，不一定可用。
    //    如果上传报签名错误，请到 Settings -> API Keys -> Legacy API keys 复制 JWT 版。
    const m = String(config.SUPABASE_URL || '').match(/https:\/\/([^.]+)\.supabase\.co/);
    return {
      accessKeyId: m ? m[1] : '',
      secretAccessKey: config.SUPABASE_SERVICE_KEY || '',
      bucket: config.SUPABASE_BUCKET || 'videos',
      isLegacyJwt: String(config.SUPABASE_SERVICE_KEY || '').startsWith('eyJ')
    };
  }

  return {
    accessKeyId: config.STORAGE.s3.accessKeyId,
    secretAccessKey: config.STORAGE.s3.secretAccessKey,
    bucket: config.STORAGE.s3.bucket
  };
}

function isEnabled() {
  const driver = (config.STORAGE_DRIVER || '').toLowerCase();
  if (!driver) return false;
  const c = resolveCredentials();
  return !!(c.accessKeyId && c.secretAccessKey && c.bucket);
}

function getClient() {
  if (client) return client;
  if (!s3Mod) {
    try {
      s3Mod = require('@aws-sdk/client-s3');
    } catch (e) {
      throw new Error('上传功能需要依赖：npm install @aws-sdk/client-s3');
    }
  }
  const cred = resolveCredentials();
  client = new s3Mod.S3Client({
    region: config.STORAGE.s3.region || 'auto',
    endpoint: resolveEndpoint(),
    credentials: {
      accessKeyId: cred.accessKeyId,
      secretAccessKey: cred.secretAccessKey
    },
    // Supabase / R2 / MinIO 都要求 path-style
    forcePathStyle: true
  });
  return client;
}

/**
 * 生成对象在 bucket 里的路径。
 * 形如：tasks/task_mv4v7qp2_m8r0/clip_1.mp4
 */
function buildKey(localPath, opts = {}) {
  const name = path.basename(localPath);
  if (opts.taskId) {
    return `tasks/${opts.taskId}/${name}`;
  }
  return `misc/${name}`;
}

/**
 * 生成文件的可访问 URL。
 * Supabase public bucket: <SUPABASE_URL>/storage/v1/object/public/<bucket>/<key>
 * 通用 S3/R2: 若配了 PUBLIC_BASE_URL 用它，否则用 endpoint + bucket + key
 */
function buildPublicUrl(key) {
  const driver = (config.STORAGE_DRIVER || '').toLowerCase();
  const cred = resolveCredentials();

  if (config.STORAGE_PUBLIC_BASE_URL) {
    return config.STORAGE_PUBLIC_BASE_URL.replace(/\/+$/, '') + '/' + key;
  }

  if (driver === 'supabase') {
    return `${String(config.SUPABASE_URL).replace(/\/+$/, '')}/storage/v1/object/public/${cred.bucket}/${key}`;
  }

  const ep = resolveEndpoint();
  return ep ? `${ep}/${cred.bucket}/${key}` : '';
}

/**
 * 上传单个文件。
 * @returns {Promise<{success:boolean, url?:string, key?:string, sizeBytes?:number, error?:string}>}
 */
async function uploadFile(localPath, opts = {}) {
  if (!isEnabled()) {
    return { success: false, error: '对象存储未启用（检查 .env 的 STORAGE_DRIVER 与凭证）' };
  }
  if (!fs.existsSync(localPath)) {
    return { success: false, error: '文件不存在: ' + localPath };
  }

  const stat = fs.statSync(localPath);
  if (stat.size === 0) {
    return { success: false, error: '文件为空，跳过' };
  }

  const cred = resolveCredentials();
  const key = opts.key || buildKey(localPath, opts);

  // 新版 sb_secret_ key 走 HTTP Storage API（不依赖 S3 签名）
  // 旧版 JWT key 走 S3 协议
  const useRest = (config.STORAGE_DRIVER || '').toLowerCase() === 'supabase' && !cred.isLegacyJwt;

  try {
    if (useRest) {
      await uploadViaRest(localPath, key, cred, opts);
    } else {
      const s3 = getClient();
      await s3.send(new s3Mod.PutObjectCommand({
        Bucket: cred.bucket,
        Key: key,
        Body: fs.createReadStream(localPath),
        ContentType: opts.contentType || 'video/mp4',
        ContentLength: stat.size
      }));
    }

    return {
      success: true,
      key,
      url: buildPublicUrl(key),
      sizeBytes: stat.size,
      method: useRest ? 'rest' : 's3'
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * 通过 Supabase Storage HTTP API 上传（适用于新版 sb_secret_ key）。
 * POST <SUPABASE_URL>/storage/v1/object/<bucket>/<key>
 * 注意：重复上传默认报 400，需要 x-upsert: true 覆盖。
 */
async function uploadViaRest(localPath, key, cred, opts = {}) {
  const base = String(config.SUPABASE_URL || '').replace(/\/+$/, '');
  const url = `${base}/storage/v1/object/${cred.bucket}/${key}`;
  const body = fs.readFileSync(localPath);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + cred.secretAccessKey,
      'Content-Type': opts.contentType || 'video/mp4',
      'x-upsert': 'true',
      'cache-control': 'max-age=31536000'
    },
    body
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Storage API ${res.status}: ${text.slice(0, 200)}`);
  }
}

/**
 * 检查对象是否已存在（避免重复上传）。
 */
async function exists(key) {
  if (!isEnabled()) return false;
  try {
    const cred = resolveCredentials();
    const s3 = getClient();
    await s3.send(new s3Mod.HeadObjectCommand({ Bucket: cred.bucket, Key: key }));
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 探测存储是否可用（启动自检用）。
 */
async function healthCheck() {
  if (!isEnabled()) {
    return { ok: false, reason: '未启用' };
  }

  const cred = resolveCredentials();
  const driver = (config.STORAGE_DRIVER || '').toLowerCase();

  // 新版 key 用 REST 探测：列出 bucket（验证 key 与 bucket 都存在）
  if (driver === 'supabase' && !cred.isLegacyJwt) {
    const base = String(config.SUPABASE_URL || '').replace(/\/+$/, '');
    try {
      const res = await fetch(`${base}/storage/v1/bucket`, {
        headers: { Authorization: 'Bearer ' + cred.secretAccessKey }
      });
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        return { ok: false, reason: `HTTP ${res.status}: ${t.slice(0, 150)}`, method: 'rest' };
      }
      const buckets = await res.json().catch(() => []);
      const names = Array.isArray(buckets) ? buckets.map(b => b.name || b.id) : [];
      const hasBucket = names.includes(cred.bucket);
      if (!hasBucket) {
        return {
          ok: false,
          method: 'rest',
          reason: `bucket "${cred.bucket}" 不存在。现有 bucket: ${names.join(', ') || '(无)'}`
        };
      }
      return { ok: true, bucket: cred.bucket, method: 'rest', buckets: names };
    } catch (e) {
      return { ok: false, reason: e.message, method: 'rest' };
    }
  }

  // 旧版 JWT key 或通用 S3：走 S3 协议
  try {
    const s3 = getClient();
    await s3.send(new s3Mod.ListObjectsV2Command({ Bucket: cred.bucket, MaxKeys: 1 }));
    return { ok: true, bucket: cred.bucket, endpoint: resolveEndpoint(), method: 's3' };
  } catch (e) {
    return { ok: false, reason: e.message, method: 's3' };
  }
}

module.exports = {
  isEnabled,
  uploadFile,
  exists,
  healthCheck,
  buildKey,
  buildPublicUrl
};
