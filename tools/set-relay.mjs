// set-relay.mjs — 릴레이 종단을 한 번에 갱신한다 (PLAN-V4-ZEROTRUST.md §S8-b).
//
// js/config.js의 RELAYS와 index.html CSP의 connect-src는 반드시 함께 움직여야
// 한다. 한쪽만 바뀌면 CSP가 연결을 막아 앱이 아무 오류도 없이 조용히 오프라인이
// 된다 — 그래서 두 파일을 한 스크립트가 같이 고친다.
//
//   node tools/set-relay.mjs wss://내맥.ts.net/relay

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = join(ROOT, "js", "config.js");
const INDEX_PATH = join(ROOT, "index.html");

const input = process.argv[2];
if (!input) {
  console.error("사용법: node tools/set-relay.mjs wss://<맥>.ts.net/relay");
  process.exit(1);
}

let url;
try {
  url = new URL(input);
} catch {
  console.error("URL 형식이 올바르지 않습니다:", input);
  process.exit(1);
}
if (url.protocol !== "wss:") {
  // ws://는 브라우저가 보안 컨텍스트에서 거부하고, 평문이라 메타데이터가 새어나간다.
  console.error("wss:// 여야 합니다 (자체서명 인증서는 브라우저가 거부하므로 Tailscale 인증서를 쓰세요). 받은 값:", input);
  process.exit(1);
}

const relayUrl = url.href.replace(/\/$/, "");
const cspOrigin = url.origin; // CSP connect-src는 오리진 단위로 적는다

// --- js/config.js ---
const config = readFileSync(CONFIG_PATH, "utf8");
const configNext = config.replace(
  /export const RELAYS = \[[^\]]*\];/,
  `export const RELAYS = [${JSON.stringify(relayUrl)}];`
);
if (configNext === config) {
  console.error("js/config.js 에서 RELAYS 선언을 찾지 못했습니다. 파일이 손상되었는지 확인하세요.");
  process.exit(1);
}

// --- index.html CSP ---
const html = readFileSync(INDEX_PATH, "utf8");
const cspMatch = html.match(/(content="[^"]*connect-src )([^;"]*)([;"])/);
if (!cspMatch) {
  console.error("index.html 에서 CSP의 connect-src를 찾지 못했습니다.");
  process.exit(1);
}
const htmlNext = html.replace(
  /(content="[^"]*connect-src )([^;"]*)([;"])/,
  `$1'self' ${cspOrigin}$3`
);

writeFileSync(CONFIG_PATH, configNext);
writeFileSync(INDEX_PATH, htmlNext);

console.log("릴레이 종단을 갱신했습니다.");
console.log("  js/config.js  RELAYS      =", relayUrl);
console.log("  index.html    connect-src = 'self'", cspOrigin);
console.log("\n주의: 앱 코드는 맥이 아닌 정적 호스팅에 올려야 합니다(불변식 #1).");
console.log("      맥은 릴레이와 알림만 담당합니다.");
