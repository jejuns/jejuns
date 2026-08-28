// config.js — 릴레이 종단 설정.
// 이 값은 tools/set-relay.mjs 가 index.html의 CSP와 함께 갱신한다. 직접 고치지 말 것.
// (두 곳이 어긋나면 CSP가 연결을 막아 앱이 조용히 오프라인이 된다.)
export const RELAYS = ["wss://example-host.ts.net/relay"];
