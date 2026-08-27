// crypto.js — 키·초대코드·안전코드·NIP-17 wrap/unwrap·pfs 호출 (PLAN.md §6).
// DOM을 만지지 않는다.

import { generateSecretKey, getPublicKey, schnorr } from "../vendor/nostr-tools.js";
import { createRatchetPrekey } from "./pfs.js";
import { bufToB64u, b64uToBuf, bufToHex, hexToBuf, te, td, sha256Hex } from "./util.js";

const INVITE_PREFIX = "MD3.";
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

// ---------------------------------------------------------------- §6.7 안전코드

export async function computeSafetyCode(pkA, pkB) {
  const [lo, hi] = pkA < pkB ? [pkA, pkB] : [pkB, pkA];
  return sha256Hex(`mildam-safety-v2|${lo}|${hi}`);
}

export function formatSafetyCode(hex64) {
  return hex64.match(/.{1,8}/g).join(" ");
}
