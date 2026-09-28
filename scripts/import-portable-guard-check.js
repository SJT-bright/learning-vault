/** import/portable IPC 守卫验证：A 模块未集成时必须明确报 MODULE_MISSING，preload 暴露完整 API。 */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict');
let pw;
try { pw = require('playwright'); } catch {
  const { createRequire } = require('module');
  const req2 = createRequire(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json'));
  pw = req2('playwright');
}
const root = path.resolve(__dirname, '..'), out = process.env.LV_EVIDENCE_DIR || path.join(root, '交付物/D/evidence-import-guard');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-import-guard-'));
let app;
const steps = [], errors = [];
const step = t => { steps.push(t); console.log('✓ ' + t); };

(async () => {
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ vaultBridge: { enabled: false }, autoReview: false, notifyOnIngest: false }));
  app = await pw._electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [root], env: { ...process.env, LV_CONFIG_DIR: tmp } });
  const page = await pw.until || null;
  const win = () => app.windows().find(p => p.url().includes('index.html') || p.url().includes('/overlay/'));
  for (let i = 0; i < 120 && !win(); i++) await new Promise(r => setTimeout(r, 100));
  assert.ok(win(), '没有任何窗口');

  // preload API 齐备（旧 importJson/exportJson 属既有接口，需为子集校验）
  const api = await win().evaluate(() => Object.keys(window.vault).filter(k => /^(import|portable)/.test(k)));
  for (const k of ['importCommit', 'importPreview', 'importRetry', 'importStatus', 'portableExport', 'portablePreview', 'portableRestore']) {
    assert.ok(api.includes(k), 'preload 缺少 API: ' + k);
  }
  step('preload 暴露 importPreview/Commit/Status/Retry + portableExport/Preview/Restore');

  // A 模块未集成 → 明确 MISSING，绝不假成功
  const pv = await win().evaluate(() => window.vault.importPreview({ text: ' hello ', files: [] }));
  assert.equal(pv.error, 'IMPORT_MODULE_MISSING', 'importPreview 应报 IMPORT_MODULE_MISSING');
  const cm = await win().evaluate(() => window.vault.importCommit({ planId: 'x', decisions: [] }));
  assert.equal(cm.error, 'IMPORT_MODULE_MISSING', 'importCommit 应报 IMPORT_MODULE_MISSING');
  const rt = await win().evaluate(() => window.vault.importRetry('x'));
  assert.equal(rt.error, 'IMPORT_MODULE_MISSING', 'importRetry 应报 IMPORT_MODULE_MISSING');
  const st = await win().evaluate(() => window.vault.importStatus('x'));
  assert.equal(st.error, 'BATCH_NOT_FOUND', 'importStatus 无批次时如实报 BATCH_NOT_FOUND');
  step('import 系列在 A 模块未集成时明确报 IMPORT_MODULE_MISSING / BATCH_NOT_FOUND');

  // 便携包：原生对话框取消语义 + MISSING（取消先于模块检查？设计为取消优先——由对话框发出；
  // 自动化环境无法点原生对话框，仅验证 MISSING 分支）
  const ex = await win().evaluate(() => window.vault.portableExport());
  assert.equal(ex.error, 'PORTABLE_MODULE_MISSING', 'portableExport 应报 PORTABLE_MODULE_MISSING');
  const rs = await win().evaluate(() => window.vault.portableRestore({ planId: 'x' }));
  assert.equal(rs.error, 'PORTABLE_MODULE_MISSING', 'portableRestore 应报 PORTABLE_MODULE_MISSING');
  step('portable 系列在 A 模块未集成时明确报 PORTABLE_MODULE_MISSING');

  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(out, 'import-guard-result.json'), JSON.stringify({ ok: true, steps, errors, tmp }, null, 2));
  console.log('IMPORT_GUARD_CHECK_OK ' + steps.length);
})().catch(e => {
  console.error(e.stack);
  try { fs.mkdirSync(out, { recursive: true }); } catch {}
  fs.writeFileSync(path.join(out, 'import-guard-result.json'), JSON.stringify({ ok: false, steps, errors, error: String(e.stack) }, null, 2));
  process.exitCode = 1;
}).finally(async () => { if (app) await app.close(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });
