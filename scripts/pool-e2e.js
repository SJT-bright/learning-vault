// 临时验证：Electron 主进程内 worker 线程池端到端（验证后删除）
const { app } = require('electron');
app.whenReady().then(async () => {
  try {
    const { getPool } = require('../src/worker-pool');
    const fs = require('fs'), os = require('os'), path = require('path');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-pool-'));
    const md = path.join(tmp, 't.md');
    fs.writeFileSync(md, '# 标题\nPOOL_E2E 标记文本');
    fs.mkdirSync(path.join(tmp, 'v'));
    fs.writeFileSync(path.join(tmp, 'v', 'a.mp4'), 'x');
    const pool = getPool();
    const r1 = await pool.run('extract-files', { paths: [md] });
    const r2 = await pool.run('scan-videos', { folder: path.join(tmp, 'v') });
    const ok = r1[0].text.includes('POOL_E2E') && r2.files.length === 1;
    pool.killAll();
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(ok ? 'POOL_ELECTRON_OK' : 'POOL_ELECTRON_FAIL ' + JSON.stringify({ r1: r1[0], r2 }));
    app.exit(ok ? 0 : 1);
  } catch (e) {
    console.log('POOL_ELECTRON_FAIL ' + e.message);
    app.exit(1);
  }
});
