// net.js — SimplePool 관리, 발행·구독, 연결 상태 (PLAN.md §7). DOM을 만지지 않는다.
// 순수 릴레이 송수신 계층이다: 이 파일은 wrap/unwrap이나 pfs를 다루지 않는다
// (그건 crypto.js의 몫이다). 이미 서명된 kind 1059 이벤트를 발행하고,
// 들어오는 kind 1059 이벤트를 콜백으로 넘길 뿐이다.

import { SimplePool, GiftWrap } from "../vendor/nostr-tools.js";

export const RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net",
  "wss://offchain.pub",
];

const RECONNECT_INTERVAL_MS = 30000;

let pool = null;
let state = "connecting";
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
