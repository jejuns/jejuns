// main.js — 부팅, 화면 전환, 이벤트 바인딩 (오케스트레이션만, PLAN.md §5).

import {
  getIdentity, saveIdentity, getAllContacts, addContact, contactExists,
} from "./store.js";
import {
  generateIdentity, encodeInviteCode, parseInviteCode, verifyInviteSignature,
} from "./crypto.js";

// PLAN.md §11 오류 문구 표 (그대로).
const ERRORS = {
  E01: "초대코드 형식이 올바르지 않습니다",
  E04: "자기 자신은 추가할 수 없습니다",
  E05: "이미 추가된 친구입니다",
  E08: "초대코드 검증에 실패했습니다. 상대에게 코드를 다시 받아 확인하세요.",
};

const VIEWS = [
  "view-onboarding",
  "view-contacts",
  "view-add",
  "view-chat",
  "view-safety",
  "view-settings",
];

let identity = null;

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

// ---------------------------------------------------------------- 연락처 목록

async function renderContactsList() {
  const contacts = await getAllContacts();
  const listEl = document.getElementById("contacts-list");
  const emptyEl = document.getElementById("contacts-empty");
  listEl.textContent = "";
  emptyEl.hidden = contacts.length > 0;
  for (const c of contacts) {
    const li = document.createElement("li");
    li.className = "contact-item";
    li.dataset.pk = c.pk;
    const name = document.createElement("div");
    name.className = "contact-name";
    name.textContent = c.name;
    li.appendChild(name);
    listEl.appendChild(li);
  }
}

// ---------------------------------------------------------------- 온보딩

async function handleCreateIdentity() {
  const input = document.getElementById("ob-name");
  const name = input.value.trim();
  if (name.length < 1 || name.length > 20) return;

  identity = await generateIdentity(name);
  await saveIdentity(identity);

  if (navigator.storage && navigator.storage.persist) {
    try {
      const granted = await navigator.storage.persist();
      console.info("mildam: storage persist granted =", granted);
    } catch (err) {
      console.info("mildam: storage persist request failed", err);
    }
  }

  await renderContactsList();
  showView("view-contacts");
}

// ---------------------------------------------------------------- 친구 추가

function openAddView() {
  const codeEl = document.getElementById("add-mycode");
  codeEl.value = encodeInviteCode(identity);
  document.getElementById("add-peercode").value = "";
  showView("view-add");
}

async function handleCopyCode() {
  const codeEl = document.getElementById("add-mycode");
  try {
    await navigator.clipboard.writeText(codeEl.value);
    toast("코드가 복사되었습니다");
  } catch (err) {
    console.warn("mildam: clipboard write failed", err);
  }
}

async function handleAddSubmit() {
  const input = document.getElementById("add-peercode");
  const parsed = parseInviteCode(input.value.trim());
  if (!parsed.ok) {
    toast(ERRORS[parsed.error]);
    return;
  }
  if (parsed.pk === identity.pk) {
    toast(ERRORS.E04);
    return;
  }
  if (await contactExists(parsed.pk)) {
    toast(ERRORS.E05);
    return;
  }
  const validSig = await verifyInviteSignature(parsed);
  if (!validSig) {
    toast(ERRORS.E08);
    return;
  }
  await addContact({
    pk: parsed.pk,
    name: parsed.name,
    spkRaw: parsed.spkRaw,
    addedAt: Date.now(),
  });
  toast("친구가 추가되었습니다");
  input.value = "";
  await renderContactsList();
  showView("view-contacts");
}

// ---------------------------------------------------------------- 이벤트 배선

function wireEvents() {
  document.getElementById("ob-create").addEventListener("click", () => {
    handleCreateIdentity();
  });

  document.getElementById("nav-add").addEventListener("click", () => {
    openAddView();
  });
  document.getElementById("add-back").addEventListener("click", () => {
    showView("view-contacts");
  });
  document.getElementById("add-copy").addEventListener("click", () => {
    handleCopyCode();
  });
  document.getElementById("add-submit").addEventListener("click", () => {
    handleAddSubmit();
  });
}

// ---------------------------------------------------------------- 부팅

async function boot() {
  if (!supportsRequiredApis()) {
    showUnsupported();
    return;
  }
  await registerServiceWorker();
  wireEvents();

  identity = await getIdentity();
  if (!identity) {
    showView("view-onboarding");
    return;
  }
  await renderContactsList();
  showView("view-contacts");
}

boot();
