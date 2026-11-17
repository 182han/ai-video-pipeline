// ==========================================
// 后端 catalog · WebSocket（P2）
// 事件本身只加 lang / 可选 key+params；中文日志与原有事件字段不变。
// ==========================================

'use strict';

module.exports = {
  zh: {
    'ws.log.connected': '客户端连接',
    'ws.log.disconnected': '客户端断开',
    'ws.log.subscribed': '订阅任务',
    'ws.log.pushProgress': '推送进度',
    'ws.log.unknownMessage': '未知消息类型',
    'ws.event.progress': '任务进度',
    'ws.event.clipUpdate': '片段更新',
    'ws.event.statusChange': '任务状态变化',
    'ws.event.stepUpdate': '步骤更新',
    'ws.event.assistantBroadcast': '小智任务播报'
  },
  en: {
    'ws.log.connected': 'Client connected',
    'ws.log.disconnected': 'Client disconnected',
    'ws.log.subscribed': 'Subscribed to task',
    'ws.log.pushProgress': 'Progress pushed',
    'ws.log.unknownMessage': 'Unknown message type',
    'ws.event.progress': 'Task progress',
    'ws.event.clipUpdate': 'Clip updated',
    'ws.event.statusChange': 'Task status changed',
    'ws.event.stepUpdate': 'Step updated',
    'ws.event.assistantBroadcast': 'Xiaozhi task brief'
  }
};
