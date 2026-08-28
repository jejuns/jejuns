// crypto.js — 키·초대코드·안전코드·NIP-17 wrap/unwrap·pfs 호출 (PLAN.md §6).
// DOM을 만지지 않는다.

import {
  generateSecretKey, getPublicKey, schnorr, getConversationKey, wrapEvent, unwrapEvent,
  finalizeEvent,
} from "../vendor/nostr-tools.js";
import {
  createRatchetPrekey, deriveRootSecret, makeAd, managerEncrypt, managerDecrypt,
} from "./pfs.js";
import { bufToB64u, b64uToBuf, bufToHex, hexToBuf, te, td, sha256Hex } from "./util.js";

const INVITE_PREFIX = "MD3.";
const HELPER_PREFIX = "MDH1.";
const HEX64_RE = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------- §6.2 신원·프리키

async function spkDigest(pk, spkB64u) {
  const digest = await crypto.subtle.digest("SHA-256", te.encode(`mildam-spk-v1|${pk}|${spkB64u}`));
  return new Uint8Array(digest);
}

export async function generateIdentity(name) {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const { privateKey: spkPriv, pubRaw: spkPubRaw } = await createRatchetPrekey();
  const msg = await spkDigest(pk, bufToB64u(spkPubRaw));
  const sigBytes = schnorr.sign(msg, sk);
  return {
    k: "identity",
    sk,
    pk,
    name,
    spkPriv,
    spkPubRaw,
    spkSig: bufToHex(sigBytes),
    createdAt: Date.now(),
  };
}

// ---------------------------------------------------------------- §6.3 초대코드

export function encodeInviteCode(identity) {
  const payload = {
    v: 3,
    name: identity.name,
    pk: identity.pk,
    spk: bufToB64u(identity.spkPubRaw),
    sig: identity.spkSig,
  };
  return INVITE_PREFIX + bufToB64u(te.encode(JSON.stringify(payload)));
}

// 성공: {ok:true, pk, name, spkRaw(Uint8Array 65), sig}
// 형식 오류: {ok:false, error:"E01"}
export function parseInviteCode(code) {
  if (typeof code !== "string" || !code.startsWith(INVITE_PREFIX)) {
    return { ok: false, error: "E01" };
  }
  let obj;
  try {
    const json = td.decode(b64uToBuf(code.slice(INVITE_PREFIX.length)));
    obj = JSON.parse(json);
  } catch {
    return { ok: false, error: "E01" };
  }
  if (!obj || obj.v !== 3) return { ok: false, error: "E01" };
  if (typeof obj.pk !== "string" || !HEX64_RE.test(obj.pk)) return { ok: false, error: "E01" };
  if (typeof obj.name !== "string" || obj.name.length < 1 || obj.name.length > 20) {
    return { ok: false, error: "E01" };
  }
  if (typeof obj.sig !== "string") return { ok: false, error: "E01" };
  let spkRaw;
  try {
    spkRaw = b64uToBuf(obj.spk);
  } catch {
    return { ok: false, error: "E01" };
  }
  if (spkRaw.length !== 65) return { ok: false, error: "E01" };
  return { ok: true, pk: obj.pk, name: obj.name, spkRaw, sig: obj.sig };
}

// parseInviteCode()가 ok:true를 반환한 결과에 대해서만 호출한다.
export async function verifyInviteSignature(parsed) {
  const msg = await spkDigest(parsed.pk, bufToB64u(parsed.spkRaw));
  let sigBytes, pkBytes;
  try {
    sigBytes = hexToBuf(parsed.sig);
    pkBytes = hexToBuf(parsed.pk);
  } catch {
    return false;
  }
  try {
    return schnorr.verify(sigBytes, msg, pkBytes);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- §16.2 도우미 코드

// 성공: {ok:true, pk, vapid}  형식 오류: {ok:false, error:"E09"}
export function parseHelperCode(code) {
  if (typeof code !== "string" || !code.startsWith(HELPER_PREFIX)) {
    return { ok: false, error: "E09" };
  }
  let obj;
  try {
    const json = td.decode(b64uToBuf(code.slice(HELPER_PREFIX.length)));
    obj = JSON.parse(json);
  } catch {
    return { ok: false, error: "E09" };
  }
  if (!obj || obj.v !== 1) return { ok: false, error: "E09" };
  if (typeof obj.pk !== "string" || !HEX64_RE.test(obj.pk)) return { ok: false, error: "E09" };
  if (typeof obj.vapid !== "string" || obj.vapid.length === 0) return { ok: false, error: "E09" };
  return { ok: true, pk: obj.pk, vapid: obj.vapid };
}

// §16.3: 도우미 등록 DM. pfs 봉투 없이 NIP-17/44만으로 보낸다(도우미가
// 직접 읽어야 하므로 — 대화 상대가 아니라 라우팅 인프라다).
export function buildHelperRegistrationWrap(identity, helperPk, pushSubscriptionJson) {
  const content = JSON.stringify({
    v: 3, kind: "pushsub", sub: pushSubscriptionJson, ts: Date.now(),
  });
  return wrapEvent(identity.sk, { publicKey: helperPk }, content);
}

// ---------------------------------------------------------------- §6.7 안전코드

export async function computeSafetyCode(pkA, pkB) {
  const [lo, hi] = pkA < pkB ? [pkA, pkB] : [pkB, pkA];
  return sha256Hex(`mildam-safety-v2|${lo}|${hi}`);
}

export function formatSafetyCode(hex64) {
  return hex64.match(/.{1,8}/g).join(" ");
}

// ---------------------------------------------------------------- §6.6 발신·수신 파이프라인
// pfs.js의 유일한 진입점은 §6.6에 명시된 4개 함수(createRatchetPrekey,
// deriveRootSecret, makeAd, managerEncrypt/managerDecrypt)뿐이다.
// mgr은 호출자가 store.sessions에서 불러와 참조로 넘긴다 — managerEncrypt/
// managerDecrypt는 mgr을 제자리에서(in place) 갱신하므로, 호출 직후 그
// 동일한 mgr을 store에 다시 저장해야 한다(PLAN.md §8.2).

// 발신: 페이로드(§6.5 JSON을 UTF-8 인코딩한 바이트)를 암호화해 kind 1059
// gift wrap 이벤트로 만든다. mgr은 in place로 갱신된다.
export async function buildOutgoingWrap(identity, contact, mgr, payloadBytes) {
  const convKey = getConversationKey(identity.sk, contact.pk);
  const rootSecret = await deriveRootSecret(convKey, identity.pk, contact.pk);
  const ad = makeAd(identity.pk, contact.pk);
  const env = await managerEncrypt(mgr, { rootSecret, peerSpkRaw: contact.spkRaw, ad }, payloadBytes);
  const content = JSON.stringify({ v: 3, e: "dr1", h: env.h, iv: env.iv, ct: env.ct });
  return wrapEvent(identity.sk, { publicKey: contact.pk }, content);
}

// 수신 1단계: NIP-17 unwrap만 수행한다(실패 시 throw — 호출자가 조용히 폐기).
export function unwrapIncoming(identity, wrappedEvent) {
  return unwrapEvent(wrappedEvent, identity.sk);
}

// 수신 2단계: unwrap된 rumor에서 §6.6 봉투를 검사하고 pfs로 복호한다.
// 실패(봉투 형식 불일치, pfs 복호 실패)는 모두 throw — 호출자가 조용히
// 폐기한다. 성공 시 mgr이 in place로 갱신되므로 호출 직후 store에 저장할 것.
export async function decryptPayload(identity, mgr, rumor) {
  const content = JSON.parse(rumor.content);
  if (content.v !== 3 || content.e !== "dr1") {
    throw new Error("mildam: unrecognized dr envelope");
  }
  const senderPk = rumor.pubkey;
  const convKey = getConversationKey(identity.sk, senderPk);
  const rootSecret = await deriveRootSecret(convKey, identity.pk, senderPk);
  const ad = makeAd(identity.pk, senderPk);
  const pt = await managerDecrypt(
    mgr,
    { rootSecret, mySpk: { privateKey: identity.spkPriv, pubRaw: identity.spkPubRaw }, ad },
    { h: content.h, iv: content.iv, ct: content.ct }
  );
  const payload = JSON.parse(td.decode(pt));
  return { payload, senderPk };
}

// ---------------------------------------------------------------- §S8-d NIP-42 인증
// nostr-tools 2.25.0 실물 계약(규칙 B로 확인함):
//   AbstractRelay.auth(signAuthEvent) 가 signAuthEvent(makeAuthEvent(url, challenge))
//   를 호출한다. 인자는 서명 안 된 템플릿
//   { kind: 22242, created_at, tags: [["relay", url], ["challenge", ...]], content: "" }
//   이고, 반환값은 id·sig가 채워진 서명된 이벤트여야 한다(라이브러리가 evt.id로
//   릴레이의 OK 응답을 기다리기 때문). 즉 계획서가 추정한 형태
//   (authEvent) => finalizeEvent(authEvent, sk) 가 실물과 일치했다.
export function buildAuthSigner(identity) {
  return (authEventTemplate) => finalizeEvent(authEventTemplate, identity.sk);
}
