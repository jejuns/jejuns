#!/usr/bin/env node
// helper.mjs — 밀담 도우미 데몬 (PLAN.md §16).
//
// 역할은 딱 둘: ① 새 암호문 감지 시 내용 없는 푸시 알림 발송, ② 암호문
// 30일 보관·재발행. 대화 복호 키가 없으므로 내용 접근은 애초에 불가능하다.
// 바깥 방향 연결만 사용한다(포트 개방·도메인·인증서 불필요).
//
// 실행: node helper.mjs   (같은 폴더에 npm install 먼저)

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import webpush from "web-push";
import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools/pure";
import { SimplePool } from "nostr-tools/pool";
import { wrapEvent, unwrapEvent } from "nostr-tools/nip17";
import { GiftWrap } from "nostr-tools/kinds";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(__dirname, "state");
const IDENTITY_PATH = path.join(STATE_DIR, "identity.json");
const VAPID_PATH = path.join(STATE_DIR, "vapid.json");
const SUBS_PATH = path.join(STATE_DIR, "subs.json");

// v4 §S9: 릴레이는 맥 릴레이 하나뿐이다(config.json의 relayUrl). 공개 릴레이는
// 더 이상 쓰지 않는다 — 금지사항 #5.
const CONFIG_PATH = path.join(__dirname, "config.json");

const PUSH_MIN_INTERVAL_MS = 120000; // §16.4: 사용자별 최소 간격 120초

function b64u(buf) {
  return Buffer.from(buf).toString("base64url");
}
function hexToBytes(hex) {
  return new Uint8Array(Buffer.from(hex, "hex"));
}
function bytesToHex(buf) {
  return Buffer.from(buf).toString("hex");
}
function short(pk) {
  return pk.slice(0, 8) + "…";
}

async function readJsonIfExists(filePath, fallback) {
  if (!existsSync(filePath)) return fallback;
  return JSON.parse(await readFile(filePath, "utf8"));
}

// ---------------------------------------------------------------- §16.2 초기화

async function loadOrCreateIdentity() {
  const existing = await readJsonIfExists(IDENTITY_PATH, null);
  if (existing) return { sk: hexToBytes(existing.sk), pk: existing.pk };
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  await writeFile(IDENTITY_PATH, JSON.stringify({ sk: bytesToHex(sk), pk }, null, 2));
  return { sk, pk };
}

async function loadOrCreateVapid() {
  const existing = await readJsonIfExists(VAPID_PATH, null);
  if (existing) return existing;
  const keys = webpush.generateVAPIDKeys();
  await writeFile(VAPID_PATH, JSON.stringify(keys, null, 2));
  return keys;
}

function printHelperCode(pk, vapidPublicKey) {
  const payload = { v: 1, pk, vapid: vapidPublicKey };
  const code = "MDH1." + b64u(Buffer.from(JSON.stringify(payload), "utf8"));
  console.log("\n========================================================");
  console.log("도우미 코드 (밀담 앱의 설정 → 도우미 등록에 붙여넣으세요):");
  console.log(code);
  console.log("========================================================\n");
}

// ---------------------------------------------------------------- 저장소

async function loadSubs() {
  return readJsonIfExists(SUBS_PATH, {});
}
async function saveSubs(subs) {
  await writeFile(SUBS_PATH, JSON.stringify(subs, null, 2));
}

// v4 §S9: 암호문 아카이브·재발행 기능은 전면 삭제했다. 맥 릴레이가 같은 보관
// 역할을 하므로 완전한 중복이었고, 탈취된 맥에 메타데이터를 집적시키는 유일한
// 요소였다(F-02).

async function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    console.error(
      "helper/config.json 이 없습니다.\n" +
      "  cp helper/config.example.json helper/config.json\n" +
      "그런 다음 relayUrl 을 맥 릴레이 주소로 바꾸세요."
    );
    process.exit(1);
  }
  let cfg;
  try {
    cfg = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  } catch (err) {
    console.error("helper/config.json 을 읽을 수 없습니다:", err.message);
    process.exit(1);
  }
  if (typeof cfg.relayUrl !== "string" || !/^wss?:\/\//.test(cfg.relayUrl)) {
    console.error("helper/config.json 의 relayUrl 이 없거나 ws(s):// 형식이 아닙니다.");
    process.exit(1);
  }
  return cfg;
}

// ---------------------------------------------------------------- 메인

async function main() {
  await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });

  const config = await loadConfig();
  const RELAYS = [config.relayUrl];

  const identity = await loadOrCreateIdentity();
  const vapid = await loadOrCreateVapid();
  webpush.setVapidDetails("mailto:mildam-helper@localhost", vapid.publicKey, vapid.privateKey);

  printHelperCode(identity.pk, vapid.publicKey);

  let subs = await loadSubs();
  // v4 §S9: 중복 푸시 방지는 인메모리 Set으로만 한다 — 재시작 시 비어도
  // 무해하다(최악의 경우 알림 1건이 중복될 뿐이고, 디스크에 메타데이터를
  // 남기지 않는 쪽이 훨씬 중요하다).
  const seenEventIds = new Set();
  const lastPushAt = new Map();

  const pool = new SimplePool();

  // v4 §S8-d: 맥 릴레이는 REQ 전에 NIP-42 인증을 요구한다. AbstractRelay.auth()가
  // 서명 안 된 kind 22242 템플릿을 넘겨주고 서명된 이벤트를 돌려받는다(실물
  // 계약 확인 완료). 도우미 pk도 릴레이 config.json의 allowedPubkeys에 있어야 한다.
  const onauth = (authEventTemplate) => finalizeEvent(authEventTemplate, identity.sk);

  // §16.3: 사용자→도우미 등록 DM(kind 1059, content는 §16.3의 pushsub 페이로드)을
  // 계속 구독한다. NIP-17만 쓰고 pfs 봉투는 없다(도우미가 직접 읽어야 하므로).
  pool.subscribe(
    RELAYS,
    { kinds: [GiftWrap], "#p": [identity.pk] },
    {
      onauth,
      onevent(wrap) {
        let rumor;
        try {
          rumor = unwrapEvent(wrap, identity.sk);
        } catch {
          return; // 조용히 폐기
        }
        let content;
        try {
          content = JSON.parse(rumor.content);
        } catch {
          return;
        }
        if (content?.v !== 3 || content?.kind !== "pushsub" || !content.sub) return;
        // v4 §S9(F-16): 등록 DM은 재생될 수 있다. 저장된 ts보다 크지 않은 ts의
        // 등록은 무시해 옛 구독으로 되돌아가는 것을 막는다.
        const ts = content.ts;
        if (typeof ts !== "number" || !Number.isFinite(ts)) return;
        const prev = subs[rumor.pubkey];
        if (prev && typeof prev.ts === "number" && ts <= prev.ts) {
          console.log(`[무시] ${short(rumor.pubkey)} 사용자의 오래된 등록 DM(ts가 진행하지 않음)`);
          return;
        }
        subs[rumor.pubkey] = { sub: content.sub, ts };
        saveSubs(subs).catch((err) => console.warn("subs.json 저장 실패:", err));
        console.log(`[등록] ${short(rumor.pubkey)} 사용자가 푸시 구독을 등록/갱신함`);
        restartWatch();
      },
    }
  );

  // §16.4: 등록된 사용자들 앞으로 오는 kind 1059를 감시 → 내용 없는 푸시 발송
  let watchCloser = null;
  function restartWatch() {
    const pks = Object.keys(subs);
    watchCloser?.close("resubscribe");
    if (pks.length === 0) return;
    watchCloser = pool.subscribe(
      RELAYS,
      { kinds: [GiftWrap], "#p": pks },
      {
        onauth,
        onevent(event) {
          handleWatchedEvent(event).catch((err) =>
            console.warn("이벤트 처리 중 오류:", err)
          );
        },
      }
    );
  }

  async function handleWatchedEvent(event) {
    if (seenEventIds.has(event.id)) return; // 이미 처리한 이벤트
    seenEventIds.add(event.id);

    const targetPk = event.tags.find((t) => t[0] === "p")?.[1];
    if (!targetPk || !subs[targetPk]) return;

    console.log(`[감지] ${short(targetPk)} 앞으로 새 암호문 도착 (id=${short(event.id)})`);

    const last = lastPushAt.get(targetPk) || 0;
    if (Date.now() - last < PUSH_MIN_INTERVAL_MS) {
      console.log(`  → 최근 알림 간격(120초) 이내라 무음 폐기`);
      return;
    }
    lastPushAt.set(targetPk, Date.now());

    try {
      await webpush.sendNotification(subs[targetPk].sub, undefined);
      console.log(`  → 푸시 발송 성공`);
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        console.warn(`  → 구독이 만료됨(410/404), ${short(targetPk)}의 구독 삭제`);
        delete subs[targetPk];
        await saveSubs(subs);
        restartWatch();
      } else {
        console.warn(`  → 푸시 발송 실패:`, err.message);
      }
    }
  }

  restartWatch();


  console.log(`도우미가 실행 중입니다. 등록된 사용자: ${Object.keys(subs).length}명`);
}

main().catch((err) => {
  console.error("도우미 실행 중 치명적 오류:", err);
  process.exit(1);
});
