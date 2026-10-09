// ==========================================
// WebSocket 管理器 - 实时推送进度
// ==========================================

const { WebSocketServer } = require('ws');

class WebSocketManager {
  constructor() {
    this.wss = null;
    this.clients = new Map(); // clientId -> ws
    this.taskSubscriptions = new Map(); // taskId -> Set of clientIds
  }

  init(server) {
    this.wss = new WebSocketServer({ server, path: '/ws' });

    this.wss.on('connection', (ws) => {
      const clientId = this._generateId();
      this.clients.set(clientId, ws);
      console.log(`[WS] 客户端连接: ${clientId}`);

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
    // 从所有任务订阅中移除
    for (const [taskId, clients] of this.taskSubscriptions) {
      clients.delete(clientId);
      if (clients.size === 0) {
        this.taskSubscriptions.delete(taskId);
      }
    }
  }

  // 推送任务进度更新
  broadcastProgress(taskId, progress) {
    const subscribers = this.taskSubscriptions.get(taskId);
    if (!subscribers || subscribers.size === 0) return;

    const message = JSON.stringify({
      type: 'progress',
      taskId,
      data: progress
    });

    let count = 0;
    for (const clientId of subscribers) {
      const ws = this.clients.get(clientId);
      if (ws && ws.readyState === 1) { // OPEN
        ws.send(message);
        count++;
      }
    }

    if (count > 0) {
      console.log(`[WS] 推送进度 ${taskId}: ${progress.percent}% (${count}个客户端)`);
    }
  }

  // 推送片段状态更新
  broadcastClipUpdate(taskId, clipIndex, clipData) {
    const subscribers = this.taskSubscriptions.get(taskId);
    if (!subscribers || subscribers.size === 0) return;

    const message = JSON.stringify({
      type: 'clipUpdate',
      taskId,
      index: clipIndex,
      data: clipData
    });

    for (const clientId of subscribers) {
      const ws = this.clients.get(clientId);
      if (ws && ws.readyState === 1) {
        ws.send(message);
      }
    }
  }

  // 推送任务状态变化
  broadcastStatusChange(taskId, status, extra = {}) {
    const subscribers = this.taskSubscriptions.get(taskId);
    if (!subscribers || subscribers.size === 0) return;

    const message = JSON.stringify({
      type: 'statusChange',
      taskId,
      status,
      ...extra
    });

    for (const clientId of subscribers) {
      const ws = this.clients.get(clientId);
      if (ws && ws.readyState === 1) {
        ws.send(message);
      }
    }
  }

  // 推送步骤更新
  broadcastStepUpdate(taskId, stepKey, stepData) {
    const subscribers = this.taskSubscriptions.get(taskId);
    if (!subscribers || subscribers.size === 0) return;

    const message = JSON.stringify({
      type: 'stepUpdate',
      taskId,
      stepKey,
      data: stepData
    });

    for (const clientId of subscribers) {
      const ws = this.clients.get(clientId);
      if (ws && ws.readyState === 1) {
        ws.send(message);
      }
    }
  }
}

module.exports = new WebSocketManager();
