// pfs.js — 밀담 전방 비밀성(PFS) 계층: Double Ratchet
//
// Signal Double Ratchet 사양(https://signal.org/docs/specifications/doubleratchet/)을
// 브라우저 내장 WebCrypto만으로 구현한다. 외부 의존성 없음(Node 20+/브라우저 공용).
//
//   - DH 래칫:      ECDH P-256 (iOS Safari 16.4+ / Android Chrome 공통 지원)
//   - 루트/체인 KDF: HKDF-SHA256 / HMAC-SHA256
//   - 메시지 암호화: AES-256-GCM (12바이트 랜덤 IV, AAD에 헤더 바인딩)
//
// 이 파일은 수정 금지 대상이다(PLAN.md §15). 통합 지점은 파일 끝의
// createManager / managerEncrypt / managerDecrypt / createRatchetPrekey /
// deriveRootSecret / makeAd 뿐이다.
//
// 세션 부트스트랩: 양쪽 초대코드에 포함된 서명된 프리키(spk, P-256)를 상대의
// 초기 래칫 공개키로 사용한다. 따라서 상대가 오프라인이어도 첫 메시지부터
// 암호화할 수 있다. 장기키 유출에 대한 보호(PFS)는 첫 왕복 이후의 메시지부터
// 유효하며, 첫 왕복 이전 메시지는 정적 ECDH 수준으로 보호된다(PLAN.md §2).

const subtle = globalThis.crypto.subtle;
const te = new TextEncoder();

const MAX_SKIP = 256;           // 한 체인에서 건너뛸 수 있는 최대 메시지 수
const MAX_SKIPPED_STORE = 512;  // 연락처당 보관하는 건너뛴 메시지키 상한(FIFO)
const MAX_SESSIONS = 2;         // 연락처당 동시 세션 상한(충돌 시 잔여 수신용 1개 포함)

// ---------------------------------------------------------------- 인코딩

function bufToB64u(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function b64uToBuf(s) {
  const b = atob(s.replaceAll("-", "+").replaceAll("_", "/"));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------- 프리미티브

async function genDH() {
  const kp = await subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const pubRaw = new Uint8Array(await subtle.exportKey("raw", kp.publicKey));
  return { privateKey: kp.privateKey, pubRaw };
}

async function dh(privateKey, peerPubRaw) {
  const pub = await subtle.importKey(
    "raw", peerPubRaw, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const bits = await subtle.deriveBits({ name: "ECDH", public: pub }, privateKey, 256);
  return new Uint8Array(bits);
}

async function hkdf(ikm, salt, infoStr, lenBytes) {
  const key = await subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info: te.encode(infoStr) }, key, lenBytes * 8);
  return new Uint8Array(bits);
}

async function hmac(keyBytes, dataBytes) {
  const key = await subtle.importKey(
    "raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await subtle.sign("HMAC", key, dataBytes));
}

// 루트 KDF: (rk, dhOut) -> [새 rk(32B), 새 체인키(32B)]
async function kdfRk(rk, dhOut) {
  const out = await hkdf(dhOut, rk, "mildam-dr-rk-v1", 64);
  return [out.slice(0, 32), out.slice(32, 64)];
}

// 체인 KDF: ck -> [다음 ck, 메시지키 mk]
async function kdfCk(ck) {
  const mk = await hmac(ck, new Uint8Array([1]));
  const next = await hmac(ck, new Uint8Array([2]));
  return [next, mk];
}

function headerStr(h) {
  // AAD 바인딩용 정準 직렬화(키 순서 고정)
  return `{"sid":"${h.sid}","dh":"${h.dh}","pn":${h.pn},"n":${h.n}}`;
}

async function aeadEncrypt(mk, ptBytes, aadBytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await subtle.importKey("raw", mk, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aadBytes }, key, ptBytes));
  return { iv, ct };
}

async function aeadDecrypt(mk, iv, ct, aadBytes) {
  const key = await subtle.importKey("raw", mk, "AES-GCM", false, ["decrypt"]);
  const pt = await subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: aadBytes }, key, ct);
  return new Uint8Array(pt);
}

// ---------------------------------------------------------------- 세션(단일 더블 래칫)

function cloneState(s) {
  return {
    ...s,
    rk: s.rk.slice(),
    cks: s.cks ? s.cks.slice() : null,
    ckr: s.ckr ? s.ckr.slice() : null,
    skipped: new Map(s.skipped),
  };
}

// 발신자(initiator): 상대 spk를 초기 DHr로 사용
async function initiatorInit(rootSecret, peerSpkRaw) {
  const dhs = await genDH();
  const [rk, cks] = await kdfRk(rootSecret, await dh(dhs.privateKey, peerSpkRaw));
  return {
    sid: bufToB64u(dhs.pubRaw), role: "init",
    rk, dhsPriv: dhs.privateKey, dhsPubRaw: dhs.pubRaw,
    dhrPubRaw: peerSpkRaw.slice(),
    cks, ckr: null, ns: 0, nr: 0, pn: 0,
    skipped: new Map(), lastUsed: 0,
  };
}

// 수신자(responder): 자신의 spk 개인키로 첫 수신 시 래칫 시작
function responderInit(rootSecret, mySpk, sid) {
  return {
    sid, role: "resp",
    rk: rootSecret.slice(),
    dhsPriv: mySpk.privateKey, dhsPubRaw: mySpk.pubRaw.slice(),
    dhrPubRaw: null,
    cks: null, ckr: null, ns: 0, nr: 0, pn: 0,
    skipped: new Map(), lastUsed: 0,
  };
}

async function sessEncrypt(st, ptBytes, ad) {
  if (!st.cks) throw new Error("pfs: sending chain not established");
  const [nextCk, mk] = await kdfCk(st.cks);
  const h = { sid: st.sid, dh: bufToB64u(st.dhsPubRaw), pn: st.pn, n: st.ns };
  const aad = te.encode(ad + "|" + headerStr(h));
  const { iv, ct } = await aeadEncrypt(mk, ptBytes, aad);
  st.cks = nextCk;
  st.ns += 1;
  return { h, iv: bufToB64u(iv), ct: bufToB64u(ct) };
}

function trySkipped(st, h) {
  const key = h.dh + "|" + h.n;
  const mk = st.skipped.get(key);
  if (mk) st.skipped.delete(key);
  return mk || null;
}

async function skipMessageKeys(st, until) {
  if (st.nr >= until) return;
  if (st.ckr === null) throw new Error("pfs: no receiving chain to skip");
  if (until - st.nr > MAX_SKIP) throw new Error("pfs: too many skipped messages");
  const dhB64u = bufToB64u(st.dhrPubRaw);
  while (st.nr < until) {
    const [nextCk, mk] = await kdfCk(st.ckr);
    st.skipped.set(dhB64u + "|" + st.nr, mk);
    st.ckr = nextCk;
    st.nr += 1;
  }
  while (st.skipped.size > MAX_SKIPPED_STORE) {
    st.skipped.delete(st.skipped.keys().next().value);
  }
}

async function dhRatchet(st, h) {
  st.pn = st.ns;
  st.ns = 0;
  st.nr = 0;
  st.dhrPubRaw = b64uToBuf(h.dh);
  let out = await kdfRk(st.rk, await dh(st.dhsPriv, st.dhrPubRaw));
  st.rk = out[0];
  st.ckr = out[1];
  const dhs = await genDH();
  st.dhsPriv = dhs.privateKey;
  st.dhsPubRaw = dhs.pubRaw;
  out = await kdfRk(st.rk, await dh(st.dhsPriv, st.dhrPubRaw));
  st.rk = out[0];
  st.cks = out[1];
}

// 실패 시 원본 상태를 오염시키지 않도록 사본에서 진행하고 성공 시에만 커밋한다.
async function sessDecrypt(orig, env, ad) {
  const st = cloneState(orig);
  const h = env.h;
  const aad = te.encode(ad + "|" + headerStr(h));
  const iv = b64uToBuf(env.iv);
  const ct = b64uToBuf(env.ct);

  let mk = trySkipped(st, h);
  if (!mk) {
    if (st.dhrPubRaw === null || h.dh !== bufToB64u(st.dhrPubRaw)) {
      await skipMessageKeys(st, h.pn);   // 이전 수신 체인 마무리
      await dhRatchet(st, h);
    }
    await skipMessageKeys(st, h.n);      // 현재 체인에서 건너뛴 키 보관
    const [nextCk, derived] = await kdfCk(st.ckr);
    st.ckr = nextCk;
    st.nr += 1;
    mk = derived;
  }
  const pt = await aeadDecrypt(mk, iv, ct, aad);  // 실패 시 여기서 throw
  return { pt, state: st };
}

// ---------------------------------------------------------------- 공개 API

// 온보딩 시 1회: 서명된 프리키(spk)용 P-256 키쌍 생성.
// pubRaw(65바이트)를 초대코드에 싣고, {privateKey, pubRaw}는 IndexedDB에 보관.
export async function createRatchetPrekey() {
  return genDH();
}

// 루트 시크릿 유도. convKey = NIP-44 대화키(32바이트), pkAHex/pkBHex = 두 신원 공개키.
export async function deriveRootSecret(convKey, pkAHex, pkBHex) {
  const [lo, hi] = pkAHex < pkBHex ? [pkAHex, pkBHex] : [pkBHex, pkAHex];
  return hkdf(convKey, te.encode("mildam-dr-sk-v1"), lo + "|" + hi, 32);
}

// AAD 문자열(대화 바인딩).
export function makeAd(pkAHex, pkBHex) {
  const [lo, hi] = pkAHex < pkBHex ? [pkAHex, pkBHex] : [pkBHex, pkAHex];
  return "mildam-dr-v1|" + lo + "|" + hi;
}

// 연락처당 1개의 매니저 상태. 그대로 IndexedDB에 저장 가능(structured clone).
export function createManager(myPkHex, peerPkHex) {
  return { v: 1, myPk: myPkHex, peerPk: peerPkHex, sessions: {}, currentSid: null };
}

function prune(mgr) {
  const sids = Object.keys(mgr.sessions);
  if (sids.length <= MAX_SESSIONS) return;
  const victims = sids
    .filter((sid) => sid !== mgr.currentSid)
    .sort((a, b) => mgr.sessions[a].lastUsed - mgr.sessions[b].lastUsed);
  while (Object.keys(mgr.sessions).length > MAX_SESSIONS && victims.length) {
    delete mgr.sessions[victims.shift()];
  }
}

// ctx = { rootSecret:Uint8Array(32), peerSpkRaw:Uint8Array(65), ad:string }
// 반환: 봉투 { h:{sid,dh,pn,n}, iv:b64u, ct:b64u }  (rumor content에 실을 것)
export async function managerEncrypt(mgr, ctx, ptBytes) {
  if (!mgr.currentSid) {
    const s = await initiatorInit(ctx.rootSecret, ctx.peerSpkRaw);
    mgr.sessions[s.sid] = s;
    mgr.currentSid = s.sid;
  }
  const s = mgr.sessions[mgr.currentSid];
  const env = await sessEncrypt(s, ptBytes, ctx.ad);
  s.lastUsed = Date.now();
  return env;
}

// ctx = { rootSecret, mySpk:{privateKey, pubRaw}, ad:string }
// 성공: 평문 Uint8Array 반환 + mgr 상태 갱신. 실패: throw(호출자는 해당 봉투 폐기).
export async function managerDecrypt(mgr, ctx, env) {
  const sid = env.h.sid;
  let s = mgr.sessions[sid];
  const isNew = !s;
  if (isNew) s = responderInit(ctx.rootSecret, ctx.mySpk, sid);

  const { pt, state } = await sessDecrypt(s, env, ctx.ad);
  state.lastUsed = Date.now();
  mgr.sessions[sid] = state;

  if (isNew) {
    if (!mgr.currentSid) {
      mgr.currentSid = sid;
    } else if (mgr.sessions[mgr.currentSid].role === "init") {
      // 동시 개시 충돌: 신원 공개키가 사전순으로 작은 쪽이 개시한 세션이 승자.
      mgr.currentSid = mgr.myPk < mgr.peerPk ? mgr.currentSid : sid;
    } else {
      mgr.currentSid = sid;
    }
    prune(mgr);
  }
  return pt;
}
