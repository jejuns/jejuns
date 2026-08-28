// net.js — SimplePool 관리, 발행·구독, 연결 상태 (PLAN.md §7). DOM을 만지지 않는다.
// 순수 릴레이 송수신 계층이다: 이 파일은 wrap/unwrap이나 pfs를 다루지 않는다
// (그건 crypto.js의 몫이다). 이미 서명된 kind 1059 이벤트를 발행하고,
// 들어오는 kind 1059 이벤트를 콜백으로 넘길 뿐이다.

import { SimplePool, GiftWrap } from "../vendor/nostr-tools.js";
import { RELAYS } from "./config.js";

// v4 §S8-b: 릴레이 종단은 js/config.js 한 곳에서만 정한다(tools/set-relay.mjs가
// index.html의 CSP와 함께 갱신). 기존 import 경로를 유지하기 위해 re-export 한다.
export { RELAYS };

const RECONNECT_INTERVAL_MS = 30000;

let pool = null;
let state = "connecting";
// v4 §S8-d(P-1): 맥 릴레이는 REQ 전에 NIP-42 인증을 요구한다. 서명자는 main.js가
// 신원을 확보한 뒤 주입한다. 발행(EVENT)에는 인증이 필요 없으므로 구독에만 쓴다.
let authSigner = null;
const stateListeners = new Set();
let currentCloser = null;
let currentArgs = null; // { pk, sinceSeconds, onEvent } — 재연결 시 재사용
let reconnectTimer = null;

function ensurePool() {
  if (pool) return pool;
  pool = new SimplePool({
    enableReconnect: true,
    onRelayConnectionSuccess: recomputeState,
    onRelayConnectionFailure: recomputeState,
  });
  return pool;
}

function setState(next) {
  if (next === state) return;
  state = next;
  for (const cb of stateListeners) {
    try {
      cb(state);
    } catch (err) {
      console.warn("mildam: state listener threw", err);
    }
  }
}

function recomputeState() {
  if (!pool) return;
  const statuses = [...pool.listConnectionStatus().values()];
  const anyConnected = statuses.some(Boolean);
  setState(anyConnected ? "online" : "offline");
}

export function setAuthSigner(fn) {
  authSigner = fn;
}

export function getState() {
  return state;
}

export function onStateChange(cb) {
  stateListeners.add(cb);
  cb(state);
  return () => stateListeners.delete(cb);
}

function openSubscription({ pk, sinceSeconds, onEvent }) {
  const p = ensurePool();
  return p.subscribe(
    RELAYS,
    { kinds: [GiftWrap], "#p": [pk], since: sinceSeconds },
    {
      onauth: authSigner,
      onevent(event) {
        onEvent(event);
      },
      onclose() {
        recomputeState();
      },
    }
  );
}

// pk 앞으로 온 kind 1059 이벤트를 계속 구독한다. 재호출하면 이전 구독을 닫고
// 새로 연다(연락처 재등록 등으로 필터가 바뀔 이유는 없으므로 보통 1회만 호출).
export function startReceiving(pk, sinceSeconds, onEvent) {
  currentCloser?.close("restarted");
  currentArgs = { pk, sinceSeconds, onEvent };
  currentCloser = openSubscription(currentArgs);

  if (!reconnectTimer) {
    reconnectTimer = setInterval(() => {
      if (state === "offline" && currentArgs) {
        currentCloser?.close("reconnect");
        currentCloser = openSubscription(currentArgs);
      }
    }, RECONNECT_INTERVAL_MS);
  }
}

// PLAN.md §6.8: kind 1059가 아닌 이벤트는 발행을 거부한다(도우미 등록 DM도
// kind 1059 gift wrap이므로 이 가드에 걸리지 않는다).
export async function publishWrap(event) {
  if (event.kind !== GiftWrap) {
    throw new Error("mildam: net.publishWrap refuses to publish non-GiftWrap event");
  }
  const p = ensurePool();
  try {
    await Promise.any(p.publish(RELAYS, event));
    return { ok: true };
  } catch {
    return { ok: false };
  }
}
