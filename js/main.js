// main.js — 부팅, 화면 전환, 이벤트 바인딩 (오케스트레이션만, PLAN.md §5).

import {
  getIdentity, saveIdentity, getAllContacts, addContact, contactExists, getContact,
  getSession, saveSession, addMessage, hasMessage, updateMessageStatus,
  getMessagesByContact, getLastSync, setLastSync, hasSeenWrap, markSeenWrap,
} from "./store.js";
import {
  generateIdentity, encodeInviteCode, parseInviteCode, verifyInviteSignature,
  buildOutgoingWrap, unwrapIncoming, decryptPayload, computeSafetyCode, formatSafetyCode,
} from "./crypto.js";
import { createManager } from "./pfs.js";
import * as net from "./net.js";
import { te } from "./util.js";

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
let currentChatPk = null; // 지금 열려 있는 채팅방 상대(없으면 null)
const unreadCounts = new Map(); // pk -> 안 읽은 수신 메시지 수(메모리 전용 UI 상태)

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
    const messages = await getMessagesByContact(c.pk);
    const last = messages[messages.length - 1];
    const unread = unreadCounts.get(c.pk) || 0;

    const li = document.createElement("li");
    li.className = "contact-item";
    li.dataset.pk = c.pk;
    li.addEventListener("click", () => openChat(c));

    const name = document.createElement("div");
    name.className = "contact-name";
    name.textContent = c.name;
    li.appendChild(name);

    if (last) {
      const preview = document.createElement("div");
      preview.className = "contact-preview";
      preview.textContent = last.body;
      li.appendChild(preview);
    }

    if (unread > 0) {
      const badge = document.createElement("span");
      badge.className = "unread-badge";
      badge.textContent = String(unread);
      li.appendChild(badge);
    }

    listEl.appendChild(li);
  }
}

async function refreshContactsListIfVisible() {
  const view = document.getElementById("view-contacts");
  if (view && !view.hidden) await renderContactsList();
}

// ---------------------------------------------------------------- 채팅방

function formatTime(ts) {
  const d = new Date(ts);
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

function statusGlyph(msg) {
  if (msg.dir !== "out") return null;
  if (msg.status === "sent") return { text: "✓", failed: false };
  if (msg.status === "delivered") return { text: "✓✓", failed: false };
  if (msg.status === "failed") return { text: "⚠", failed: true };
  return null;
}

async function renderChatMessages(pk) {
  const container = document.getElementById("chat-messages");
  const messages = await getMessagesByContact(pk);
  container.textContent = "";
  for (const msg of messages) {
    const row = document.createElement("div");
    row.className = "bubble-row " + (msg.dir === "out" ? "out" : "in");

    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = msg.body;
    row.appendChild(bubble);

    const meta = document.createElement("div");
    meta.className = "bubble-meta";
    const glyph = statusGlyph(msg);
    meta.textContent = formatTime(msg.ts) + (glyph ? " " + glyph.text : "");
    if (glyph && glyph.failed) {
      meta.classList.add("failed");
      meta.addEventListener("click", () => resendMessage(msg));
    }
    row.appendChild(meta);

    container.appendChild(row);
  }
  container.scrollTop = container.scrollHeight;
}

async function refreshChatIfOpen(pk) {
  if (currentChatPk === pk) await renderChatMessages(pk);
}

async function openChat(contact) {
  currentChatPk = contact.pk;
  unreadCounts.set(contact.pk, 0);
  document.getElementById("chat-title").textContent = contact.name;
  document.getElementById("chat-input").value = "";
  showView("view-chat");
  updateConnectionBadges(net.getState());
  await renderChatMessages(contact.pk);
}

async function closeChat() {
  currentChatPk = null;
  showView("view-contacts");
  await renderContactsList();
}

async function handleChatSend(event) {
  event.preventDefault();
  const input = document.getElementById("chat-input");
  const sendBtn = document.getElementById("chat-send");
  const body = input.value.trim();
  if (!body || !currentChatPk) return;

  const contact = await getContact(currentChatPk);
  if (!contact) return;

  input.value = "";
  sendBtn.disabled = true;
  try {
    await sendText(contact, body);
  } finally {
    sendBtn.disabled = net.getState() !== "online";
  }
  await renderChatMessages(currentChatPk);
}

async function resendMessage(msg) {
  const contact = await getContact(msg.pk);
  if (!contact) return;
  const mgr = (await getSession(contact.pk)) || createManager(identity.pk, contact.pk);
  const payload = { v: 3, kind: "text", id: msg.id, body: msg.body, ts: msg.ts };
  const wrapped = await buildOutgoingWrap(identity, contact, mgr, te.encode(JSON.stringify(payload)));
  await saveSession(contact.pk, mgr);
  const result = await net.publishWrap(wrapped);
  await updateMessageStatus(msg.id, result.ok ? "sent" : "failed");
  if (!result.ok) toast("전송에 실패했습니다. 네트워크 확인 후 메시지를 탭해 다시 보내세요.");
  await refreshChatIfOpen(msg.pk);
}

// ---------------------------------------------------------------- 안전코드

async function openSafetyView() {
  if (!currentChatPk) return;
  const contact = await getContact(currentChatPk);
  if (!contact) return;
  document.getElementById("safety-name").textContent = contact.name;
  const hex = await computeSafetyCode(identity.pk, contact.pk);
  document.getElementById("safety-code").textContent = formatSafetyCode(hex);
  showView("view-safety");
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
  await startMessaging();
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

// ---------------------------------------------------------------- 연결 상태 배지

function badgeText(state) {
  if (state === "online") return "🔒 암호화 연결됨";
  if (state === "offline") return "오프라인 — 네트워크를 확인하세요";
  return "연결 중…";
}

function updateConnectionBadges(state) {
  const text = badgeText(state);
  const cls = state === "online" ? "online" : state === "offline" ? "offline" : "";
  for (const id of ["contacts-badge", "chat-badge"]) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.textContent = text;
    el.className = "badge" + (cls ? " " + cls : "");
  }
  const sendBtn = document.getElementById("chat-send");
  if (sendBtn) sendBtn.disabled = state !== "online";
}

// ---------------------------------------------------------------- 발신·수신 파이프라인 (§6.6, §7)

// 새 메시지를 상대에게 암호화해 발행한다. 성공 여부와 무관하게 로컬에는
// 즉시 저장한다(상태만 sent/failed로 갈린다 — PLAN.md §8.1).
export async function sendText(contact, body) {
  const mgr = (await getSession(contact.pk)) || createManager(identity.pk, contact.pk);
  const payload = { v: 3, kind: "text", id: crypto.randomUUID(), body, ts: Date.now() };
  const wrapped = await buildOutgoingWrap(identity, contact, mgr, te.encode(JSON.stringify(payload)));
  await saveSession(contact.pk, mgr);
  const result = await net.publishWrap(wrapped);
  await addMessage({
    id: payload.id, pk: contact.pk, dir: "out", body, ts: payload.ts,
    status: result.ok ? "sent" : "failed",
  });
  return { id: payload.id, ok: result.ok };
}

// PLAN.md §7.3 수신 게이트를 순서대로 통과시킨다: ① 중복 wrap ② unwrap 실패
// ③ 미등록 발신자 ④ §6.6 파이프라인. ①~③은 조용히 폐기(콘솔 경고만).
async function handleIncomingWrap(rawEvent) {
  if (await hasSeenWrap(rawEvent.id)) return;
  await markSeenWrap(rawEvent.id);

  let rumor;
  try {
    rumor = unwrapIncoming(identity, rawEvent);
  } catch (err) {
    console.warn("mildam: gift wrap unwrap failed, discarding", err);
    return;
  }

  const contact = await getContact(rumor.pubkey);
  if (!contact) {
    console.warn("mildam: wrap from a sender not in contacts, discarding");
    return;
  }

  const mgr = (await getSession(rumor.pubkey)) || createManager(identity.pk, rumor.pubkey);
  let decrypted;
  try {
    decrypted = await decryptPayload(identity, mgr, rumor);
  } catch (err) {
    console.warn("mildam: pfs decrypt failed, discarding", err);
    return;
  }
  await saveSession(rumor.pubkey, mgr);

  const lastSync = await getLastSync();
  if (rawEvent.created_at > lastSync) await setLastSync(rawEvent.created_at);

  const payload = decrypted.payload;
  if (!payload || payload.v !== 3) return; // §6.5: 미지의 버전은 조용히 폐기

  if (payload.kind === "text") {
    if (await hasMessage(payload.id)) return; // §6.5: id 중복은 조용히 폐기
    await addMessage({
      id: payload.id, pk: rumor.pubkey, dir: "in", body: payload.body,
      ts: payload.ts, status: "received",
    });
    try {
      const ackPayload = { v: 3, kind: "ack", ref: payload.id, ts: Date.now() };
      const ackWrapped = await buildOutgoingWrap(
        identity, contact, mgr, te.encode(JSON.stringify(ackPayload))
      );
      await saveSession(rumor.pubkey, mgr);
      await net.publishWrap(ackWrapped);
    } catch (err) {
      console.warn("mildam: failed to send ack", err);
    }
    if (currentChatPk === rumor.pubkey) {
      await refreshChatIfOpen(rumor.pubkey);
    } else {
      unreadCounts.set(rumor.pubkey, (unreadCounts.get(rumor.pubkey) || 0) + 1);
    }
    await refreshContactsListIfVisible();
  } else if (payload.kind === "ack") {
    await updateMessageStatus(payload.ref, "delivered");
    await refreshChatIfOpen(rumor.pubkey);
  }
  // 그 외 kind는 §6.5에 따라 조용히 폐기(위 분기에 해당하지 않으면 아무 것도 하지 않음)
}

// 릴레이가 재접속 직후 여러 이벤트를 한꺼번에 밀어넣을 수 있다(§7.2 REQ 재생).
// handleIncomingWrap 각각은 같은 상대의 pfs 세션을 "불러오기 → 갱신 →
// 저장"하는 비원자적 read-modify-write이므로, 여러 건이 겹쳐 실행되면 뒤에
// 끝난 저장이 앞선 저장을 덮어써 래칫 상태를 잃을 수 있다. 전역 직렬 큐로
// 한 번에 하나씩만 처리해 이 경합을 막는다.
let incomingQueue = Promise.resolve();

async function startMessaging() {
  net.onStateChange(updateConnectionBadges);
  const lastSync = await getLastSync();
  const since = Math.max(0, lastSync - 172800); // PLAN.md §7.2: gift wrap 시각 무작위화 폭(2일)
  net.startReceiving(identity.pk, since, (rawEvent) => {
    // .catch()가 매번 체인을 정상 종결시키므로, 앞선 이벤트 처리가 실패해도
    // 다음 이벤트는 계속 순서대로 처리된다.
    incomingQueue = incomingQueue
      .then(() => handleIncomingWrap(rawEvent))
      .catch((err) => console.warn("mildam: incoming wrap handling threw", err));
  });
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

  document.getElementById("chat-back").addEventListener("click", () => {
    closeChat();
  });
  document.getElementById("chat-form").addEventListener("submit", (event) => {
    handleChatSend(event);
  });
  document.getElementById("chat-safety").addEventListener("click", () => {
    openSafetyView();
  });
  document.getElementById("safety-back").addEventListener("click", () => {
    showView("view-chat");
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
  await startMessaging();
}

boot();
