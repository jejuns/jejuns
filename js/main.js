// main.js — 부팅, 화면 전환, 이벤트 바인딩 (오케스트레이션만, PLAN.md §5).

const VIEWS = [
  "view-onboarding",
  "view-contacts",
  "view-add",
  "view-chat",
  "view-safety",
  "view-settings",
];

export function showView(id) {
  for (const v of VIEWS) {
    const el = document.getElementById(v);
    if (el) el.hidden = v !== id;
  }
  try {
    localStorage.setItem("mildam.lastView", id);
  } catch {
    // localStorage 접근 불가(사생활 보호 모드 등) — 뷰 전환 자체는 계속 동작
  }
}

let toastTimer = null;
export function toast(message) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 3000);
}

function supportsRequiredApis() {
  return !!(
    globalThis.crypto &&
    globalThis.crypto.subtle &&
    globalThis.indexedDB &&
    globalThis.TextEncoder &&
    globalThis.TextDecoder
  );
}

function showUnsupported() {
  document.body.innerHTML = "";
  const div = document.createElement("div");
  div.style.cssText =
    "min-height:100dvh;display:flex;align-items:center;justify-content:center;" +
    "padding:24px;text-align:center;background:#0f1420;color:#e8ecf4;" +
    "font-family:system-ui,sans-serif;font-size:16px;line-height:1.6;";
  div.textContent = "이 브라우저는 지원되지 않습니다. 최신 Chrome 또는 Safari를 사용하세요.";
  document.body.appendChild(div);
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("sw.js");
  } catch (err) {
    console.warn("mildam: service worker registration failed", err);
  }
}

async function boot() {
  if (!supportsRequiredApis()) {
    showUnsupported();
    return;
  }
  await registerServiceWorker();

  // 저장소 계층(store.js)은 M1에서 추가된다. 그 전까지는 온보딩 화면을 기본으로 보인다.
  showView("view-onboarding");
}

boot();
