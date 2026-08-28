// relay.mjs — 밀담 전용 최소 Nostr 릴레이 (PLAN-V4-ZEROTRUST.md §S8-a, §S8-d).
//
// 이 릴레이는 신뢰되지 않는 구성요소다(불변식 #2). 여기에 평문이나 키는 절대
// 오지 않으며, 이 프로세스가 통째로 탈취되어도 공격자가 얻는 것은 암호문과
// 메타데이터뿐이다. 그래서 로그에도 pk·id는 앞 8자만 남기고 content는 절대
// 남기지 않는다.
//
// 앱 코드(HTML/JS)는 이 서버가 서빙하지 않는다 — 불변식 #1. 코드 오리진이
// 뚫리면 키가 유출되어 복구가 불가능하지만, 릴레이가 뚫리는 것은 피해가
// 한정된다. 두 역할을 절대 한 프로세스에 합치지 말 것.

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { verifyEvent } from "nostr-tools/pure";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(HERE, "config.json");
const STATE_DIR = join(HERE, "state");
const EVENTS_PATH = join(STATE_DIR, "events.jsonl");

const GIFT_WRAP = 1059;
const CLIENT_AUTH = 22242;
const MAX_FILTERS = 5;
const EVENT_RATE_LIMIT = 20;        // 연결당 초당 EVENT 상한
const AUTH_MAX_SKEW_SEC = 600;
const FUTURE_TOLERANCE_SEC = 600;   // P-6: 기기 시계 오차만 흡수하면 충분하다
const WRAP_JITTER_DAYS = 2;         // NIP-59 시각 무작위화 폭 (PLAN.md §7.2)
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------- 설정

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    console.error(
      "relay/config.json 이 없습니다.\n" +
      "  cp relay/config.example.json relay/config.json\n" +
      "그런 다음 allowedPubkeys에 두 폰과 도우미의 공개키(hex)를 넣으세요."
    );
    process.exit(1);
  }
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch (err) {
    console.error("relay/config.json 을 읽을 수 없습니다:", err.message);
    process.exit(1);
  }
  const allowed = cfg.allowedPubkeys;
  if (!Array.isArray(allowed) || allowed.length === 0) {
    console.error("relay/config.json 의 allowedPubkeys 가 비어 있습니다.");
    process.exit(1);
  }
  for (const pk of allowed) {
    if (typeof pk !== "string" || !/^[0-9a-f]{64}$/.test(pk)) {
      console.error("allowedPubkeys 에 64자 hex가 아닌 값이 있습니다:", short(String(pk)));
      process.exit(1);
    }
  }
  return {
    port: cfg.port ?? 18787,
    bindHost: cfg.bindHost ?? "127.0.0.1",
    allowedPubkeys: new Set(allowed),
    retentionDays: cfg.retentionDays ?? 7,
    maxEventBytes: cfg.maxEventBytes ?? 131072,
  };
}

const config = loadConfig();

// 로그 정책(불변식 #2): 식별자는 앞 8자만. content는 어떤 경우에도 안 남긴다.
function short(s) {
  return typeof s === "string" ? s.slice(0, 8) : "?";
}
function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

// ---------------------------------------------------------------- 저장

mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });

let events = []; // 메모리 인덱스 (파일과 동일 내용)

function retentionCutoff() {
  return Math.floor(Date.now() / 1000) - config.retentionDays * 86400;
}

function loadEvents() {
  if (!existsSync(EVENTS_PATH)) return [];
  const cutoff = retentionCutoff();
  const out = [];
  for (const line of readFileSync(EVENTS_PATH, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.created_at >= cutoff) out.push(ev);
    } catch {
      // 손상된 줄은 조용히 건너뛴다 — 부분 기록된 마지막 줄일 수 있다.
    }
  }
  return out;
}

function rewriteEvents() {
  const cutoff = retentionCutoff();
  const before = events.length;
  events = events.filter((ev) => ev.created_at >= cutoff);
  writeFileSync(EVENTS_PATH, events.map((ev) => JSON.stringify(ev)).join("\n") + (events.length ? "\n" : ""), { mode: 0o600 });
  if (before !== events.length) log(`정리: ${before - events.length}건 만료 삭제, ${events.length}건 보관`);
}

events = loadEvents();
rewriteEvents();
setInterval(rewriteEvents, CLEANUP_INTERVAL_MS).unref?.();

// ---------------------------------------------------------------- 필터

function eventMatchesFilter(filter, event) {
  if (filter.ids && !filter.ids.includes(event.id)) return false;
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
  if (filter.since !== undefined && event.created_at < filter.since) return false;
  if (filter.until !== undefined && event.created_at > filter.until) return false;
  for (const key of Object.keys(filter)) {
    if (key[0] !== "#") continue;
    const tagName = key.slice(1);
    const wanted = filter[key];
    if (!Array.isArray(wanted)) return false;
    if (!event.tags.some(([t, v]) => t === tagName && wanted.includes(v))) return false;
  }
  return true;
}

// REQ 규칙: #p 없는 필터는 아무것도 반환하지 않는다(전체 덤프 방지).
// kinds가 명시되면 1059만 허용한다.
function filterIsServable(filter) {
  if (!Array.isArray(filter["#p"]) || filter["#p"].length === 0) return false;
  if (filter.kinds && filter.kinds.some((k) => k !== GIFT_WRAP)) return false;
  return true;
}

// ---------------------------------------------------------------- EVENT 수용 규칙

function acceptEvent(event) {
  if (!event || typeof event !== "object") return "malformed";
  if (event.kind !== GIFT_WRAP) return "blocked";
  let verified = false;
  try {
    verified = verifyEvent(event) === true;
  } catch {
    verified = false;
  }
  if (!verified) return "blocked";
  if (JSON.stringify(event).length > config.maxEventBytes) return "blocked";

  // P-6: 보관 기간이 지나 어차피 버려질 이벤트는 받지 않고, 미래 쪽은 기기
  // 시계 오차(10분)만 흡수한다. 과거 쪽 여유는 gift wrap 시각 무작위화 폭(2일)
  // + 1일이다.
  const now = Math.floor(Date.now() / 1000);
  const oldest = now - (config.retentionDays + WRAP_JITTER_DAYS + 1) * 86400;
  if (typeof event.created_at !== "number") return "blocked";
  if (event.created_at < oldest || event.created_at > now + FUTURE_TOLERANCE_SEC) return "blocked";

  if (!Array.isArray(event.tags)) return "blocked";
  const hasAllowedRecipient = event.tags.some(
    ([t, v]) => t === "p" && typeof v === "string" && config.allowedPubkeys.has(v)
  );
  if (!hasAllowedRecipient) return "blocked";

  return null; // 수용
}

// ---------------------------------------------------------------- 서버

const wss = new WebSocketServer({ port: config.port, host: config.bindHost });

wss.on("connection", (ws) => {
  // S8-d: 연결이 열리면 즉시 챌린지를 보내고, 인증 전에는 REQ를 서빙하지 않는다.
  // 쓰기(EVENT)는 서명 검증이 이미 완전히 막고 있으므로 인증을 요구하지 않는다.
  const conn = {
    authed: false,
    challenge: randomBytes(16).toString("hex"),
    authedPubkey: null,
    subs: new Map(), // subId -> filters[]
    eventCount: 0,
    windowStart: Date.now(),
  };
  // 발행된 이벤트를 다른 연결의 구독으로 흘려보낼 때 필요하므로 소켓에 매단다.
  ws.__mildam = conn;
  send(ws, ["AUTH", conn.challenge]);

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString("utf8"));
    } catch {
      return;
    }
    if (!Array.isArray(msg) || typeof msg[0] !== "string") return;
    const type = msg[0];

    if (type === "EVENT") handleEvent(ws, conn, msg[1]);
    else if (type === "REQ") handleReq(ws, conn, msg[1], msg.slice(2));
    else if (type === "CLOSE") conn.subs.delete(msg[1]);
    else if (type === "AUTH") handleAuth(ws, conn, msg[1]);
  });

  ws.on("error", () => {});
});

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function handleAuth(ws, conn, event) {
  // 실패 시에도 연결은 유지하고 authed는 false로 남긴다.
  const fail = (reason) => {
    if (event && typeof event.id === "string") send(ws, ["OK", event.id, false, reason]);
    log("AUTH 거부:", reason, "pk=" + short(event?.pubkey));
  };
  if (!event || typeof event !== "object") return;

  let verified = false;
  try {
    verified = verifyEvent(event) === true;
  } catch {
    verified = false;
  }
  if (!verified) return fail("invalid: 서명 검증 실패");
  if (event.kind !== CLIENT_AUTH) return fail("invalid: kind가 22242가 아님");

  const now = Math.floor(Date.now() / 1000);
  if (typeof event.created_at !== "number" || Math.abs(now - event.created_at) > AUTH_MAX_SKEW_SEC) {
    return fail("invalid: created_at이 허용 범위를 벗어남");
  }
  if (!Array.isArray(event.tags)) return fail("invalid: tags 없음");

  const challengeTag = event.tags.find((t) => t[0] === "challenge");
  if (!challengeTag || challengeTag[1] !== conn.challenge) {
    return fail("invalid: challenge 불일치");
  }
  const relayTag = event.tags.find((t) => t[0] === "relay");
  if (!relayTag || typeof relayTag[1] !== "string" || relayTag[1].length === 0) {
    return fail("invalid: relay 태그 없음");
  }
  if (!config.allowedPubkeys.has(event.pubkey)) {
    return fail("restricted: 허용되지 않은 공개키");
  }

  conn.authed = true;
  conn.authedPubkey = event.pubkey;
  // 규칙 B(실물 계약): nostr-tools의 AbstractRelay.auth()는 이 OK 응답을
  // 기다려야 프로미스가 풀리고 SimplePool이 재구독을 진행한다. 계획서 S8-d에는
  // 이 응답 규정이 없지만, 없으면 클라이언트가 인증 후 영영 재구독하지 못한다.
  send(ws, ["OK", event.id, true, ""]);
  log("AUTH 성공: pk=" + short(event.pubkey));
}

function handleEvent(ws, conn, event) {
  // 레이트 리밋: 한 연결에서 초당 EVENT 20건 초과 시 종료.
  const now = Date.now();
  if (now - conn.windowStart >= 1000) {
    conn.windowStart = now;
    conn.eventCount = 0;
  }
  conn.eventCount += 1;
  if (conn.eventCount > EVENT_RATE_LIMIT) {
    send(ws, ["NOTICE", "rate-limited: 초당 EVENT 상한을 초과했습니다"]);
    ws.close();
    return;
  }

  const reject = acceptEvent(event);
  if (reject) {
    if (event && typeof event.id === "string") send(ws, ["OK", event.id, false, "blocked"]);
    return;
  }
  if (events.some((e) => e.id === event.id)) {
    send(ws, ["OK", event.id, true, "duplicate:"]);
    return;
  }

  events.push(event);
  appendFileSync(EVENTS_PATH, JSON.stringify(event) + "\n", { mode: 0o600 });
  send(ws, ["OK", event.id, true, ""]);
  log("EVENT 저장: id=" + short(event.id));

  // 열려 있는 구독 중 조건에 맞는 곳으로 흘려보낸다. 인증된 연결만 구독을
  // 가질 수 있으므로 여기서 별도 인증 검사는 필요 없다.
  for (const client of wss.clients) {
    const cs = client.__mildam;
    if (!cs || !cs.authed) continue;
    for (const [subId, filters] of cs.subs) {
      if (filters.some((f) => filterIsServable(f) && eventMatchesFilter(f, event))) {
        send(client, ["EVENT", subId, event]);
      }
    }
  }
}

function handleReq(ws, conn, subId, filters) {
  if (typeof subId !== "string") return;
  if (!conn.authed) {
    // 접두사 "auth-required: "는 nostr-tools SimplePool이 보고 자동으로
    // 인증 후 재구독을 시도하는 신호다. 반드시 이 형태를 유지할 것.
    send(ws, ["CLOSED", subId, "auth-required: 구독하려면 먼저 인증하세요"]);
    return;
  }
  if (!Array.isArray(filters) || filters.length === 0 || filters.length > MAX_FILTERS) {
    send(ws, ["CLOSED", subId, "invalid: 필터 개수가 허용 범위를 벗어났습니다"]);
    return;
  }

  conn.subs.set(subId, filters);
  const servable = filters.filter(filterIsServable);
  if (servable.length > 0) {
    for (const ev of events) {
      if (servable.some((f) => eventMatchesFilter(f, ev))) send(ws, ["EVENT", subId, ev]);
    }
  }
  // #p 없는 필터만 온 경우에도 EOSE는 보낸다 — 이벤트는 하나도 주지 않는다.
  send(ws, ["EOSE", subId]);
}

log(`밀담 릴레이 시작: ws://${config.bindHost}:${config.port}`);
log(`허용 공개키 ${config.allowedPubkeys.size}개, 보관 ${config.retentionDays}일, 현재 ${events.length}건 보관 중`);
