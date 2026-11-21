// ==========================================
// WebSocket 管理器 - 实时推送进度
// ==========================================

const { WebSocketServer } = require('ws');
// P2：连接级语言从握手 cookie 解析；事件只新增可选 lang / key / params，既有字段不变。
const i18n = require('./i18n');
// 2026-11-21：简报按连接语言渲染（broadcast.render 是纯函数）。
// **必须延迟 require**：taskManager → wsManager → broadcast → taskManager 是一条已存在的环，
// 在模块顶层 require broadcast 会让 broadcast 在环里先拿到**未完成**的 taskManager
// （verify-assistant 实测报 `taskManager.getAllTasks is not a function`）。
// 改成首次使用时再取，环解开。
let _assistantBroadcastModule = null;
function assistantBroadcastModule() {
  if (!_assistantBroadcastModule) _assistantBroadcastModule = require('./assistant/broadcast');
  return _assistantBroadcastModule;
}

class WebSocketManager {
  constructor() {
    this.wss = null;
    this.clients = new Map(); // clientId -> ws
    this.taskSubscriptions = new Map(); // taskId -> Set of clientIds
    // P2：clientId -> 'zh' | 'en'（按握手 cookie vs_lang / Accept-Language 解析）
    this.clientLang = new Map();
  }

  /**
   * @param {import('http').Server} server
   * @param {{authorize?: (req: any) => any}|null} [options]
   *   options.authorize: 握手鉴权函数，返回假值则拒绝握手（HTTP 401）。
   *   不传 = 与改造前行为一致（不鉴权），保持旧调用方式可用。
   */
  init(server, options) {
    const authorize = options && typeof options.authorize === 'function' ? options.authorize : null;
    const wsOptions = { server, path: '/ws' };

    if (authorize) {
      // 握手阶段就校验会话 cookie：未登录的客户端连不上，也就订阅不到任务进度
      wsOptions.verifyClient = (info, cb) => {
        let session = null;
        try { session = authorize(info.req); } catch (e) { session = null; }
        if (session) {
          info.req.auth = session;
          return cb(true);
        }
        // 4001 让前端能区分「未登录」和「服务没起来」
        return cb(false, 401, 'Unauthorized');
      };
    }

    this.wss = new WebSocketServer(wsOptions);

    this.wss.on('connection', (ws, req) => {
      const clientId = this._generateId();
      const who = req && req.auth && req.auth.username ? req.auth.username : '匿名';
      // P2：连接级语言（握手请求同样带 cookie；解析失败回退 zh，不改变任何既有行为）
      const lang = i18n.langFromRequest(req);
      this.clients.set(clientId, ws);
      this.clientLang.set(clientId, lang);
      console.log(`[WS] 客户端连接: ${clientId} (${who})`);

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this._handleMessage(clientId, ws, msg);
        } catch (e) {
          console.error('[WS] 消息解析失败:', e.message);
        }
      });

      ws.on('close', () => {
        console.log(`[WS] 客户端断开: ${clientId}`);
        this._cleanupClient(clientId);
      });

      ws.on('error', (err) => {
        console.error(`[WS] 客户端错误 ${clientId}:`, err.message);
        this._cleanupClient(clientId);
      });
    });

    console.log('[WS] WebSocket 服务已启动');
  }

  _generateId() {
    return 'client_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 6);
  }

  _handleMessage(clientId, ws, msg) {
    switch (msg.type) {
      case 'subscribe':
        // 订阅某个任务的进度
        this._subscribeTask(clientId, msg.taskId);
        break;
      case 'unsubscribe':
        this._unsubscribeTask(clientId, msg.taskId);
        break;
      default:
        console.log('[WS] 未知消息类型:', msg.type);
    }
  }

  _subscribeTask(clientId, taskId) {
    if (!this.taskSubscriptions.has(taskId)) {
      this.taskSubscriptions.set(taskId, new Set());
    }
    this.taskSubscriptions.get(taskId).add(clientId);
    console.log(`[WS] ${clientId} 订阅任务 ${taskId}`);
  }

  _unsubscribeTask(clientId, taskId) {
    if (this.taskSubscriptions.has(taskId)) {
      this.taskSubscriptions.get(taskId).delete(clientId);
      if (this.taskSubscriptions.get(taskId).size === 0) {
        this.taskSubscriptions.delete(taskId);
      }
    }
  }

  _cleanupClient(clientId) {
    this.clients.delete(clientId);
    this.clientLang.delete(clientId);
    // 从所有任务订阅中移除
    for (const [taskId, clients] of this.taskSubscriptions) {
      clients.delete(clientId);
      if (clients.size === 0) {
        this.taskSubscriptions.delete(taskId);
      }
    }
  }

  // P2：单连接发送。每条事件都追加 `lang`（加法式）——前端可按连接语言本地化日志，
  // 旧前端忽略未知字段即可。发送失败不影响其它订阅者。
  _sendTo(clientId, payload) {
    const ws = this.clients.get(clientId);
    if (!ws || ws.readyState !== 1) return false;
    try {
      ws.send(JSON.stringify({
        ...payload,
        lang: this.clientLang.get(clientId) || i18n.DEFAULT_LANG
      }));
      return true;
    } catch (e) {
      return false;
    }
  }

  // ==========================================
  // 2026-11-17 V2：小智任务播报（全局，不依赖任务订阅）
  // ------------------------------------------------------------
  // 与 broadcastProgress 不同：播报是「全局关键节点」，任何已登录客户端都该收到；
  // 因此不查 taskSubscriptions，直接推给全部 OPEN 连接。
  // 前端 WS 客户端在 i18n 提交后接入（本轮未集成，属未验证路径）。
  // ==========================================
  // 2026-11-21：简报按**连接语言**渲染（英文连接收 textEn，中文连接原样）。
  // 以前只有一份中文 text 广播给所有人 → 英文界面必然看到中文简报（用户反馈）。
  // render 是纯函数；payload 结构/去重/节流均不变，只多做一次逐连接文本渲染。
  broadcastAssistant(payload) {
    if (!payload || typeof payload !== 'object') return 0;
    let count = 0;
    for (const [clientId, ws] of this.clients) {
      if (ws && ws.readyState === 1) { // OPEN
        try {
          const lang = this.clientLang.get(clientId) || i18n.DEFAULT_LANG;
          let out = payload;
          try { out = assistantBroadcastModule().render(payload, lang); } catch (e) { out = payload; }
          ws.send(JSON.stringify({
            ...out,
            type: out.type || 'assistantBroadcast',
            lang
          }));
          count += 1;
        } catch (e) { /* 单个客户端失败不影响其它人 */ }
      }
    }
    return count;
  }

  // 推送任务进度更新
  broadcastProgress(taskId, progress) {
    const subscribers = this.taskSubscriptions.get(taskId);
    if (!subscribers || subscribers.size === 0) return;

    let count = 0;
    for (const clientId of subscribers) {
      if (this._sendTo(clientId, { type: 'progress', taskId, data: progress })) count++;
    }

    if (count > 0) {
      console.log(`[WS] 推送进度 ${taskId}: ${progress.percent}% (${count}个客户端)`);
    }
  }

  // 推送片段状态更新
  broadcastClipUpdate(taskId, clipIndex, clipData) {
    const subscribers = this.taskSubscriptions.get(taskId);
    if (!subscribers || subscribers.size === 0) return;
    for (const clientId of subscribers) {
      this._sendTo(clientId, { type: 'clipUpdate', taskId, index: clipIndex, data: clipData });
    }
  }

  // 推送任务状态变化
  // extra 里的可选 key/params（P2）随事件一起下发，前端可优先用 key 本地化。
  broadcastStatusChange(taskId, status, extra = {}) {
    const subscribers = this.taskSubscriptions.get(taskId);
    if (!subscribers || subscribers.size === 0) return;
    for (const clientId of subscribers) {
      this._sendTo(clientId, { type: 'statusChange', taskId, status, ...extra });
    }
  }

  // 推送步骤更新
  broadcastStepUpdate(taskId, stepKey, stepData) {
    const subscribers = this.taskSubscriptions.get(taskId);
    if (!subscribers || subscribers.size === 0) return;
    for (const clientId of subscribers) {
      this._sendTo(clientId, { type: 'stepUpdate', taskId, stepKey, data: stepData });
    }
  }
}

module.exports = new WebSocketManager();
