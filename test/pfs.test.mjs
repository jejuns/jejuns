// pfs.js 자동 테스트. 실행: node test/pfs.test.mjs
// 브라우저와 동일한 WebCrypto를 쓰므로 Node 20+에서 그대로 검증된다.
import {
  createRatchetPrekey, deriveRootSecret, makeAd,
  createManager, managerEncrypt, managerDecrypt,
} from "../js/pfs.js";

const te = new TextEncoder();
const td = new TextDecoder();

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log("  ok -", name); }
  else { failed++; console.error("  FAIL -", name); }
}
async function throws(fn, name) {
  try { await fn(); failed++; console.error("  FAIL(no throw) -", name); }
  catch { passed++; console.log("  ok -", name); }
}

// 두 참가자(A,B) 환경 구성. pk는 임의의 64자 hex 흉내.
async function setup() {
  const pkA = "aa".repeat(32);
  const pkB = "bb".repeat(32);
  const convKey = crypto.getRandomValues(new Uint8Array(32)); // NIP-44 대화키 대역
  const root = await deriveRootSecret(convKey, pkA, pkB);
  const rootB = await deriveRootSecret(convKey, pkB, pkA);    // 인자 순서 무관해야 함
  const ad = makeAd(pkA, pkB);
  const spkA = await createRatchetPrekey();
  const spkB = await createRatchetPrekey();
  return {
    pkA, pkB, ad, root, rootB, spkA, spkB,
    A: createManager(pkA, pkB),
    B: createManager(pkB, pkA),
    ctxA: { rootSecret: root, peerSpkRaw: spkB.pubRaw, mySpk: spkA, ad },
    ctxB: { rootSecret: root, peerSpkRaw: spkA.pubRaw, mySpk: spkB, ad },
  };
}
const enc = (s) => te.encode(s);
const dec = (b) => td.decode(b);

async function t1_basicRoundTrip() {
  console.log("t1: 기본 왕복");
  const e = await setup();
  ok(Buffer.compare(e.root, e.rootB) === 0, "deriveRootSecret 인자 순서 무관");
  for (let i = 0; i < 3; i++) {
    const env = await managerEncrypt(e.A, e.ctxA, enc("a" + i));
    ok(dec(await managerDecrypt(e.B, e.ctxB, env)) === "a" + i, "A→B " + i);
  }
  for (let i = 0; i < 3; i++) {
    const env = await managerEncrypt(e.B, e.ctxB, enc("b" + i));
    ok(dec(await managerDecrypt(e.A, e.ctxA, env)) === "b" + i, "B→A " + i);
  }
  // 교대 왕복(래칫 전진)
  for (let i = 0; i < 5; i++) {
    let env = await managerEncrypt(e.A, e.ctxA, enc("ping" + i));
    ok(dec(await managerDecrypt(e.B, e.ctxB, env)) === "ping" + i, "ping " + i);
    env = await managerEncrypt(e.B, e.ctxB, enc("pong" + i));
    ok(dec(await managerDecrypt(e.A, e.ctxA, env)) === "pong" + i, "pong " + i);
  }
}

async function t2_bSendsFirst() {
  console.log("t2: B가 먼저 보냄(역할 역전)");
  const e = await setup();
  const env = await managerEncrypt(e.B, e.ctxB, enc("first"));
  ok(dec(await managerDecrypt(e.A, e.ctxA, env)) === "first", "B 선발신 수신");
  const r = await managerEncrypt(e.A, e.ctxA, enc("reply"));
  ok(dec(await managerDecrypt(e.B, e.ctxB, r)) === "reply", "A 응답 수신");
}

async function t3_simultaneousInit() {
  console.log("t3: 동시 개시 충돌 → 결정적 수렴");
  const e = await setup();
  const a0 = await managerEncrypt(e.A, e.ctxA, enc("a0")); // 서로 상대 응답을 못 본 채
  const b0 = await managerEncrypt(e.B, e.ctxB, enc("b0")); // 동시에 첫 메시지 발신
  ok(dec(await managerDecrypt(e.B, e.ctxB, a0)) === "a0", "충돌: B가 a0 수신");
  ok(dec(await managerDecrypt(e.A, e.ctxA, b0)) === "b0", "충돌: A가 b0 수신");
  // 이후 양방향 계속 + 같은 세션으로 수렴하는지
  const a1 = await managerEncrypt(e.A, e.ctxA, enc("a1"));
  ok(dec(await managerDecrypt(e.B, e.ctxB, a1)) === "a1", "충돌 후 A→B");
  const b1 = await managerEncrypt(e.B, e.ctxB, enc("b1"));
  ok(dec(await managerDecrypt(e.A, e.ctxA, b1)) === "b1", "충돌 후 B→A");
  ok(e.A.currentSid === e.B.currentSid, "양측 currentSid 수렴");
  const a2 = await managerEncrypt(e.A, e.ctxA, enc("a2"));
  ok(dec(await managerDecrypt(e.B, e.ctxB, a2)) === "a2", "수렴 세션에서 계속 통신");
}

async function t4_outOfOrder() {
  console.log("t4: 순서 뒤섞임(같은 체인 + 래칫 경계 넘는 skip)");
  const e = await setup();
  const m = [];
  for (let i = 0; i < 5; i++) m.push(await managerEncrypt(e.A, e.ctxA, enc("m" + i)));
  ok(dec(await managerDecrypt(e.B, e.ctxB, m[3])) === "m3", "m3 먼저 도착");
  ok(dec(await managerDecrypt(e.B, e.ctxB, m[0])) === "m0", "m0 늦게 도착(skipped)");
  ok(dec(await managerDecrypt(e.B, e.ctxB, m[2])) === "m2", "m2");
  ok(dec(await managerDecrypt(e.B, e.ctxB, m[1])) === "m1", "m1");
  ok(dec(await managerDecrypt(e.B, e.ctxB, m[4])) === "m4", "m4");
  // 래칫 경계: B가 응답(새 체인 유발) → A가 새 체인에서 발신했는데
  // 이전 체인 잔여 메시지가 그보다 늦게 도착
  const x0 = await managerEncrypt(e.A, e.ctxA, enc("x0"));
  const x1 = await managerEncrypt(e.A, e.ctxA, enc("x1"));
  ok(dec(await managerDecrypt(e.B, e.ctxB, x0)) === "x0", "x0");
  const r = await managerEncrypt(e.B, e.ctxB, enc("r"));
  ok(dec(await managerDecrypt(e.A, e.ctxA, r)) === "r", "r(래칫 전진)");
  const y0 = await managerEncrypt(e.A, e.ctxA, enc("y0")); // 새 체인
  ok(dec(await managerDecrypt(e.B, e.ctxB, y0)) === "y0", "새 체인 y0 먼저");
  ok(dec(await managerDecrypt(e.B, e.ctxB, x1)) === "x1", "옛 체인 x1 나중(skipped)");
}

async function t5_duplicateAndTamper() {
  console.log("t5: 중복·변조는 실패하되 상태를 오염시키지 않음");
  const e = await setup();
  const m0 = await managerEncrypt(e.A, e.ctxA, enc("m0"));
  ok(dec(await managerDecrypt(e.B, e.ctxB, m0)) === "m0", "정상 수신");
  await throws(() => managerDecrypt(e.B, e.ctxB, m0), "같은 봉투 재수신은 실패(리플레이)");
  const m1 = await managerEncrypt(e.A, e.ctxA, enc("m1"));
  const bad = { ...m1, ct: m1.ct.slice(0, -4) + "AAAA" };
  await throws(() => managerDecrypt(e.B, e.ctxB, bad), "변조 봉투 실패");
  ok(dec(await managerDecrypt(e.B, e.ctxB, m1)) === "m1", "실패 후 정상 봉투는 여전히 복호됨");
  const m2 = await managerEncrypt(e.A, e.ctxA, enc("m2"));
  ok(dec(await managerDecrypt(e.B, e.ctxB, m2)) === "m2", "후속 메시지 정상");
}

async function t6_persistence() {
  console.log("t6: 직렬화(structuredClone) 후 세션 지속");
  const e = await setup();
  let env = await managerEncrypt(e.A, e.ctxA, enc("before"));
  ok(dec(await managerDecrypt(e.B, e.ctxB, env)) === "before", "직렬화 전 통신");
  let A2, B2;
  try {
    A2 = structuredClone(e.A);
    B2 = structuredClone(e.B);
  } catch (err) {
    // Node가 CryptoKey 복제를 지원하지 않으면 여기서 건너뛴다(브라우저 IndexedDB는 지원).
    console.log("  skip - 이 Node 버전은 CryptoKey structuredClone 미지원:", err.message);
    return;
  }
  env = await managerEncrypt(A2, e.ctxA, enc("after-restore"));
  ok(dec(await managerDecrypt(B2, e.ctxB, env)) === "after-restore", "복원된 상태로 A→B");
  env = await managerEncrypt(B2, e.ctxB, enc("back"));
  ok(dec(await managerDecrypt(A2, e.ctxA, env)) === "back", "복원된 상태로 B→A");
}

async function t7_forwardSecrecySmoke() {
  console.log("t7: 래칫 전진 확인(왕복마다 세션 키 재료가 바뀜)");
  const e = await setup();
  const sidSeen = new Set();
  let dhSeen = new Set();
  for (let i = 0; i < 4; i++) {
    const a = await managerEncrypt(e.A, e.ctxA, enc("a" + i));
    await managerDecrypt(e.B, e.ctxB, a);
    const b = await managerEncrypt(e.B, e.ctxB, enc("b" + i));
    await managerDecrypt(e.A, e.ctxA, b);
    sidSeen.add(a.h.sid);
    dhSeen.add(a.h.dh).add(b.h.dh);
  }
  ok(sidSeen.size === 1, "세션은 하나로 유지");
  ok(dhSeen.size === 8, "왕복마다 새 DH 래칫 공개키(8개 모두 상이)");
}

const tests = [t1_basicRoundTrip, t2_bSendsFirst, t3_simultaneousInit,
               t4_outOfOrder, t5_duplicateAndTamper, t6_persistence,
               t7_forwardSecrecySmoke];
for (const t of tests) await t();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
