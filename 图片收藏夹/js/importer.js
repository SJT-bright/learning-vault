/* ============================================================
 * importer.js — 图片导入器
 * 提供 window.Importer.fromDataTransfer(dt) / fromClipboard(items)
 * 导入成功后派发 document 事件 vault:changed（detail.added = 成功张数）
 * ============================================================ */
(function () {
  'use strict';

  // MIME → 扩展名
  function extFromMime(mime) {
    const map = {
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/gif': '.gif',
      'image/webp': '.webp',
      'image/bmp': '.bmp',
      'image/svg+xml': '.svg',
      'image/avif': '.avif',
      'image/tiff': '.tiff',
      'image/x-icon': '.ico',
    };
    return map[mime || ''] || '.png';
  }

  // 扩展名 → MIME（用于部分系统给出的空 type 文件）
  const EXT_MIME = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.jpe': 'image/jpeg',
    '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
    '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.avif': 'image/avif',
    '.tif': 'image/tiff', '.tiff': 'image/tiff', '.ico': 'image/x-icon',
  };

  function extOf(name) {
    const n = String(name || '');
    const i = n.lastIndexOf('.');
    return i === -1 ? '' : n.slice(i).toLowerCase();
  }

  /**
   * 判断是否图片，并返回规范化后的 MIME。
   * 有些系统/浏览器给出的 File.type 为空，此时用扩展名兜底，
   * 避免「明明是图片却被静默忽略」。
   */
  function resolveImageType(file) {
    const t = ((file && file.type) || '').toLowerCase();
    if (t.indexOf('image/') === 0) return t;
    const byExt = EXT_MIME[extOf(file && file.name)];
    if (byExt) return byExt;
    return '';
  }

  function pad(n) { return String(n).padStart(2, '0'); }

  // 粘贴来源的默认文件名：粘贴图片 HHmmss.扩展名
  function pasteName(mime) {
    const d = new Date();
    const t = pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
    return '粘贴图片 ' + t + extFromMime(mime || 'image/png');
  }

  // 文件名兜底：缺名字给默认名，缺扩展名从 MIME 推断补上
  function ensureName(file) {
    const mime = resolveImageType(file);
    let name = (file && file.name) || '';
    if (!name) name = '导入图片 ' + pad(new Date().getMinutes()) + pad(new Date().getSeconds()) + extFromMime(mime);
    if (name.indexOf('.') === -1 && mime) name += extFromMime(mime);
    return name;
  }

  // 读取图片宽高：优先 createImageBitmap，失败回退 Image + objectURL
  function probeImage(blob) {
    if (typeof createImageBitmap === 'function') {
      return createImageBitmap(blob)
        .then((bmp) => {
          const size = { width: bmp.width || 0, height: bmp.height || 0 };
          if (typeof bmp.close === 'function') bmp.close();
          return size;
        })
        .catch(() => probeByImageElement(blob));
    }
    return probeByImageElement(blob);
  }

  function probeByImageElement(blob) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        const size = { width: img.naturalWidth || 0, height: img.naturalHeight || 0 };
        URL.revokeObjectURL(url);
        resolve(size);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve({ width: 0, height: 0 });
      };
      img.src = url;
    });
  }

  // 入库一张图，失败返回 null
  async function saveBlob(blob, name, type) {
    if (typeof VaultDB === 'undefined') throw new Error('数据库未加载');
    const probe = await probeImage(blob);
    try {
      return await VaultDB.addImage({
        blob: blob,
        name: name,
        type: type || (blob && blob.type) || 'image/png',
        width: probe.width,
        height: probe.height,
        size: blob.size,
        categoryId: null,
        prompt: '',
      });
    } catch (err) {
      console.warn('图片入库失败：', name, err);
      return null;
    }
  }

  // v2.2：外链收录——原图拿不到时把 URL 存成引用记录，不再静默丢弃
  async function saveRef(url) {
    if (typeof VaultDB === 'undefined' || typeof VaultDB.addImageRef !== 'function') return null;
    let name = '网络图片';
    try {
      const last = decodeURIComponent(String(url).split('/').pop().split('?')[0]);
      if (last && last.indexOf('.') !== -1) name = last;
    } catch (_) { /* 保留默认名 */ }
    try {
      return await VaultDB.addImageRef({ name: name, sourceUrl: url, type: 'image/external' });
    } catch (err) {
      console.warn('外链收录失败：', url, err);
      return null;
    }
  }

  // 批量导入 File 对象，返回成功张数（非图片静默忽略）
  async function importFiles(files) {
    let added = 0;
    for (const f of files) {
      const type = resolveImageType(f);
      if (!type) continue;
      const ok = await saveBlob(f, ensureName(f), type);
      if (ok) added++;
    }
    return added;
  }

  // 从 DataTransfer 收集文件：优先 dt.files，为空时回退遍历 dt.items
  function filesFromDataTransfer(dt) {
    if (!dt) return [];
    const out = Array.from(dt.files || []);
    if (out.length) return out;
    try {
      const items = dt.items ? Array.from(dt.items) : [];
      for (const it of items) {
        if (it && it.kind === 'file') {
          const f = it.getAsFile && it.getAsFile();
          if (f) out.push(f);
        }
      }
    } catch (_) { /* 忽略 */ }
    return out;
  }

  // 从拖放事件导入：本地文件 + 网页图片 URL（text/uri-list，CORS 失败静默跳过）
  async function fromDataTransfer(dt) {
    // 注意：dt.files / dt.items 与 getData 必须在任何 await 之前同步读取，
    // 否则事件结束后 DataTransfer 被 neuter，会拿不到数据
    const files = filesFromDataTransfer(dt);
    let uri = '';
    try {
      uri = ((dt && dt.getData && dt.getData('text/uri-list')) || '').trim();
    } catch (_) { uri = ''; }
    uri = uri.split('\n').map((s) => s.trim()).filter(Boolean)[0] || '';

    let added = await importFiles(files);
    let linked = 0;

    // 仅当没有任何文件成功入库时才走 URL 兜底：浏览器拖网页图时常同时携带
    // 文件与 text/uri-list，两路都入库会把同一张图存两份（v2.2 意图为
    // 「原图拿不到时才存外链引用」）
    if (!added && uri && /^https?:\/\//i.test(uri)) {
      // v2.2：fetch 成功且是图片 → 原图入库；失败（CORS / 防盗链 / 网络错误）
      // → 降级收录为外链引用，网格中以「外链」徽章展示，不再静默丢弃。
      let saved = false;
      try {
        const resp = await fetch(uri, { mode: 'cors' });
        const type = ((resp.headers.get('content-type') || '').split(';')[0] || '').trim();
        if (resp.ok && type.indexOf('image/') === 0) {
          const blob = await resp.blob();
          let name = '网络图片';
          try {
            const last = decodeURIComponent(uri.split('/').pop().split('?')[0]);
            if (last && last.indexOf('.') !== -1) name = last;
            else if (last) name = last + extFromMime(type);
          } catch (_) { /* 保留默认名 */ }
          const ok = await saveBlob(blob, name, type);
          if (ok) { saved = true; added++; }
        }
      } catch (_) { /* 走外链降级 */ }
      if (!saved) {
        const ok = await saveRef(uri);
        if (ok) { added++; linked++; }
      }
    }

    if (added > 0) {
      document.dispatchEvent(new CustomEvent('vault:changed', { detail: { added: added, linked: linked } }));
    }
    return { added: added, linked: linked };
  }

  // 从粘贴事件导入：clipboardData.items
  async function fromClipboard(items) {
    let added = 0;
    const list = Array.from(items || []);
    for (const it of list) {
      if (!it || it.kind !== 'file') continue;
      const f = it.getAsFile && it.getAsFile();
      if (!f) continue;
      const type = resolveImageType(f) || (it.type || '');
      if (!type || type.indexOf('image/') !== 0) continue;
      const ok = await saveBlob(f, pasteName(type), type);
      if (ok) added++;
    }
    if (added > 0) {
      document.dispatchEvent(new CustomEvent('vault:changed', { detail: { added: added } }));
    }
    return { added: added };
  }

  window.Importer = {
    fromDataTransfer: fromDataTransfer,
    fromClipboard: fromClipboard,
    // 供收录篮 / 悬浮窗复用，保证"是否图片"的判断全项目一致
    resolveImageType: resolveImageType,
  };
})();
