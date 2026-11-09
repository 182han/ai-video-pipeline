// ==========================================
// 出图厂商适配器注册表（内置厂商）
// ==========================================
//
// 为什么单独一个 index：imageGen.js 只提供注册机制，不 import 具体厂商，
// 这样「加一家厂商」= 新增一个适配器文件 + 在这里注册一行，不用改 imageGen。
//
// 必须在读取/调用 imageGen 之前 require 本文件一次（server.js 启动时已做）。
// 重复 require 不会重复注册（Node 模块缓存 + 下面的存在性判断）。
// ==========================================

const { registerImageProvider, listImageProviders } = require('../imageGen');
const dashscope = require('./dashscope');

const REGISTERED = [];

function ensure(name, adapter) {
  if (!listImageProviders().includes(name)) {
    registerImageProvider(name, adapter);
    REGISTERED.push(name);
  }
}

// 阿里云百炼 wan2.7-image（异步提交 → 轮询 → 下载落盘）
ensure('dashscope', dashscope);

module.exports = { registered: REGISTERED, providers: listImageProviders() };
