// store.js — IndexedDB 접근 계층 (PLAN.md §8). DOM을 만지지 않는다.

const DB_NAME = "mildam";
const DB_VERSION = 3;
const SEEN_WRAP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta", { keyPath: "k" });
      }
      if (!db.objectStoreNames.contains("contacts")) {
        db.createObjectStore("contacts", { keyPath: "pk" });
      }
      if (!db.objectStoreNames.contains("sessions")) {
        db.createObjectStore("sessions", { keyPath: "pk" });
      }
      if (!db.objectStoreNames.contains("messages")) {
        const messages = db.createObjectStore("messages", { keyPath: "id" });
        messages.createIndex("byContact", ["pk", "ts"]);
      }
      if (!db.objectStoreNames.contains("seenWraps")) {
        const seen = db.createObjectStore("seenWraps", { keyPath: "id" });
        seen.createIndex("byAt", "at");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(storeName, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    let result;
    Promise.resolve(fn(store))
      .then((r) => { result = r; })
      .catch(reject);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

// ---------------------------------------------------------------- meta

export async function getIdentity() {
  return tx("meta", "readonly", (s) => reqToPromise(s.get("identity")));
}

export async function saveIdentity(identity) {
  return tx("meta", "readwrite", (s) => reqToPromise(s.put({ ...identity, k: "identity" })));
}

export async function getLastSync() {
  const row = await tx("meta", "readonly", (s) => reqToPromise(s.get("lastSync")));
  return row ? row.value : 0;
}

export async function setLastSync(seconds) {
  return tx("meta", "readwrite", (s) => reqToPromise(s.put({ k: "lastSync", value: seconds })));
}

export async function getHelper() {
  return tx("meta", "readonly", (s) => reqToPromise(s.get("helper")));
}

export async function saveHelper(helper) {
  return tx("meta", "readwrite", (s) => reqToPromise(s.put({ ...helper, k: "helper" })));
}

// ---------------------------------------------------------------- contacts

export async function addContact(contact) {
  return tx("contacts", "readwrite", (s) => reqToPromise(s.add(contact)));
}

export async function getContact(pk) {
  return tx("contacts", "readonly", (s) => reqToPromise(s.get(pk)));
}

export async function getAllContacts() {
  return tx("contacts", "readonly", (s) => reqToPromise(s.getAll()));
}

export async function contactExists(pk) {
  const c = await getContact(pk);
  return !!c;
}

// ---------------------------------------------------------------- sessions
// pfs 매니저는 encrypt/decrypt 호출 직후마다 저장해야 한다(PLAN.md §8.2) —
// 저장을 놓치면 다음 메시지에서 래칫 상태가 상대와 어긋나 대화가 깨진다.

export async function getSession(pk) {
  const row = await tx("sessions", "readonly", (s) => reqToPromise(s.get(pk)));
  return row ? row.mgr : null;
}

export async function saveSession(pk, mgr) {
  return tx("sessions", "readwrite", (s) => reqToPromise(s.put({ pk, mgr })));
}

// ---------------------------------------------------------------- messages

export async function addMessage(msg) {
  return tx("messages", "readwrite", (s) => reqToPromise(s.add(msg)));
}

export async function hasMessage(id) {
  const row = await tx("messages", "readonly", (s) => reqToPromise(s.get(id)));
  return !!row;
}

export async function updateMessageStatus(id, status) {
  return tx("messages", "readwrite", async (s) => {
    const row = await reqToPromise(s.get(id));
    if (!row) return;
    row.status = status;
    await reqToPromise(s.put(row));
  });
}

export async function getMessagesByContact(pk) {
  return tx("messages", "readonly", (s) => {
    const index = s.index("byContact");
    const range = IDBKeyRange.bound([pk, -Infinity], [pk, Infinity]);
    return reqToPromise(index.getAll(range));
  });
}

// ---------------------------------------------------------------- seenWraps

export async function hasSeenWrap(id) {
  const row = await tx("seenWraps", "readonly", (s) => reqToPromise(s.get(id)));
  return !!row;
}

export async function markSeenWrap(id, at = Date.now()) {
  return tx("seenWraps", "readwrite", (s) => reqToPromise(s.put({ id, at })));
}

export async function pruneSeenWraps(maxAgeMs = SEEN_WRAP_MAX_AGE_MS) {
  const cutoff = Date.now() - maxAgeMs;
  return tx("seenWraps", "readwrite", async (s) => {
    const index = s.index("byAt");
    const range = IDBKeyRange.upperBound(cutoff);
    await new Promise((resolve, reject) => {
      const cursorReq = index.openCursor(range);
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) { resolve(); return; }
        cursor.delete();
        cursor.continue();
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    });
  });
}
