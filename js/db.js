/**
 * IndexedDB 基础设施：打开数据库、创建对象仓库、事务与读取辅助。
 *
 * 注意：IndexedDB 事务会在当前任务没有未完成请求时自动提交。
 * 因此 `runTransaction` 的 body 只能使用回调式请求，不能 `await` 其他 Promise。
 */

import { DB_NAME, DB_VERSION } from './constants.js';

let dbPromise = null;

function createStores(db) {
  if (!db.objectStoreNames.contains('waypoints')) {
    const store = db.createObjectStore('waypoints', { keyPath: 'id' });
    store.createIndex('createdAt', 'createdAt');
  }
  if (!db.objectStoreNames.contains('tracks')) {
    const store = db.createObjectStore('tracks', { keyPath: 'id' });
    store.createIndex('by_status_startedAt', ['status', 'startedAt']);
  }
  if (!db.objectStoreNames.contains('trackPoints')) {
    const store = db.createObjectStore('trackPoints', { keyPath: 'id' });
    store.createIndex('by_trackId', 'trackId');
    store.createIndex('by_track_seq', ['trackId', 'seq'], { unique: true });
  }
  if (!db.objectStoreNames.contains('settings')) {
    db.createObjectStore('settings', { keyPath: 'key' });
  }
}

/**
 * 打开（并按需升级）数据库。全程复用同一个连接。
 * @returns {Promise<IDBDatabase>}
 */
export function openDb() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('当前浏览器不支持 IndexedDB，无法保存本地数据'));
      return;
    }

    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      createStores(request.result);
    };

    request.onsuccess = () => {
      const db = request.result;
      // 新版本页面打开时，旧标签页必须释放连接，避免升级被阻塞。
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('app-db-versionchange'));
        }
      };
      finish(resolve, db);
    };

    request.onerror = () => {
      finish(reject, request.error || new Error('无法打开本地数据库'));
    };

    request.onblocked = () => {
      finish(
        reject,
        new Error('本地数据库被其他标签页占用，请关闭其他页面后重试'),
      );
    };
  });

  return dbPromise;
}

/** 主动关闭连接（升级/测试使用）。 */
export function closeDb() {
  const current = dbPromise;
  dbPromise = null;
  if (!current) return Promise.resolve();
  return current
    .then((db) => db.close())
    .catch(() => {
      /* 连接未成功打开时忽略 */
    });
}

/**
 * 在一个事务中执行回调式操作，事务完成时以 ctx.result 作为返回值。
 *
 * @param {string|string[]} storeNames
 * @param {IDBTransactionMode} mode
 * @param {(ctx: {
 *   tx: IDBTransaction,
 *   result: unknown,
 *   error: Error|null,
 *   fail: (error?: Error) => void
 * }) => void} body
 * @returns {Promise<unknown>}
 */
export async function runTransaction(storeNames, mode, body) {
  const db = await openDb();

  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(storeNames, mode);
    } catch (error) {
      reject(error);
      return;
    }

    const ctx = {
      tx,
      result: undefined,
      error: null,
      fail(error) {
        ctx.error = error || new Error('数据库操作失败');
        try {
          tx.abort();
        } catch {
          /* 事务可能已经结束 */
        }
      },
    };

    let done = false;
    tx.oncomplete = () => {
      if (done) return;
      done = true;
      resolve(ctx.result);
    };
    tx.onabort = () => {
      if (done) return;
      done = true;
      reject(ctx.error || tx.error || new Error('数据库事务已中止'));
    };
    tx.onerror = () => {
      // 具体错误会在 abort 时统一抛出，这里只保留引用。
      if (!ctx.error) ctx.error = tx.error || new Error('数据库事务失败');
    };

    try {
      body(ctx);
    } catch (error) {
      ctx.fail(error);
    }
  });
}

/** 读取单条记录。 */
export async function requestGet(storeName, key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const request = tx.objectStore(storeName).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('读取失败'));
  });
}

/** 读取一个 store 的全部记录。 */
export async function requestGetAll(storeName) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const request = tx.objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('读取失败'));
  });
}

/** 通过索引读取记录。 */
export async function requestGetAllByIndex(storeName, indexName, query) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const request = tx.objectStore(storeName).index(indexName).getAll(query);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('读取失败'));
  });
}

/** 删除对象仓库中的全部记录。 */
export async function clearStores(storeNames) {
  const names = Array.isArray(storeNames) ? storeNames : [storeNames];
  return runTransaction(names, 'readwrite', (ctx) => {
    for (const name of names) ctx.tx.objectStore(name).clear();
  });
}
