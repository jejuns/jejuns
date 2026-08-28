// gen-integrity.mjs — 배포본 무결성 지문 생성 (PLAN-V4-ZEROTRUST.md §S10).
//
// sw.js의 PRECACHE와 "동일한 파일 집합"의 SHA-256을 계산해 integrity.json을
// 만든다. 목록을 손으로 두 벌 유지하면 반드시 어긋나므로 sw.js에서 직접 읽는다.
//
//   node tools/gen-integrity.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

// sw.js의 PRECACHE 배열을 파싱한다.
const sw = readFileSync(join(ROOT, "sw.js"), "utf8");
const match = sw.match(/const PRECACHE = \[([\s\S]*?)\];/);
if (!match) {
  console.error("sw.js 에서 PRECACHE 배열을 찾지 못했습니다.");
  process.exit(1);
}
const entries = [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);

const files = {};
for (const entry of entries) {
  // "./"는 index.html과 같은 리소스이고 integrity.json 자신은 대상이 아니다.
  if (entry === "./" || entry === "integrity.json") continue;
  let buf;
  try {
    buf = readFileSync(join(ROOT, entry));
  } catch {
    console.error(`PRECACHE에 있는 ${entry} 파일을 읽을 수 없습니다.`);
    process.exit(1);
  }
  files[entry] = sha256Hex(buf);
}

// 지문 = 정렬된 "path:hash" 줄들의 SHA-256
const lines = Object.keys(files).sort().map((p) => `${p}:${files[p]}`).join("\n");
const fingerprint = sha256Hex(Buffer.from(lines, "utf8"));

writeFileSync(join(ROOT, "integrity.json"), JSON.stringify({ files, fingerprint }, null, 2) + "\n");

console.log(`integrity.json 생성 완료 — ${Object.keys(files).length}개 파일`);
console.log("지문:", fingerprint);
console.log("앞 16자(설정 화면에 표시되는 값):", fingerprint.slice(0, 16));
