// main.js — 부팅, 화면 전환, 이벤트 바인딩 (오케스트레이션만, PLAN.md §5).

import {
  getIdentity, saveIdentity, getAllContacts, addContact, contactExists, getContact,
  getSession, saveSession, addMessage, hasMessageFrom, updateMessageStatusFrom,
  getMessagesByContact, getLastSync, setLastSync, hasSeenWrap, markSeenWrap,
  pruneSeenWraps, getHelper, saveHelper,
} from "./store.js";
import {
  generateIdentity, encodeInviteCode, parseInviteCode, verifyInviteSignature,
  buildOutgoingWrap, unwrapIncoming, decryptPayload, computeSafetyCode, formatSafetyCode,
  parseHelperCode, buildHelperRegistrationWrap,
} from "./crypto.js";
import { createManager } from "./pfs.js";
import * as net from "./net.js";
import { te, b64uToBuf } from "./util.js";

// PLAN.md §11 오류 문구 표 (그대로).
const ERRORS = {
  E01: "초대코드 형식이 올바르지 않습니다",
  E04: "자기 자신은 추가할 수 없습니다",
  E05: "이미 추가된 친구입니다",
  E07: "전송에 실패했습니다. 네트워크 확인 후 메시지를 탭해 다시 보내세요.",
  E08: "초대코드 검증에 실패했습니다. 상대에게 코드를 다시 받아 확인하세요.",
  E09: "도우미 코드 형식이 올바르지 않습니다",
};

// v4 §S1(F-06): 복호된 페이로드의 id/ref/body/ts를 신뢰하지 않고 검증한다.
const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function isUuidV4(s) {
  return typeof s === "string" && UUID_V4_RE.test(s);
}

// 범위를 벗어난 ts는 버리지 않고 클램프한다 — 기기 시계 오차로 정상 메시지를
// 잃는 것보다, 정렬을 공격자가 조종하지 못하게 막는 쪽이 중요하다.
function clampTs(ts) {
  if (!Number.isSafeInteger(ts)) return null;
  const now = Date.now();
  return Math.min(Math.max(ts, now - 30 * 24 * 60 * 60 * 1000), now + 5 * 60 * 1000);
}

// 양방향 제어·제로폭 문자를 U+FFFD로 치환한다. textContent를 쓰므로 XSS는
// 아니지만, 연락처를 시각적으로 사칭하는 것을 막는다.
function sanitizeForDisplay(s) {
  return s.replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "\uFFFD");
}

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
  let result;
  try {
    result = await sendText(contact, body);
  } finally {
    sendBtn.disabled = net.getState() !== "online";
  }
  if (!result.ok) toast(ERRORS.E07);
  await renderChatMessages(currentChatPk);
}

function resendMessage(msg) {
  return enqueueSessionOp(() => resendMessageLocked(msg));
}

async function resendMessageLocked(msg) {
  const contact = await getContact(msg.pk);
  if (!contact) return;
  const mgr = (await getSession(contact.pk)) || createManager(identity.pk, contact.pk);
  const payload = { v: 3, kind: "text", id: msg.id, body: msg.body, ts: msg.ts };
  const wrapped = await buildOutgoingWrap(identity, contact, mgr, te.encode(JSON.stringify(payload)));
  await saveSession(contact.pk, mgr);
  const result = await net.publishWrap(wrapped);
  await updateMessageStatusFrom(msg.pk, msg.id, result.ok ? "sent" : "failed", "out");
  if (!result.ok) toast(ERRORS.E07);
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

// ---------------------------------------------------------------- 설정(§9.6, §16)

async function openSettingsView() {
  const helper = await getHelper();
  const notifyBtn = document.getElementById("set-notify");
  const hint = document.getElementById("set-notify-hint");
  notifyBtn.disabled = !helper;
  hint.hidden = !!helper;
  showView("view-settings");
}

async function handleHelperSave() {
  const input = document.getElementById("set-helpercode");
  const parsed = parseHelperCode(input.value.trim());
  if (!parsed.ok) {
    toast(ERRORS[parsed.error]);
    return;
  }
  await saveHelper({ pk: parsed.pk, vapid: parsed.vapid });
  toast("도우미가 등록되었습니다");
  document.getElementById("set-notify").disabled = false;
  document.getElementById("set-notify-hint").hidden = true;
}

async function handleNotifyEnable() {
  const helper = await getHelper();
  if (!helper) {
    toast("먼저 도우미 코드를 등록하세요");
    return;
  }
  if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
    console.warn("mildam: this browser does not support Web Push");
    return;
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    toast("알림 권한이 거부되었습니다. 브라우저 설정에서 허용해 주세요.");
    return;
  }

  const registration = await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: b64uToBuf(helper.vapid),
    });
  }

  const wrapped = buildHelperRegistrationWrap(identity, helper.pk, subscription.toJSON());
  const result = await net.publishWrap(wrapped);
  if (result.ok) {
    toast("알림이 켜졌습니다");
  } else {
    toast(ERRORS.E07);
  }
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

// pfs 세션은 "불러오기 → 갱신 → 저장"하는 비원자적 read-modify-write다
// (PLAN.md §8.2). 같은 상대에 대해 이 사이클이 두 개 이상 겹쳐 실행되면
// 나중에 끝난 저장이 앞선 저장을 덮어써 래칫 상태를 잃는다 — 내가 상대에게
// 보내는 메시지, 상대의 메시지에 대한 자동 ack, 수신 처리 자체가 모두
// 같은 세션을 건드리므로 이 셋을 하나의 전역 큐로 완전히 직렬화한다.
let opQueue = Promise.resolve();
function enqueueSessionOp(taskFn) {
  const result = opQueue.then(taskFn, taskFn);
  opQueue = result.then(() => {}, () => {}); // 큐 자체는 항상 계속 진행되어야 함
  return result;
}

// 새 메시지를 상대에게 암호화해 발행한다. 성공 여부와 무관하게 로컬에는
// 즉시 저장한다(상태만 sent/failed로 갈린다 — PLAN.md §8.1).
export function sendText(contact, body) {
  return enqueueSessionOp(() => sendTextLocked(contact, body));
}

async function sendTextLocked(contact, body) {
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

  // v4 §S1(F-06): 복호에 성공했다고 해서 필드 내용까지 신뢰하지 않는다.
  if (payload.kind === "text") {
    const bodyLen = typeof payload.body === "string" ? [...payload.body].length : -1;
    const clampedTs = clampTs(payload.ts);
    if (!isUuidV4(payload.id) || bodyLen < 1 || bodyLen > 2000 || clampedTs === null) {
      console.warn("mildam: text payload failed validation, discarding");
      return;
    }
    payload.ts = clampedTs;
    payload.body = sanitizeForDisplay(payload.body);
  } else if (payload.kind === "ack") {
    const clampedTs = clampTs(payload.ts);
    if (!isUuidV4(payload.ref) || clampedTs === null) {
      console.warn("mildam: ack payload failed validation, discarding");
      return;
    }
    payload.ts = clampedTs;
  }

  if (payload.kind === "text") {
    if (await hasMessageFrom(rumor.pubkey, payload.id)) return; // §6.5: id 중복은 조용히 폐기
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
    // v4 §S2(F-05): 이 상대(rumor.pubkey)와의 대화에서 내가 보낸(out) 메시지만
    // delivered로 바꿀 수 있다 — 다른 대화의 메시지 id로는 조회조차 안 된다.
    await updateMessageStatusFrom(rumor.pubkey, payload.ref, "delivered", "out");
    await refreshChatIfOpen(rumor.pubkey);
  }
  // 그 외 kind는 §6.5에 따라 조용히 폐기(위 분기에 해당하지 않으면 아무 것도 하지 않음)
}

async function startMessaging() {
  net.onStateChange(updateConnectionBadges);
  const lastSync = await getLastSync();
  const since = Math.max(0, lastSync - 172800); // PLAN.md §7.2: gift wrap 시각 무작위화 폭(2일)
  net.startReceiving(identity.pk, since, (rawEvent) => {
    // sendText/resendMessage와 같은 큐를 타야 세션 경합이 완전히 막힌다.
    enqueueSessionOp(() => handleIncomingWrap(rawEvent)).catch((err) =>
      console.warn("mildam: incoming wrap handling threw", err)
    );
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

  document.getElementById("nav-settings").addEventListener("click", () => {
    openSettingsView();
  });
  document.getElementById("set-back").addEventListener("click", () => {
    showView("view-contacts");
  });
  document.getElementById("set-helper-save").addEventListener("click", () => {
    handleHelperSave();
  });
  document.getElementById("set-notify").addEventListener("click", () => {
    handleNotifyEnable();
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
  await pruneSeenWraps(); // PLAN.md §8.1: 부팅 시 7일 지난 seenWraps 항목 정리
  await renderContactsList();
  showView("view-contacts");
  await startMessaging();
}

boot();
