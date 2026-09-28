/**
 * 便携文件夹包（导出 / 只读检查 / 暂存 / 恢复）—— LV-20260924-A
 *
 * 包结构（可打开的普通文件夹，不引入 ZIP 依赖）：
 *   <bundle>/
 *     manifest.json     ← 最后写入（提交标记）；记录每个文件的大小与 SHA256
 *     records/*.json    ← 库记录（与 backup.js 的 LISTS/MAPS 同名：资料/聊天批次/修订/摘录/版本/点子/规则等）
 *     files/...         ← 库内归档附件的完整副本（保留 filesDir 下相对路径）
 *     external/...      ← 仅当用户显式选入的外部文件才复制到这里
 *
 * 安全底线：
 *   - manifest 未写入/被删除 → restore 直接拒绝（半截包不可恢复）
 *   - 记录/附件路径绝不允许绝对路径、盘符、`..` 越界、符号链接；哈希不符 → 拒绝
 *   - 恢复复用 mergeBackup：同 ID 保留当前记录；附件不覆盖已有文件（同哈希跳过、异哈希保留当前并记冲突）
 *   - 写前备份/失败回滚由 writeRestoredBundle（JSON）+ created 清单（新增附件）共同覆盖；取消 = 全程零写入
 *   - 缺文件绝不报「完整成功」：complete = missing===0 且外部未包含===0
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readJson, writeJsonAtomic } = require('./json-io');
const { mergeBackup, writeRestoredBundle, LISTS, MAPS } = require('./backup');

const FORMAT = 'learning-vault-portable';
const FORMAT_VERSION = 1;

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('data', (d) => h.update(d));
    s.on('error', reject);
    s.on('end', () => resolve(h.digest('hex')));
  });
}

async function statSafe(p) {
  try { const st = await fs.promises.lstat(p); return st; } catch { return null; }
}

// 相对路径安全校验：拒绝绝对路径 / 盘符 / UNC / `..` / 空段 / NUL
function safeRelPath(p) {
  if (typeof p !== 'string' || !p.length || p.includes('\0')) return false;
  if (path.isAbsolute(p) || p.startsWith('\\') || /^[a-zA-Z]:[\\/]/.test(p)) return false;
  const parts = p.split(/[\\/]+/);
  return parts.every((s) => s && s !== '.' && s !== '..');
}

// 逐段 mkdir（每段都校验，防拼接出越界路径）
function safeJoin(base, rel) {
  if (!safeRelPath(rel)) throw new Error('路径越界，已拒绝：' + String(rel));
  const abs = path.resolve(base, ...rel.split(/[\\/]+/));
  const baseAbs = path.resolve(base);
  if (abs !== baseAbs && !abs.startsWith(baseAbs + path.sep)) throw new Error('路径越界，已拒绝：' + rel);
  return abs;
}

async function copyFileVerified(src, dest) {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  await fs.promises.copyFile(src, dest, fs.constants.COPYFILE_EXCL);
  const [a, b] = await Promise.all([sha256File(src), sha256File(dest)]);
  if (a !== b) throw new Error('复制后哈希不一致：' + path.basename(dest));
  const st = await fs.promises.stat(dest);
  return { size: st.size, sha256: a };
}

// ---------- 读取当前库（无 Electron 依赖，替代 main.exportBundle 的取数） ----------

function readCurrentBundle(dataDir) {
  const bundle = {};
  for (const [key, name] of Object.entries(LISTS)) {
    const v = readJson(path.join(dataDir, name), []);
    bundle[key] = Array.isArray(v) ? v : [];
  }
  for (const [key, name] of Object.entries(MAPS)) {
    const v = readJson(path.join(dataDir, name), key === 'categoryProfile' ? { categories: {} } : {});
    bundle[key] = (v && typeof v === 'object' && !Array.isArray(v)) ? v : (key === 'categoryProfile' ? { categories: {} } : {});
    if (key === 'categoryProfile' && !bundle[key].categories) bundle[key].categories = {};
  }
  return bundle;
}

// ---------- 收集附件引用 ----------

function collectFileRefs(bundle) {
  const refs = [];
  const items = Array.isArray(bundle.items) ? bundle.items : [];
  for (const it of items) {
    for (const [i, f] of (it.files || []).entries()) {
      if (f && f.path) refs.push({ abs: f.path, ref: `items:${it.id}:files[${i}]`, design: 'archived' });
    }
    for (const [i, im] of (it.images || []).entries()) {
      if (im && im.file) refs.push({ abs: im.file, ref: `items:${it.id}:images[${i}]`, design: 'archived' });
    }
    for (const [i, m] of (it.messages || []).entries()) {
      if (m && m.attachment && m.attachment.path) {
        refs.push({ abs: m.attachment.path, ref: `items:${it.id}:messages[${i}].attachment`, design: 'archived' });
      }
    }
    if (it.source_path) refs.push({ abs: it.source_path, ref: `items:${it.id}:source_path`, design: 'index-only' });
  }
  return refs;
}

function classifyRef(ref, filesDir) {
  const inside = path.resolve(filesDir) === path.resolve(ref.abs) ||
    path.resolve(ref.abs).startsWith(path.resolve(filesDir) + path.sep);
  if (inside) {
    const rel = path.relative(path.resolve(filesDir), path.resolve(ref.abs));
    return { rel, external: false };
  }
  return { rel: null, external: true };
}

// ---------- 导出 ----------

async function exportPortableBundle({ dataDir, filesDir, bundleDir, appVersion, includeExternalPaths, log }) {
  const say = log || (() => {});
  if (!dataDir || !filesDir || !bundleDir) return { ok: false, error: '缺少 dataDir/filesDir/bundleDir 参数' };

  // bundleDir：不存在则建；已存在则必须是本格式旧包（覆盖重建），否则拒绝（绝不覆盖无关目录）
  if (fs.existsSync(bundleDir)) {
    const mPath = path.join(bundleDir, 'manifest.json');
    let prev = null;
    try { prev = JSON.parse(fs.readFileSync(mPath, 'utf8')); } catch { prev = null; }
    const hasContent = fs.readdirSync(bundleDir).length > 0;
    if (hasContent && (!(prev && prev.format === FORMAT))) {
      return { ok: false, error: '输出目录已存在且不是本格式便携包，已拒绝写入：' + bundleDir };
    }
    for (const sub of ['records', 'files', 'external']) {
      try { fs.rmSync(path.join(bundleDir, sub), { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
  fs.mkdirSync(path.join(bundleDir, 'records'), { recursive: true });
  fs.mkdirSync(path.join(bundleDir, 'files'), { recursive: true });

  const bundle = readCurrentBundle(dataDir);
  const manifest = {
    format: FORMAT,
    format_version: FORMAT_VERSION,
    created_at: new Date().toISOString(),
    app_version: appVersion || null,
    records: [],
    attachments: [],
    external: [],
    missing: [],
    counts: {},
  };

  // 1) 记录 JSON
  for (const [key, name] of [...Object.entries(LISTS), ...Object.entries(MAPS)]) {
    const rows = bundle[key];
    const dest = path.join(bundleDir, 'records', name);
    writeJsonAtomic(dest, rows == null ? [] : rows, { backup: false });
    const st = fs.statSync(dest);
    manifest.records.push({
      path: 'records/' + name, key,
      count: Array.isArray(rows) ? rows.length : Object.keys(rows || {}).length,
      bytes: st.size, sha256: await sha256File(dest),
    });
  }

  // 2) 库内归档附件（同一路径可能被 files/images/messages 多处引用 → refs 合并，只归档一份）
  const missing = [];
  const external = [];
  const archived = new Map(); // resolve(abs) → { abs, rel, refs: [] }
  for (const ref of collectFileRefs(bundle)) {
    const st = await statSafe(ref.abs);
    const cls = classifyRef(ref, filesDir);
    if (!cls.external && st && st.isFile()) {
      const k = path.resolve(ref.abs);
      if (!archived.has(k)) archived.set(k, { abs: ref.abs, rel: cls.rel, refs: [] });
      archived.get(k).refs.push(ref.ref);
      continue;
    }
    if (cls.external) {
      external.push({ path: ref.abs, size: st && st.isFile() ? st.size : 0, reason: st && st.isFile() ? (ref.design === 'index-only' ? 'index-only-外部原文件（默认不复制）' : '库外文件') : '外部原文件不存在', ref: ref.ref });
    } else {
      missing.push({ path: ref.abs, reason: st && !st.isFile() ? '不是常规文件' : '文件不存在', ref: ref.ref });
    }
  }
  for (const info of archived.values()) {
    const destRel = 'files/' + info.rel.split(path.sep).join('/');
    const stat = await statSafe(info.abs);
    const filed = await copyFileVerified(info.abs, safeJoin(bundleDir, destRel));
    manifest.attachments.push({ path: destRel, relToFilesDir: info.rel, size: filed.size, sha256: filed.sha256, refs: info.refs, mtimeMs: stat ? stat.mtimeMs : null });
  }
  // 多条引用同一外部/缺失文件时合并 ref 说明
  const byPath = (arr) => {
    const m = new Map();
    for (const e of arr) {
      if (!m.has(e.path)) m.set(e.path, { ...e, refs: [e.ref] });
      else { const cur = m.get(e.path); cur.refs = [...new Set([...cur.refs, e.ref])]; if (!cur.size && e.size) cur.size = e.size; }
    }
    return [...m.values()].map(({ ref, ...rest }) => rest);
  };
  manifest.external = byPath(external).map((e) => ({ ...e, included: false }));
  manifest.missing = byPath(missing);

  // 3) 显式选入的外部文件（只有这里才复制 external/）
  const extIncluded = [];
  const extResolved = new Set(external.map((e) => path.resolve(e.path)));
  for (const p of (Array.isArray(includeExternalPaths) ? includeExternalPaths : [])) {
    const abs = path.resolve(String(p || ''));
    const st = await statSafe(abs);
    if (!st || !st.isFile()) { missing.push({ path: String(p), reason: '显式选入但文件不存在', ref: 'includeExternalPaths' }); continue; }
    let relName = path.basename(abs);
    const extDir = path.join(bundleDir, 'external');
    fs.mkdirSync(extDir, { recursive: true });
    let dest = path.join(extDir, relName);
    let n = 2;
    while (fs.existsSync(dest)) { const e = path.extname(relName); dest = path.join(extDir, path.basename(relName, e) + '-' + n + e); n += 1; }
    const info = await copyFileVerified(abs, dest);
    const storedAs = 'external/' + path.basename(dest);
    // 复用库记录里已有的引用说明，恢复时才能把记录里的旧绝对路径改写到新库
    const priorRefs = external.filter((e) => path.resolve(e.path) === abs).flatMap((e) => e.refs || [e.ref]);
    manifest.external.push({
      path: abs, size: info.size, reason: '用户显式选入',
      refs: priorRefs.length ? priorRefs : ['includeExternalPaths'],
      included: true, storedAs, sha256: info.sha256,
    });
    extIncluded.push({ originalPath: abs, storedAs, size: info.size });
  }

  manifest.missing = byPath(missing); // 显式选入后消失或不存在的文件也必须计入缺失

  // 同一文件既被显式选入又在「未包含」清单时，只保留选入条目（选入优先）
  const includedSet = new Set(manifest.external.filter((e) => e.included).map((e) => path.resolve(e.path)));
  manifest.external = manifest.external.filter((e) => !(e.included === false && includedSet.has(path.resolve(e.path))));

  manifest.counts = {
    records: manifest.records.length,
    attachmentsArchived: manifest.attachments.length,
    externalNotIncluded: manifest.external.filter((e) => !e.included).length,
    externalIncluded: manifest.external.filter((e) => e.included).length,
    missing: manifest.missing.length,
    complete: manifest.missing.length === 0 && manifest.external.every((e) => e.included),
  };

  // manifest 最后写（提交标记）：写好之前中断 → 包里没有 manifest，restore 会拒绝
  writeJsonAtomic(path.join(bundleDir, 'manifest.json'), manifest, { backup: false });
  say(`导出完成：记录 ${manifest.counts.records} 个，附件 ${manifest.counts.attachmentsArchived} 个，外部未包含 ${manifest.counts.externalNotIncluded} 个，缺失 ${manifest.counts.missing} 个`);

  return {
    ok: true,
    complete: manifest.counts.complete,
    bundleDir,
    manifest,
    counts: manifest.counts,
    missing: manifest.missing,
    external: manifest.external,
    externalIncluded: extIncluded,
  };
}

// ---------- 只读检查 ----------

async function inspectPortableBundle(bundleDir, { verifyHashes = true } = {}) {
  const errors = [];
  const warnings = [];
  const mPath = path.join(bundleDir || '', 'manifest.json');
  let manifest = null;
  let raw = null;
  try { raw = fs.readFileSync(mPath, 'utf8'); } catch { raw = null; }
  if (raw == null) {
    return { ok: false, errors: [{ code: 'NO_MANIFEST', message: '找不到 manifest.json：不是完整便携包（可能导出中断）' }], warnings, manifest: null, fingerprint: null };
  }
  try { manifest = JSON.parse(raw); } catch (e) {
    return { ok: false, errors: [{ code: 'BAD_MANIFEST', message: 'manifest.json 无法解析：' + e.message }], warnings, manifest: null, fingerprint: null };
  }
  if (manifest.format !== FORMAT) errors.push({ code: 'FORMAT_UNKNOWN', message: '包格式不认识：' + manifest.format });
  if (Number(manifest.format_version) !== FORMAT_VERSION) errors.push({ code: 'FORMAT_VERSION', message: '包版本不支持的：' + manifest.format_version });

  const check = async (entry, kind) => {
    if (!entry || !entry.path) { errors.push({ code: 'BAD_ENTRY', message: kind + ' 条目缺少 path' }); return null; }
    if (!safeRelPath(entry.path)) { errors.push({ code: 'PATH_UNSAFE', message: '路径越界/绝对路径，已拒绝：' + entry.path }); return null; }
    const abs = safeJoin(bundleDir, entry.path);
    const st = await statSafe(abs);
    if (!st) { errors.push({ code: 'FILE_MISSING', message: kind + ' 文件缺失：' + entry.path }); return null; }
    if (!st.isFile() || st.isSymbolicLink()) { errors.push({ code: 'SYMLINK_OR_SPECIAL', message: '不是常规文件（疑似符号链接），已拒绝：' + entry.path }); return null; }
    if (entry.size != null && st.size !== entry.size) {
      errors.push({ code: 'SIZE_MISMATCH', message: `大小不符：${entry.path}（manifest ${entry.size} / 实际 ${st.size}）` });
      return null;
    }
    if (verifyHashes && entry.sha256) {
      const actual = await sha256File(abs);
      if (actual !== entry.sha256) {
        errors.push({ code: 'HASH_MISMATCH', message: `SHA256 不符（包已损坏或被改动）：${entry.path}` });
        return null;
      }
    }
    return abs;
  };

  for (const r of manifest.records || []) await check(r, '记录');
  for (const a of manifest.attachments || []) await check(a, '附件');
  for (const e of manifest.external || []) {
    if (e.included && e.storedAs) await check({ path: e.storedAs, size: e.size, sha256: e.sha256 }, '外部选入');
  }
  if (!(manifest.records || []).some((r) => r.key === 'items')) {
    errors.push({ code: 'NO_ITEMS', message: '缺少 library.json（资料列表），不是有效的资料库包' });
  }

  let fingerprint = null;
  try { fingerprint = crypto.createHash('sha256').update(raw).digest('hex'); } catch { /* ignore */ }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    manifest,
    fingerprint,
    counts: manifest.counts || null,
  };
}

// ---------- 隔离暂存（重建路径映射，校验后复制） ----------

async function stagePortableBundle(bundleDir, stagingDir, { verifyHashes = true } = {}) {
  const inspection = await inspectPortableBundle(bundleDir, { verifyHashes });
  if (!inspection.ok) return { ok: false, errors: inspection.errors, staged: [] };
  try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { /* ignore */ }
  fs.mkdirSync(stagingDir, { recursive: true });

  const staged = [];
  const errors = [];
  const stageOne = async (p) => {
    const src = safeJoin(bundleDir, p);
    const stSrc = await statSafe(src);
    if (!stSrc || !stSrc.isFile() || stSrc.isSymbolicLink()) {
      errors.push({ code: 'SYMLINK_OR_SPECIAL', message: '暂存时发现非常规文件，已拒绝：' + p });
      return;
    }
    const dest = safeJoin(stagingDir, p);
    const info = await copyFileVerified(src, dest);
    staged.push({ path: p, stagingPath: dest, size: info.size, sha256: info.sha256 });
  };
  for (const r of inspection.manifest.records || []) await stageOne(r.path);
  for (const a of inspection.manifest.attachments || []) await stageOne(a.path);
  for (const e of (inspection.manifest.external || [])) {
    if (e.included && e.storedAs) await stageOne(e.storedAs);
  }
  if (errors.length) {
    try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { /* ignore */ }
    return { ok: false, errors, staged: [] };
  }
  return { ok: true, staged, errors: [] };
}

// ---------- 恢复 ----------

// ---------- 恢复时按引用改写附件绝对路径（迁移后仍可打开） ----------

// ref 形如 items:<itemId>:files[0] / images[1] / messages[2].attachment / source_path
function applyRef(items, ref, newAbs) {
  const m = String(ref || '').match(/^items:(.+?):(.+)$/);
  if (!m) return false;
  const it = (items || []).find((x) => x && x.id === m[1]);
  if (!it) return false;
  const seg = m[2];
  let mm = seg.match(/^files\[(\d+)\]$/);
  if (mm) { const f = (it.files || [])[+mm[1]]; if (f) { f.path = newAbs; return true; } return false; }
  mm = seg.match(/^images\[(\d+)\]$/);
  if (mm) { const f = (it.images || [])[+mm[1]]; if (f) { f.file = newAbs; return true; } return false; }
  mm = seg.match(/^messages\[(\d+)\]\.attachment$/);
  if (mm) { const msg = (it.messages || [])[+mm[1]]; if (msg && msg.attachment) { msg.attachment.path = newAbs; msg.attachment.pending = false; return true; } return false; }
  if (seg === 'source_path') { it.source_path = newAbs; return true; }
  return false;
}

// 为传入内容生成确定性、不碰撞的新路径：<原名>.from-bundle-<内容哈希前缀><扩展名>。
// 候选路径已存在时必须再验哈希：内容一致 → 直接复用；不一致 → 加长哈希前缀，最后用完整哈希+序号。
async function bundleContentPath(desiredAbs, sha) {
  const dir = path.dirname(desiredAbs);
  const ext = path.extname(desiredAbs);
  const base = path.basename(desiredAbs, ext);
  for (let n = 8; n <= 64; n += 8) {
    const cand = path.join(dir, `${base}.from-bundle-${sha.slice(0, n)}${ext}`);
    const st = await statSafe(cand);
    if (!st) return cand;
    if (st.isFile() && !st.isSymbolicLink()) {
      try { if ((await sha256File(cand)) === sha) return cand; } catch { /* 不可读 → 视为占用，继续加长 */ }
    }
  }
  for (let i = 2; ; i += 1) {
    const cand = path.join(dir, `${base}.from-bundle-${sha}-${i}${ext}`);
    const st = await statSafe(cand);
    if (!st) return cand;
    if (st.isFile() && !st.isSymbolicLink()) {
      try { if ((await sha256File(cand)) === sha) return cand; } catch { /* ignore */ }
    }
  }
}

// 回滚：删除本次新建的附件文件，并自下而上清掉因此新建的空目录（绝不动非空目录）
function rollbackCreatedAttachments(created, filesDir) {  let n = 0;
  for (const c of created) {
    try { fs.rmSync(c.path, { force: true }); n += 1; } catch { /* ignore */ }
    let dir = path.dirname(c.path);
    const stop = path.resolve(filesDir);
    while (path.resolve(dir) !== stop) {
      try { fs.rmdirSync(dir); } catch { break; } // 非空/只读 → 停止
      dir = path.dirname(dir);
    }
  }
  return n;
}

async function restorePortableBundle({ bundleDir, dataDir, filesDir, stagingDir, log }) {
  const say = log || (() => {});
  if (!bundleDir || !dataDir || !filesDir) return { ok: false, error: '缺少 bundleDir/dataDir/filesDir 参数' };

  // 1) 只读检查：任何问题都在写库之前拒绝（取消/坏包 = 零写入）
  const inspection = await inspectPortableBundle(bundleDir, { verifyHashes: true });
  if (!inspection.ok) {
    return { ok: false, error: '便携包检查未通过，未写入任何内容', errors: inspection.errors };
  }
  const manifest = inspection.manifest;

  // 2) 隔离暂存
  const stage = stagingDir || path.join(filesDir, '.restore-stage-' + stamp());
  const staged = await stagePortableBundle(bundleDir, stage, { verifyHashes: true });
  if (!staged.ok) {
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch { /* ignore */ }
    return { ok: false, error: '暂存失败，未写入任何内容', errors: staged.errors };
  }

  // 3) 记录合并：mergeBackup 同 ID 保留当前
  let incoming;
  try {
    incoming = {};
    for (const [key, name] of Object.entries(LISTS)) {
      const v = JSON.parse(fs.readFileSync(path.join(stage, 'records', name), 'utf8'));
      if (!Array.isArray(v)) throw new Error('记录不是数组：' + name);
      incoming[key] = v;
    }
    for (const [key, name] of Object.entries(MAPS)) {
      const v = JSON.parse(fs.readFileSync(path.join(stage, 'records', name), 'utf8'));
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('记录不是对象：' + name);
      incoming[key] = v;
    }
  } catch (e) {
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch { /* ignore */ }
    return { ok: false, error: '包内记录损坏：' + (e.message || e) };
  }

  const current = readCurrentBundle(dataDir);

  // 3.5) 附件落位计划（只读，不写任何东西）：
  //   - 目标路径不存在 → 按原相对路径落位
  //   - 目标存在且哈希相同 → 复用本地文件
  //   - 目标存在但内容不同 → 绝不覆盖本地旧文件，为传入内容生成确定性新路径
  //     （<原名>.from-bundle-<内容哈希前缀><扩展名>；候选已存在必须再验哈希，不一致就加长/加序号）
  //   随后只把 incoming 记录的引用重映射到「其内容的最终路径」；本地既有记录与文件一字不改。
  const placementEntries = [];
  for (const a of manifest.attachments || []) {
    placementEntries.push({
      kind: 'archived', bundlePath: a.path,
      desiredRel: a.relToFilesDir || String(a.path || '').replace(/^files\//, ''),
      sha256: a.sha256, size: a.size, refs: a.refs || [],
    });
  }
  for (const e of (manifest.external || [])) {
    if (!e.included || !e.storedAs) continue;
    placementEntries.push({
      kind: 'external', bundlePath: e.storedAs,
      desiredRel: 'external-restored/' + path.basename(e.storedAs),
      sha256: e.sha256, size: e.size, refs: e.refs || [],
    });
  }
  const plan = [];
  for (const entry of placementEntries) {
    const desiredAbs = safeJoin(filesDir, entry.desiredRel);
    const st = await statSafe(desiredAbs);
    let finalAbs = desiredAbs;
    let action = 'copy';
    if (st) {
      let same = false;
      if (st.isFile() && !st.isSymbolicLink()) {
        try { same = (await sha256File(desiredAbs)) === entry.sha256; } catch { same = false; }
      }
      if (same) { action = 'reuse'; } else { action = 'copy-new-path'; finalAbs = await bundleContentPath(desiredAbs, entry.sha256); }
    }
    plan.push({ ...entry, desiredAbs, finalAbs, action });
  }

  // 只重映射 incoming 记录（mergeBackup 之前）；同 ID 冲突时当前记录胜出，其路径不受影响
  for (const p of plan) for (const ref of p.refs) applyRef(incoming.items, ref, p.finalAbs);

  let merged;
  try {
    merged = mergeBackup(current, incoming);
  } catch (e) {
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch { /* ignore */ }
    return { ok: false, error: '备份合并失败：' + (e.message || e) };
  }

  // 4) 附件落位：只落「真正新增进库的条目」引用到的附件（同 ID 被当前胜出的引用不落，
  //    避免孤儿文件）；复制失败即整体失败，不写任何记录。
  const currentIds = new Set((current.items || []).map((it) => it && it.id));
  const addedIds = new Set((merged.next.items || []).filter((it) => it && !currentIds.has(it.id)).map((it) => it.id));
  const refTouchesAdded = (p) => (p.refs || []).some((ref) => {
    const m = String(ref || '').match(/^items:(.+?):/);
    return m && addedIds.has(m[1]);
  });
  const created = [];         // 本次恢复新建的附件（失败回滚清单）
  const conflicts = plan.filter((p) => p.action === 'copy-new-path').map((p) => ({
    path: p.desiredRel, action: 'kept-current-remapped-incoming', finalRel: path.relative(filesDir, p.finalAbs),
    message: '本地同名但内容不同：保留当前文件未覆盖；传入记录已重映射到内容哈希命名的新路径',
  }));
  let restored = 0;
  let reused = plan.filter((p) => p.action === 'reuse').length; // 目标已存在同内容文件的计划项（与是否被新增条目引用无关）
  const inflight = new Set(); // 正在复制、尚未确认成功的目标（失败时清掉半截文件）
  try {
    for (const p of plan) {
      if (!refTouchesAdded(p)) continue;   // 没有任何新增条目引用它 → 不落位
      if (p.action === 'reuse') continue;
      // copy-new-path 且目标已存在（重复恢复/并发）：内容一致 → 复用；不一致 → 拒绝并回滚
      const stF = await statSafe(p.finalAbs);
      if (stF && stF.isFile()) {
        const sameF = await sha256File(p.finalAbs) === p.sha256;
        if (sameF) { reused += 1; continue; }
        throw new Error('落位目标内容意外变化：' + path.basename(p.finalAbs));
      }
      inflight.add(p.finalAbs);
      const info = await copyFileVerified(path.join(stage, p.bundlePath), p.finalAbs);
      if (info.sha256 !== p.sha256) throw new Error('落位后哈希不一致：' + path.basename(p.finalAbs));
      inflight.delete(p.finalAbs);
      created.push({ path: p.finalAbs, sha256: info.sha256 });
      restored += 1;
      say('恢复附件 ' + path.relative(filesDir, p.finalAbs) + ' (' + info.size + 'B)');
    }
  } catch (e) {
    for (const f of inflight) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
    const rolledBack = rollbackCreatedAttachments(created, filesDir);
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch { /* ignore */ }
    return { ok: false, error: '附件恢复失败，已回滚新建附件（未写任何记录，无悬空引用）：' + (e.message || e), rolledBackAttachments: rolledBack };
  }

  // 5) 记录写库：writeRestoredBundle 自带写前备份 + 失败回滚（JSON）。若此处失败，同时回滚上面新建的附件。
  let backupDir;
  try {
    backupDir = writeRestoredBundle(dataDir, merged.next);
  } catch (e) {
    const rolledBack = rollbackCreatedAttachments(created, filesDir);
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch { /* ignore */ }
    return { ok: false, error: '记录写库失败，已回滚（附件与 JSON 均未变更）：' + (e.message || e), rolledBackAttachments: rolledBack };
  }

  try { fs.rmSync(stage, { recursive: true, force: true }); } catch { /* ignore */ }
  say(`恢复完成：新增 ${merged.added} 条，跳过 ${merged.skipped} 条，附件落位 ${restored} 个，复用 ${reused} 个，冲突重映射 ${conflicts.length} 个`);

  // complete 按实际恢复结果与缺失情况重算，绝不照抄源包标记
  const missingInManifest = (manifest.missing || []).length;
  const externalNotIncluded = (manifest.external || []).filter((e) => !e.included).length;
  return {
    ok: true,
    complete: missingInManifest === 0 && externalNotIncluded === 0,
    added: merged.added,
    skipped: merged.skipped,
    backupDir,
    fingerprint: inspection.fingerprint,
    counts: {
      attachmentsRestored: restored,
      attachmentsReused: reused,
      attachmentConflictsRemapped: conflicts.length,
      missingInManifest,
      externalNotIncluded,
    },
    conflicts,
    manifest,
  };
}

module.exports = {
  FORMAT,
  FORMAT_VERSION,
  exportPortableBundle,
  inspectPortableBundle,
  stagePortableBundle,
  restorePortableBundle,
  readCurrentBundle,
  collectFileRefs,
  safeRelPath,
  safeJoin,
  applyRef,
  bundleContentPath,
};
