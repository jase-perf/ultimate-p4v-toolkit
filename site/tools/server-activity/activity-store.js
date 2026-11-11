"use strict";

/**
 * Saved history for Server Activity.
 *
 * Submitted changelists don't change, so each one is summarised once and kept
 * in the browser's IndexedDB database on this computer. Later visits only ask
 * the server for newer changelists (or for older ones when a longer range is
 * chosen). If IndexedDB isn't available, everything is kept in memory instead.
 *
 * Stores:
 *   changes  one summary per changelist per scope   key [scope, c]
 *   meta     which changelist numbers are loaded    key scope
 *   folders  latest change seen per folder          key path
 */
const ActivityStore = (() => {
  const DB_NAME = "ultimate-p4v-toolkit-activity";
  const VERSION = 1;
  const memory = { changes: new Map(), meta: new Map(), folders: new Map() };
  let opening = null;

  function open() {
    if (opening) return opening;
    opening = new Promise((resolve) => {
      try {
        if (!window.indexedDB) return resolve(null);
        const request = indexedDB.open(DB_NAME, VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains("changes")) {
            const changes = db.createObjectStore("changes", { keyPath: ["scope", "c"] });
            changes.createIndex("scope", "scope");
          }
          if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "scope" });
          if (!db.objectStoreNames.contains("folders")) db.createObjectStore("folders", { keyPath: "path" });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
        request.onblocked = () => resolve(null);
      } catch (err) {
        resolve(null);
      }
    });
    return opening;
  }

  const done = (request) =>
    new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

  const finished = (tx) =>
    new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });

  async function safe(work, fallback) {
    try {
      const db = await open();
      return db ? await work(db) : fallback();
    } catch (err) {
      console.warn("[server-activity] storage error, using memory", err);
      return fallback();
    }
  }

  const memList = (scope) => {
    if (!memory.changes.has(scope)) memory.changes.set(scope, new Map());
    return memory.changes.get(scope);
  };

  return {
    /** True when history is saved on this computer (not just in memory). */
    async persistent() {
      return !!(await open());
    },

    getMeta(scope) {
      return safe(
        (db) => done(db.transaction("meta").objectStore("meta").get(scope)),
        () => memory.meta.get(scope)
      );
    },

    putMeta(meta) {
      return safe(
        async (db) => {
          const tx = db.transaction("meta", "readwrite");
          tx.objectStore("meta").put(meta);
          await finished(tx);
        },
        () => memory.meta.set(meta.scope, meta)
      );
    },

    getChanges(scope) {
      return safe(
        (db) => done(db.transaction("changes").objectStore("changes").index("scope").getAll(scope)),
        () => [...memList(scope).values()]
      );
    },

    putChanges(records) {
      if (!records.length) return Promise.resolve();
      return safe(
        async (db) => {
          const tx = db.transaction("changes", "readwrite");
          const store = tx.objectStore("changes");
          for (const record of records) store.put(record);
          await finished(tx);
        },
        () => records.forEach((r) => memList(r.scope).set(r.c, r))
      );
    },

    clearScope(scope) {
      return safe(
        async (db) => {
          const tx = db.transaction(["changes", "meta"], "readwrite");
          const index = tx.objectStore("changes").index("scope");
          const cursorRequest = index.openKeyCursor(IDBKeyRange.only(scope));
          const changes = tx.objectStore("changes");
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (cursor) {
              changes.delete(cursor.primaryKey);
              cursor.continue();
            }
          };
          tx.objectStore("meta").delete(scope);
          await finished(tx);
        },
        () => {
          memory.changes.delete(scope);
          memory.meta.delete(scope);
        }
      );
    },

    getFolder(path) {
      return safe(
        (db) => done(db.transaction("folders").objectStore("folders").get(path)),
        () => memory.folders.get(path)
      );
    },

    putFolder(record) {
      return safe(
        async (db) => {
          const tx = db.transaction("folders", "readwrite");
          tx.objectStore("folders").put(record);
          await finished(tx);
        },
        () => memory.folders.set(record.path, record)
      );
    },
  };
})();

if (typeof window !== "undefined") window.ActivityStore = ActivityStore;
