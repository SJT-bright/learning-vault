'use strict';
const fs = require('fs');
const crypto = require('crypto');

// Stream full contents so attachments stay memory-bounded and do not block the main thread.
async function fingerprint(file) {
  const before = await fs.promises.stat(file);
  if (!before.isFile()) throw new Error('附件不是普通文件');
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  const after = await fs.promises.stat(file);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
    throw new Error('读取时附件发生变化，请重新预检');
  }
  return { path: file, size: after.size, sha256: hash.digest('hex') };
}
async function snapshot(files) {
  const result = [];
  for (const file of [...new Set(files)]) result.push(await fingerprint(file));
  return result;
}
function sourceKey(sources) {
  const identities = sources.map(s => [s.path, s.size, s.sha256]).sort((a, b) => a[0].localeCompare(b[0]));
  return 'src-attach-v2-' + crypto.createHash('sha256').update(JSON.stringify(identities)).digest('hex');
}
async function changed(sources) {
  const result = [];
  for (const source of sources) {
    try {
      const current = await fingerprint(source.path);
      if (source.size !== current.size || source.sha256 !== current.sha256) result.push(source.path);
    } catch { result.push(source.path); }
  }
  return result;
}
module.exports = { snapshot, sourceKey, changed };
