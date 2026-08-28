// store.js — IndexedDB 접근 계층 (PLAN.md §8). DOM을 만지지 않는다.

const DB_NAME = "mildam";
const DB_VERSION = 4;
const SEEN_WRAP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      const oldVersion = event.oldVersion;
      if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta", { keyPath: "k" });
      }
      if (!db.objectStoreNames.contains("contacts")) {
        db.createObjectStore("contacts", { keyPath: "pk" });
      }
      if (!db.objectStoreNames.contains("sessions")) {
        db.createObjectStore("sessions", { keyPath: "pk" });
      }
      // v4 §S2(F-05): messages의 keyPath를 "id"(전역) -> ["pk","id"](대화별)로
      // 바꾼다. 신규 설치와 기존(v1~v3) DB 업그레이드를 분리해서 처리한다 —
      // 뭉치면 안 된다(v1.1 P-3).
      if (!db.objectStoreNames.contains("messages")) {
        // 신규 설치(oldVersion === 0)이거나 이 스토어가 아예 없던 경우 —
        // 처음부터 새 keyPath로 만든다. 마이그레이션 불필요.
        const store = db.createObjectStore("messages", { keyPath: ["pk", "id"] });
        store.createIndex("byContact", ["pk", "ts"]);
      } else if (oldVersion < 4) {
        // 기존 DB(v1~v3)에 keyPath:"id"인 messages가 이미 있음 — 데이터를
        // 보존한 채 keyPath를 ["pk","id"]로 교체한다. versionchange
        // 트랜잭션 안에서 읽기->삭제->재생성->복원을 순서대로 수행한다.
        const getAllReq = req.transaction.objectStore("messages").getAll();
        getAllReq.onsuccess = () => {
          const rows = getAllReq.result;
          db.deleteObjectStore("messages");
          const store = db.createObjectStore("messages", { keyPath: ["pk", "id"] });
          store.createIndex("byContact", ["pk", "ts"]);
          for (const row of rows) {
            if (row && typeof row.pk === "string" && typeof row.id === "string") store.add(row);
          }
        };
      }
      if (!db.objectStoreNames.contains("seenWraps")) {
        const seen = db.createObjectStore("seenWraps", { keyPath: "id" });
        seen.createIndex("byAt", "at");
      }
      // v4 §S6-b(F-14): 완전히 새 스토어라 분기 없이 만들면 된다.
      if (!db.objectStoreNames.contains("gaps")) {
        db.createObjectStore("gaps", { keyPath: "pk" });
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

// v4 §S10: TOFU 코드 지문. 처음 본 지문을 저장해 두고, 다음 부팅에서 달라지면
// 경고한다.
export async function getCodePin() {
  const row = await tx("meta", "readonly", (s) => reqToPromise(s.get("codePin")));
  return row ? row.value : null;
}

export async function setCodePin(fingerprint) {
  return tx("meta", "readwrite", (s) => reqToPromise(s.put({ k: "codePin", value: fingerprint })));
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

// v4 §S6-a(F-04): 래칫이 영구히 어긋났을 때 사용자가 직접 세션을 지우고
// 새로 시작할 수 있게 한다.
export async function deleteSession(pk) {
  return tx("sessions", "readwrite", (s) => reqToPromise(s.delete(pk)));
}

// ---------------------------------------------------------------- messages

export async function addMessage(msg) {
  return tx("messages", "readwrite", (s) => reqToPromise(s.add(msg)));
}

// v4 §S2(F-05): 메시지는 이제 [pk,id] 복합키로만 조회한다 — 상대(pk)를
// 명시해야 접근할 수 있으므로 다른 대화의 메시지 id로는 조회 자체가 안 된다.
export async function hasMessageFrom(pk, id) {
  const row = await tx("messages", "readonly", (s) => reqToPromise(s.get([pk, id])));
  return !!row;
}

// dir 검증까지 수행한다 — 상대는 자기 대화의 '내가 보낸(out)' 메시지 상태만
// 바꿀 수 있고, requireDir이 일치하지 않으면 조용히 실패(false)한다.
export async function updateMessageStatusFrom(pk, id, status, requireDir) {
  return tx("messages", "readwrite", async (s) => {
    const row = await reqToPromise(s.get([pk, id]));
    if (!row) return false;
    if (requireDir && row.dir !== requireDir) return false;
    row.status = status;
    await reqToPromise(s.put(row));
    return true;
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

// ---------------------------------------------------------------- gaps
// v4 §S6-b(F-14): 상대 pk별 래칫 카운터 관측 기록. { pk, prevChainDh, chains }.

export async function getGaps(pk) {
  return tx("gaps", "readonly", (s) => reqToPromise(s.get(pk)));
}

export async function saveGaps(record) {
  return tx("gaps", "readwrite", (s) => reqToPromise(s.put(record)));
}

export async function deleteGaps(pk) {
  return tx("gaps", "readwrite", (s) => reqToPromise(s.delete(pk)));
}
