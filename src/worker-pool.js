/**
 * 并行工作线程池 — 把重 IO（PDF/Word 抽取、视频元数据、目录扫描）移出主进程
 *
 * 设计：
 * - 基于 Node worker_threads：每个任务跑在独立线程、独立事件循环，主进程 UI/调度永不被
 *   抽取任务卡顿；池大小默认 min(4, max(2, CPU-2))
 * - round-robin 派发 + 每任务超时（超时 terminate 并重建该 worker，绝不悬挂）
 * - worker 意外退出自动重建（带熔断计数，防崩溃风暴）
 * - Worker 创建失败（如打包环境异常）→ dead 熔断，调用方降级为进程内串行
 *
 * 安全说明：Worker 的目标是本仓库内固定的 worker 脚本（模块级常量，非用户输入），
 * worker_threads 无进程派生、无 shell 参与，不存在命令注入面。
 */
const { Worker } = require('worker_threads');
const os = require('os');
const path = require('path');

const WORKER_PATH = path.join(__dirname, '..', 'worker', 'extract-worker.js');

function defaultSize() {
  const cpus = os.cpus().length || 4;
  return Math.max(2, Math.min(4, cpus - 2));
}

class WorkerPool {
  constructor({ size, taskTimeoutMs = 180000 } = {}) {
    this.taskTimeoutMs = taskTimeoutMs;
    this.size = size || defaultSize();
    this.workers = [];          // { w, busy, task, kills }
    this.queue = [];            // [{ id, msg, resolve, reject, timer }]
    this.seq = 0;
    this.dead = false;          // Worker 连续失败熔断
    this.failStreak = 0;
  }

  _spawn(slot) {
    if (this.dead) return null;
    let w = null;
    try {
      // 固定常量路径；worker_threads 不经 shell、无注入面
      w = new Worker(WORKER_PATH);
    } catch {
      this.failStreak += 1;
      if (this.failStreak >= 3) this.dead = true;
      return null;
    }
    this.failStreak = 0;
    w.on('message', (msg) => this._onMessage(slot, msg));
    w.on('error', () => { /* exit 事件随后必到，统一在 _onExit 收口 */ });
    w.on('exit', () => this._onExit(slot));
    return { w, busy: false, task: null };
  }

  _onMessage(slot, msg) {
    const task = slot.task;
    slot.busy = false;
    slot.task = null;
    if (task) {
      clearTimeout(task.timer);
      if (msg && msg.id === task.id) {
        if (msg.ok) task.resolve(msg.result);
        else task.reject(new Error(msg.error || 'worker 任务失败'));
      } else task.reject(new Error('worker 响应错位'));
    }
    this._pump();
  }

  _onExit(slot) {
    if (slot.task) { // 带着任务死掉：reject 后补位
      clearTimeout(slot.task.timer);
      slot.task.reject(new Error('worker 线程退出'));
      slot.task = null;
    }
    slot.busy = false;
    if (!this.dead && slot.kills < 12) {
      const fresh = this._spawn(slot);
      if (fresh) Object.assign(slot, fresh);
    } else {
      slot.w = null;
    }
    this._pump();
  }

  _pickIdle() { return this.workers.find(s => s.w && !s.busy) || null; }

  _pump() {
    if (this.dead) {
      while (this.queue.length) {
        const t = this.queue.shift();
        clearTimeout(t.timer);
        t.reject(new Error('worker pool 不可用'));
      }
      return;
    }
    while (this.queue.length) {
      let slot = this._pickIdle();
      if (!slot) {
        if (this.workers.length >= this.size) break;
        const s = { kills: 0, w: null, busy: false, task: null };
        this.workers.push(s);
        const fresh = this._spawn(s);
        if (!fresh) continue; // dead 由 _spawn 记账，下轮 while 顶部清空队列
        Object.assign(s, fresh);
        slot = s;
      }
      const t = this.queue.shift();
      slot.busy = true;
      slot.task = t;
      try { slot.w.postMessage(t.msg); } catch (e) { t.reject(e); slot.busy = false; slot.task = null; }
    }
  }

  // 执行一个任务；超时 → terminate 该 worker（_onExit 负责 reject 与重建，kills 计数防风暴）
  run(type, payload, { timeoutMs } = {}) {
    if (this.dead) return Promise.reject(new Error('worker pool 不可用'));
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const msg = { id, type, payload };
      const timer = setTimeout(() => {
        const i = this.queue.findIndex(t => t.id === id);
        if (i >= 0) { this.queue.splice(i, 1); return reject(new Error('任务排队超时')); }
        const slot = this.workers.find(s => s.task && s.task.id === id);
        if (slot) {
          slot.kills += 1;
          try { slot.w.terminate(); } catch {}
        } else reject(new Error('任务超时'));
      }, timeoutMs || this.taskTimeoutMs);
      this.queue.push({ id, msg, resolve, reject, timer });
      this._pump();
    });
  }

  killAll() {
    this.dead = true;
    for (const s of this.workers) { try { if (s.w) s.w.terminate(); } catch {} }
    this.workers = [];
    while (this.queue.length) {
      const t = this.queue.shift();
      clearTimeout(t.timer);
      t.reject(new Error('worker pool 已关闭'));
    }
  }
}

// 池懒创建 + 全局单例；创建失败时返回 null（调用方降级进程内处理）
let _pool = null;
function getPool() {
  if (_pool) return _pool;
  try { _pool = new WorkerPool(); return _pool; } catch { return null; }
}
// 降级通道：池不可用时由调用方在进程内直接跑同一份 handler
function inProcessFallback() {
  return require('../worker/extract-worker').handlers;
}

module.exports = { WorkerPool, getPool, defaultSize, inProcessFallback };
