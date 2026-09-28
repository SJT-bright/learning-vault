/**
 * 原子 JSON 读写：先写临时文件再改名，失败时保留原文件。
 * 草稿等频繁写入可关 backup，避免每次按键都复制整库。
 *
 * 数据保护（P3）：
 * - 写入：临时文件 + rename 原子替换，写前自动留 .bak —— 断电/崩溃不会产生半截文件
 * - 读取：文件「不存在」= 首次使用，静默归 fallback；
 *   文件「存在但解析失败」= 损坏 —— 先把坏文件留底为 *.corrupt-<时间戳>（绝不覆盖、绝不静默蒸发），
 *   再归 fallback 运行，并回传留底路径（corruptPath），由调用方决定是否告知用户
 */
const fs = require('fs');
const path = require('path');

function readJson(file, fallback) {
  let raw = null;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return fallback; // 不存在 = 首次使用
  }
  try {
    const data = JSON.parse(raw);
    return data == null ? fallback : data;
  } catch {
    // 损坏：留底原文件（带时间戳，绝不被后续写入覆盖），再归 fallback
    let corruptPath = null;
    try {
      corruptPath = file + '.corrupt-' + new Date().toISOString().replace(/[:.]/g, '-');
      fs.copyFileSync(file, corruptPath);
    } catch { corruptPath = null; }
    if (typeof console !== 'undefined' && console.warn) {
      console.warn(`[json-io] 数据文件损坏，已留底：${corruptPath || file}（归空继续运行）`);
    }
    const out = (typeof fallback === 'object' && fallback !== null && !Array.isArray(fallback))
      ? { ...fallback, corruptPath } : fallback;
    return out;
  }
}

function writeJsonAtomic(file, data, { backup = true } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const json = JSON.stringify(data, null, 1);
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  try {
    fs.writeFileSync(tmp, json);
    if (backup && fs.existsSync(file)) {
      try { fs.copyFileSync(file, file + '.bak'); } catch {}
    }
    fs.renameSync(tmp, file);
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

module.exports = { readJson, writeJsonAtomic };
