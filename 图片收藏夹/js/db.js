/**
 * db.js — ImageVault 存储层（原生 IndexedDB，零依赖）
 * 全局导出：window.VaultDB
 * 数据库：imgvault（version 1）
 *  - store images      (keyPath: id)，索引：categoryId / createdAt
 *  - store categories  (keyPath: id)
 * 所有公开方法均返回 Promise；不支持 IndexedDB 时返回中文可读错误。
 */
(function () {
  'use strict';

  var DB_NAME = 'imgvault';
  var DB_VERSION = 1;
  var STORE_IMAGES = 'images';
  var STORE_CATEGORIES = 'categories';

  /** 分类默认图标（精灵表里的 symbol id）。分类只靠「图标 + 名称」区分，不用颜色。 */
  var DEFAULT_CAT_ICON = 'i-cat-folder';

  /** 缓存 open() 的 Promise，保证幂等：重复调用复用同一连接 */
  var dbPromise = null;

  /** 生成记录主键：优先 crypto.randomUUID，异常环境用随机串兜底 */
  function genId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return 'id-' + Date.now().toString(36) + '-' +
      Math.random().toString(36).slice(2, 10) +
      Math.random().toString(36).slice(2, 6);
  }

  /**
   * 打开数据库（幂等：已连接或正在连接时直接复用）。
   * 浏览器不支持 IndexedDB 时返回 rejected Promise（中文可读错误）。
   */
  function open() {
    if (dbPromise) return dbPromise;

    if (typeof indexedDB === 'undefined' || indexedDB === null) {
      return Promise.reject(new Error(
        '当前浏览器不支持 IndexedDB，图片收藏夹无法工作，请改用现代浏览器（Chrome / Edge / Firefox）。'
      ));
    }

    dbPromise = new Promise(function (resolve, reject) {
      var req;
      try {
        req = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (err) {
        dbPromise = null;
        reject(new Error(
          '无法打开本地数据库：' + ((err && err.message) || err) +
          '（若你是直接双击 index.html 打开，浏览器会禁用本地存储，' +
          '请改用「打开图片收藏夹.bat」或在本目录执行 python -m http.server 后访问 localhost）'
        ));
        return;
      }

      // 首次创建 / 升级版本时建立 store 与索引
      req.onupgradeneeded = function (event) {
        var db = event.target.result;
        var tx = event.target.transaction;

        if (!db.objectStoreNames.contains(STORE_IMAGES)) {
          var images = db.createObjectStore(STORE_IMAGES, { keyPath: 'id' });
          images.createIndex('categoryId', 'categoryId', { unique: false });
          images.createIndex('createdAt', 'createdAt', { unique: false });
        } else if (tx) {
          // 防御：store 已存在但缺索引时补建
          var store = tx.objectStore(STORE_IMAGES);
          if (!store.indexNames.contains('categoryId')) {
            store.createIndex('categoryId', 'categoryId', { unique: false });
          }
          if (!store.indexNames.contains('createdAt')) {
            store.createIndex('createdAt', 'createdAt', { unique: false });
          }
        }

        if (!db.objectStoreNames.contains(STORE_CATEGORIES)) {
          db.createObjectStore(STORE_CATEGORIES, { keyPath: 'id' });
        }
      };

      req.onsuccess = function () {
        var db = req.result;
        // 其他标签页请求升级版本时，优雅释放旧连接
        db.onversionchange = function () {
          try { db.close(); } catch (e) { /* 忽略关闭异常 */ }
          dbPromise = null;
        };
        resolve(db);
      };

      req.onerror = function () {
        dbPromise = null;
        reject(new Error('打开图片数据库（imgvault）失败：' +
          ((req.error && req.error.message) || '未知错误')));
      };

      req.onblocked = function () {
        console.warn('[VaultDB] 数据库升级被其他标签页阻塞，请关闭相关标签页后重试。');
      };
    });

    return dbPromise;
  }

  /**
   * 在单个 store 上执行一笔请求并包装成 Promise。
   * executor(store) 需返回一个 IDBRequest。
   */
  function runReq(storeName, mode, executor) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx;
        try {
          tx = db.transaction(storeName, mode);
        } catch (err) {
          reject(err);
          return;
        }
        var req = executor(tx.objectStore(storeName));
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error || new Error('数据库请求失败')); };
        // 事务被中止时给出可读错误，避免 Promise 永远悬挂
        tx.onabort = function () {
          reject(tx.error || new Error('数据库事务被中止'));
        };
      });
    });
  }

  /**
   * 通用部分更新：get + Object.assign + put（同一事务内完成）。
   * label 用于错误提示（如「图片」/「分类」）。
   */
  function partialUpdate(storeName, label, id, patch) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var result = null;
        var tx = db.transaction(storeName, 'readwrite');
        var store = tx.objectStore(storeName);

        var getReq = store.get(id);
        getReq.onsuccess = function () {
          var record = getReq.result;
          if (!record) {
            reject(new Error(label + '不存在：' + id));
            return;
          }
          result = Object.assign({}, record, patch || {});
          result.id = id; // 主键不允许被 patch 覆盖
          store.put(result);
        };
        getReq.onerror = function () { reject(getReq.error); };

        tx.oncomplete = function () { resolve(result); };
        tx.onerror = function () { reject(tx.error || new Error('更新' + label + '失败')); };
        tx.onabort = function () { reject(tx.error || new Error('更新' + label + '被中止')); };
      });
    });
  }

  /**
   * 新增图片：补全 id / createdAt / 默认字段后入库。
   * @param {{blob:Blob,name:string,type:string,width:number,height:number,
   *          size:number,categoryId:string|null,prompt:string}} data
   * @returns {Promise<object>} 完整 image 对象（含生成的 id/createdAt）
   */
  function addImage(data) {
    data = data || {};
    if (!(data.blob instanceof Blob)) {
      return Promise.reject(new Error('addImage 失败：缺少有效的 blob（Blob 类型）图片数据。'));
    }
    var image = {
      id: genId(),
      name: (data.name != null && data.name !== '') ? String(data.name) : '未命名图片',
      type: data.type != null ? String(data.type) : '',
      blob: data.blob,
      width: Number(data.width) || 0,
      height: Number(data.height) || 0,
      size: Number(data.size) || data.blob.size || 0,
      createdAt: Date.now(),
      categoryId: data.categoryId != null ? String(data.categoryId) : null,
      prompt: data.prompt != null ? String(data.prompt) : '',
      favorite: typeof data.favorite === 'boolean' ? data.favorite : false
    };
    return runReq(STORE_IMAGES, 'readwrite', function (store) {
      return store.put(image);
    }).then(function () { return image; });
  }

  /** 删除图片 */
  function deleteImage(id) {
    return runReq(STORE_IMAGES, 'readwrite', function (store) {
      return store.delete(id);
    }).then(function () { return true; });
  }

  /** v2.3 备份导入：按原样写入一条完整记录（含 id/prompt/categoryId 等全部字段） */
  function importRecord(data) {
    if (!data || typeof data !== 'object') {
      return Promise.reject(new Error('importRecord 失败：记录格式无效。'));
    }
    var rec = Object.assign({}, data);
    if (!rec.id) rec.id = genId();
    if (!(rec.blob instanceof Blob)) rec.blob = null;
    return runReq(STORE_IMAGES, 'readwrite', function (store) {
      return store.put(rec);
    }).then(function () { return rec; });
  }

  /** 按 id 读取图片，不存在时返回 undefined */
  function getImage(id) {
    return runReq(STORE_IMAGES, 'readonly', function (store) {
      return store.get(id);
    });
  }

  /**
   * 全部图片，按 createdAt 降序。
   * 说明：不使用 createdAt 索引游标——索引只覆盖"已建立索引的键"，
   * 若某条历史记录缺少 createdAt，用索引遍历会把它整条漏掉（静默丢图）。
   * 这里改为 getAll() 后排序，保证任何记录都不会凭空消失。
   */
  function listImages() {
    return runReq(STORE_IMAGES, 'readonly', function (store) {
      return store.getAll();
    }).then(function (list) {
      return (list || []).slice().sort(function (a, b) {
        return (b.createdAt || 0) - (a.createdAt || 0);
      });
    });
  }

  /**
   * 新增分类，返回完整分类对象。
   * 注意：分类**不再有颜色**（v2.0 起全界面单色），区分靠 icon + name。
   * 历史记录里遗留的 color 字段不做删除，读出来也没人用，属于无害残留。
   * @param {string} name 分类名
   * @param {string} icon 图标名（精灵表 symbol id，如 'i-cat-star'）
   */
  function addCategory(name, icon) {
    var category = {
      id: genId(),
      name: (name != null && name !== '') ? String(name) : '未命名分类',
      icon: (icon != null && icon !== '') ? String(icon) : DEFAULT_CAT_ICON,
      createdAt: Date.now()
    };
    return runReq(STORE_CATEGORIES, 'readwrite', function (store) {
      return store.put(category);
    }).then(function () { return category; });
  }

  /**
   * 删除分类：先删分类记录，再在同一事务里遍历
   * categoryId 索引，把属于该分类的图片 categoryId 置 null。
   */
  function deleteCategory(id) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction([STORE_CATEGORIES, STORE_IMAGES], 'readwrite');
        var catStore = tx.objectStore(STORE_CATEGORIES);
        var imgStore = tx.objectStore(STORE_IMAGES);

        // 1) 删除分类本身
        catStore.delete(id);

        // 2) 遍历该分类下的图片并置空 categoryId
        var index = imgStore.index('categoryId');
        var cursorReq = index.openCursor(IDBKeyRange.only(id));
        cursorReq.onsuccess = function () {
          var cursor = cursorReq.result;
          if (cursor) {
            var image = cursor.value;
            image.categoryId = null;
            cursor.update(image);
            cursor.continue();
          }
        };
        cursorReq.onerror = function () { reject(cursorReq.error); };

        tx.oncomplete = function () { resolve(true); };
        tx.onerror = function () { reject(tx.error || new Error('删除分类失败')); };
        tx.onabort = function () { reject(tx.error || new Error('删除分类被中止')); };
      });
    });
  }

  /** 全部分类，按 createdAt 升序 */
  function listCategories() {
    return runReq(STORE_CATEGORIES, 'readonly', function (store) {
      return store.getAll();
    }).then(function (list) {
      return (list || []).slice().sort(function (a, b) {
        return (a.createdAt || 0) - (b.createdAt || 0);
      });
    });
  }

  /**
   * v2.2 新增：外链引用记录。网页图片受跨域（CORS / 防盗链）限制拿不到原图时，
   * 退而保存图片 URL（blob 为 null，sourceUrl 指向原图），网格中带「外链」徽章。
   * 与 addImage 同构，区别仅是允许 blob 为空。
   */
  function addImageRef(data) {
    data = data || {};
    if (!data.sourceUrl) {
      return Promise.reject(new Error('addImageRef 失败：缺少 sourceUrl。'));
    }
    var image = {
      id: genId(),
      name: (data.name != null && data.name !== '') ? String(data.name) : '网络图片',
      type: data.type != null ? String(data.type) : 'image/external',
      blob: null,
      width: Number(data.width) || 0,
      height: Number(data.height) || 0,
      size: 0,
      createdAt: Date.now(),
      categoryId: data.categoryId != null ? String(data.categoryId) : null,
      prompt: data.prompt != null ? String(data.prompt) : '',
      favorite: false,
      sourceUrl: String(data.sourceUrl)
    };
    return runReq(STORE_IMAGES, 'readwrite', function (store) {
      return store.put(image);
    }).then(function () { return image; });
  }

  // 挂载全局 API（签名与 CONTRACT.md「db.js 全局 API」一致）
  window.VaultDB = {
    open: open,
    DEFAULT_CAT_ICON: DEFAULT_CAT_ICON,
    addImage: addImage,
    addImageRef: addImageRef,
    importRecord: importRecord,
    updateImage: function (id, patch) { return partialUpdate(STORE_IMAGES, '图片', id, patch); },
    deleteImage: deleteImage,
    getImage: getImage,
    listImages: listImages,
    addCategory: addCategory,
    updateCategory: function (id, patch) { return partialUpdate(STORE_CATEGORIES, '分类', id, patch); },
    deleteCategory: deleteCategory,
    listCategories: listCategories
  };
})();
