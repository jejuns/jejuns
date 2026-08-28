# 밀담 v4.0 — Zero Trust 전환 작업 지시서 (Sonnet 전용)

> **v1.1 개정 이력 (자체 검토)**
> 초판(v1.0) 배포 전 문서 자체를 다시 검토해 아래 6건의 결함을 고쳤다.
> 가장 중요한 것은 P-1 — S8 릴레이가 **쓰기(발행)만 인증하고 읽기(구독)는
> 인증하지 않아**, tailnet에 있는 아무 기기나 REQ만 보내면 두 사람의 전체
> 암호문·메타데이터를 조용히 열람할 수 있었다. 이는 SECURITY-AUDIT.md §4.1이
> 내세운 "메타데이터 프라이버시 개선" 주장 자체를 무너뜨리는 결함이라
> S8-d(NIP-42 구독 인증)를 신설해 막았다.
>
> | ID | 문제 | 위치 | 조치 |
> |---|---|---|---|
> | P-1 | 구독(REQ)에 인증 없음 — tailnet 내 임의 기기가 전체 메타데이터 열람 가능 | S8 | **S8-d 신설**(NIP-42 챌린지-응답 인증) |
> | P-2 | `sanitizeForDisplay` 정규식에 리터럴 비가시 유니코드 문자를 직접 박아넣음 — 감사 불가, 오타·인코딩 손상 위험 | S1 | `\uXXXX` 이스케이프로 교체 |
> | P-3 | IndexedDB 마이그레이션이 `oldVersion` 분기 없이 서술됨 — 신규 설치와 기존 DB 업그레이드가 뒤섞임 | S2 | `event.oldVersion` 기준 명시적 분기 |
> | P-4 | 갭 탐지 알고리즘 1번이 먼저 체인을 생성해버려 2번의 "새 체인인가" 판정이 항상 거짓이 됨 | S6-b | 판정을 생성보다 먼저 하도록 재정렬 |
> | P-5 | 세션 초기화 2단계 확인 상태가 화면 이탈 시 취소된다는 규정이 없음 — 방치된 확인 상태에서 나중에 무관한 탭이 초기화를 실행할 위험 | S6-a | 이탈 시 확인 상태 취소 규칙 추가 |
> | P-6 | 릴레이 EVENT 수용의 타임스탬프 창(±3일)이 근거 없이 느슨함, 특히 미래 방향 | S8-a | `retentionDays` 연동 + 미래 10분으로 축소 |
>
> ---
>
> **이 문서의 지위**
> 이 문서는 `PLAN.md` v3.0을 **개정**한다. 두 문서가 충돌하면 **이 문서가 이긴다.**
> 이 문서가 언급하지 않는 모든 것은 `PLAN.md` v3.0이 그대로 유효하다.
> 진단 근거는 [`SECURITY-AUDIT.md`](./SECURITY-AUDIT.md)에 있다 — 근거가 궁금하면
> 그 문서를 읽되, **작업 지시는 오직 이 문서에서만 받는다.**
>
> **작업 전 반드시 §1(불변식)과 §6(금지사항)을 먼저 읽을 것.**
> 이 문서에 없는 결정이 필요하면 **임의로 정하지 말고 멈추고 사용자에게 질문한다**(§7 규칙 A).

---

## 0. PLAN.md v3.0에서 개정되는 조항

아래 조항만 개정된다. 나열되지 않은 조항은 **그대로 유효**하다.

| PLAN.md 조항 | 개정 내용 | 이 문서의 해당 절 |
|---|---|---|
| §3 아키텍처 | 공개 릴레이 4곳 → **맥 전용 릴레이 1곳**. 코드 호스팅은 맥 금지 | §2 |
| §7.1 `RELAYS` 목록 | 하드코딩 4곳 삭제 → `js/config.js`에서 import | S8 |
| §8.1 DB 정의 | 버전 `3` → `4`. `messages` 복합키화, `gaps` 스토어 추가 | S2, S6 |
| §9.1 화면 목록 | 변경 없음 (안전코드 화면에 버튼만 추가) | S6 |
| §9.7 문자열 표 | S45~S48 추가 | S6, S10 |
| §11 오류 표 | 변경 없음 | — |
| §15-3 (릴레이 목록 변경 금지) | **이 문서가 지정한 변경에 한해 해제** | S8 |
| §16 헬퍼 사양 | 아카이브·재발행 기능 **전면 삭제**, 릴레이 1곳 구독 | S9 |
| §2 한계 표 | 갱신 (맥 단일 장애점, Tailscale 필요) | S11 |
| §1.1 비목표 | 변경 없음 | — |

---

## 1. 불변식 (절대 위반 금지)

**불변식 #1 — 역할 분리.**
앱 코드(HTML/JS)를 서빙하는 오리진과, 암호문을 중계하는 릴레이는
**서로 다른 신뢰 도메인**에 있어야 한다.
**맥은 릴레이만 담당한다. 맥이 앱 코드를 서빙하게 만드는 어떤 구성도 금지한다.**
(근거: 오리진을 장악한 공격자는 악성 JS를 배포해 신원키를 반출할 수 있고,
프로토콜 설계로 이를 막을 방법은 존재하지 않는다. SECURITY-AUDIT §4.1)

**불변식 #2 — 릴레이는 신뢰하지 않는다.**
릴레이(맥)가 완전히 탈취되어도 평문·키가 노출되지 않아야 한다.
릴레이에는 암호문(kind 1059)과 라우팅용 `p` 태그 외에 어떤 것도 보내지 않는다.
**또한 릴레이는 tailnet에 도달 가능한 임의의 기기가 구독(REQ)만으로 암호문·
메타데이터를 열람하도록 허용해서는 안 된다** — 쓰기(발행)는 서명으로
자체 인증되지만 읽기(구독)는 그렇지 않으므로, 별도의 접속 인증이 반드시
필요하다(S8-d).

**불변식 #3 — `js/pfs.js`와 `test/pfs.test.mjs`는 동결.**
수정 금지. 모든 커밋에서 `node test/pfs.test.mjs`가 **44개 전부 통과**해야 한다.
pfs.js에 결함이 있다고 판단되면 **고치지 말고 멈추고 보고**한다.

**불변식 #4 — 자체 암호 구현 금지.**
암호 프리미티브는 WebCrypto와 벤더링된 nostr-tools만 사용한다.

**불변식 #5 — 정직한 한계 표기.**
S10(코드 핀)은 표적 공격을 막지 못한다. 이 한계를 UI 문구와 문서에서
축소하거나 생략하지 않는다.

---

## 2. 최종 아키텍처 (전환 후)

```
[코드 오리진: 맥이 아닌 정적 호스팅]   ← HTML/JS. 1회 설치 후 SW 캐시로 동작
        │
        ▼
[폰 A] ←──── wss (kind 1059 암호문만) ────→ [맥: 릴레이] ←────→ [폰 B]
                                              │
                                              └─ [맥: 헬퍼] → 웹푸시(내용 없음)
```

- 릴레이는 `127.0.0.1`에만 바인드하고, **Tailscale Serve가 wss 종단**을 담당한다.
  외부 포트 개방·포트포워딩·자체 인증서 발급을 하지 않는다.
- 두 폰은 Tailscale에 연결되어 있어야 한다.
- 공개 Nostr 릴레이는 **완전히 제거**한다. 폴백을 두지 않는다.

---

## 3. 작업 순서

**반드시 S0 → S11 순서대로 진행한다. 단계를 건너뛰거나 합치지 않는다.**
각 단계는 별도 커밋(`S0: …` 형식)이며, 커밋 전에 그 단계의 **완료 기준을
전부 충족**해야 한다.

순서 이유: 릴레이를 바꾸면(S8) 공개 릴레이 폴백이 사라져 장애 시 디버깅이
어려워진다. 따라서 **수신 경로를 먼저 견고하게 만든 뒤**(S1~S7) 인프라를
교체한다.

---

### S0. 준비

**작업**
1. `PLAN.md`, 이 문서, `SECURITY-AUDIT.md`를 읽는다.
2. 브랜치가 `claude/telegram-encrypted-messaging-plan-bzpw6e`인지 확인한다.
3. `node test/pfs.test.mjs` 실행 → 44 passed 확인.

**완료 기준**: 테스트 44개 통과. 코드 변경 없음. (커밋 없음)

---

### S1. 수신 페이로드 엄격 검증 — F-06

**대상**: `js/main.js`

**작업**
1. 파일 상단에 검증 헬퍼 두 개를 추가한다.

```js
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
```

2. 표시용 정제 함수를 추가한다(F-10 대응).

```js
// 양방향 제어·제로폭 문자를 U+FFFD로 치환한다. textContent를 쓰므로 XSS는
// 아니지만, 연락처를 시각적으로 사칭하는 것을 막는다.
// 대상: U+200B-200F(제로폭·LRM/RLM), U+202A-202E(LRE/RLE/PDF/LRO/RLO),
// U+2066-2069(LRI/RLI/FSI/PDI), U+FEFF(BOM/제로폭 논브레이킹 스페이스).
// 반드시 \uXXXX 이스케이프로만 작성한다 — 리터럴 비가시 문자를 소스에 직접
// 넣으면 코드리뷰로 검증할 수 없고 붙여넣기 과정에서 손상되기 쉽다.
function sanitizeForDisplay(s) {
  return s.replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "\uFFFD");
}
```

3. `handleIncomingWrap`의 페이로드 처리부에서, 분기 **직전에** 아래 검증을
   수행한다. 하나라도 실패하면 **조용히 폐기**(`console.warn` 1줄 + return).

| `kind` | 검증 항목 |
|---|---|
| `"text"` | `isUuidV4(payload.id)` / `typeof payload.body === "string"` / `[...payload.body].length` 가 1 이상 2000 이하 / `clampTs(payload.ts) !== null` |
| `"ack"` | `isUuidV4(payload.ref)` / `clampTs(payload.ts) !== null` |

4. 저장 시 `ts`는 **`clampTs()`의 반환값**을 사용한다(원본 `payload.ts`를 쓰지 않는다).
5. 저장 시 `body`는 **`sanitizeForDisplay()`를 통과한 값**을 사용한다.

**완료 기준**
- 2001자 본문, 비-UUID `id`, `ts: 9e15`, `body: 12345`(숫자) 각각이 폐기되고
  콘솔 경고 1줄만 남는 것을 두 프로필 간 수동 테스트로 확인.
- 정상 메시지 왕복은 그대로 동작.
- `node test/pfs.test.mjs` 44개 통과.

---

### S2. 대화 간 격리 — F-05

**대상**: `js/store.js`, `js/main.js`

**작업**
1. `store.js`의 `DB_VERSION`을 `3` → `4`로 올린다.
2. `onupgradeneeded` 핸들러가 현재 `(event) =>` 형태로 `event`를 받고 있지 않다면
   `req.onupgradeneeded = (event) => { const db = req.result; const oldVersion = event.oldVersion; ... }`
   형태로 바꿔 **반드시 `event.oldVersion`을 사용할 수 있게** 한다.
3. `messages` 스토어 생성 로직을 **`oldVersion` 기준으로 명확히 분기**한다.
   기존 `if (!db.objectStoreNames.contains("messages")) { … }` 블록을 아래
   두 갈래로 나눈다 — **신규 설치**(스토어가 아예 없는 경우)와 **기존 DB
   업그레이드**(스토어가 이미 `keyPath:"id"`로 존재하는 경우)를 절대 하나의
   분기로 뭉치지 않는다.

```js
if (!db.objectStoreNames.contains("messages")) {
  // 신규 설치(oldVersion === 0)이거나, 이 스토어를 아직 한 번도 만든 적
  // 없는 상태 — 처음부터 새 keyPath로 만든다. 마이그레이션 불필요.
  const store = db.createObjectStore("messages", { keyPath: ["pk", "id"] });
  store.createIndex("byContact", ["pk", "ts"]);
} else if (oldVersion < 4) {
  // 기존 DB(v1~v3)에 keyPath:"id"인 messages가 이미 있음 — 데이터를 보존한
  // 채 keyPath를 ["pk","id"]로 교체한다. versionchange 트랜잭션 안에서
  // 읽기→삭제→재생성→복원을 순서대로 수행한다.
  const getAllReq = req.transaction.objectStore("messages").getAll();
  getAllReq.onsuccess = () => {
    const rows = getAllReq.result;
    db.deleteObjectStore("messages");
    const store = db.createObjectStore("messages", { keyPath: ["pk", "id"] });
    store.createIndex("byContact", ["pk", "ts"]);
    for (const row of rows) {
      if (row && typeof row.pk === "string" && typeof row.id === "string") store.add(row);
    }
  };
}
```

4. `gaps` 스토어(S6-b에서 쓰임)도 이 시점에 함께 만든다 — 완전히 새 스토어이므로
   분기 없이 `if (!db.objectStoreNames.contains("gaps")) { db.createObjectStore("gaps", {keyPath:"pk"}); }`
   로 충분하다.

5. `store.js`의 함수 두 개를 **이름과 시그니처까지** 아래로 교체한다.

```js
export async function hasMessageFrom(pk, id) {
  const row = await tx("messages", "readonly", (s) => reqToPromise(s.get([pk, id])));
  return !!row;
}

// dir 검증까지 수행한다. 상대는 자기 대화의 '내가 보낸' 메시지 상태만 바꿀 수 있다.
export async function updateMessageStatusFrom(pk, id, status, requireDir) {
  return tx("messages", "readwrite", async (s) => {
    const row = await reqToPromise(s.get([pk, id]));
    if (!row) return false;
    if (requireDir && row.dir !== requireDir) return false;
    row.status = status;
    await reqToPromise(s.put(row));
    return true;
  });
}
```

6. 기존 `hasMessage` / `updateMessageStatus`는 **삭제**한다.
7. `main.js` 호출부를 전부 교체한다.
   - 수신 text 중복 검사: `hasMessageFrom(rumor.pubkey, payload.id)`
   - 수신 ack 처리: `updateMessageStatusFrom(rumor.pubkey, payload.ref, "delivered", "out")`
   - 발신 실패/성공 상태 갱신(`resendMessageLocked`): `updateMessageStatusFrom(msg.pk, msg.id, …, "out")`

**완료 기준**
- 세 명(A, B, C)을 만들어 A↔B, A↔C를 각각 연결한 뒤, B가 A↔C 대화의 메시지
  `id`를 `ref`로 담은 ack를 보내도 A의 C 대화 상태가 **바뀌지 않음**을 확인.
- 기존 대화 히스토리가 마이그레이션 후에도 남아 있음을 확인.
- `node test/pfs.test.mjs` 44개 통과.

---

### S3. 수신 경로 재구성 — F-07, F-08, F-09

**대상**: `js/main.js`

**작업**: `handleIncomingWrap`을 아래 **3단계 구조**로 재작성한다.

```
[단계 1 — 락 없음]
  1. hasSeenWrap(rawEvent.id) 이면 return
  2. unwrapIncoming  → 실패: markSeenWrap 후 return (확정적 폐기)
  3. getContact(rumor.pubkey) → 없음: markSeenWrap 후 return (확정적 폐기)

[단계 2 — 상대 pk로 세션 락 획득 (S5에서 도입) 안에서 수행]
  4. decryptPayload → 실패: markSeenWrap 후 return (리플레이 포함, 확정적 폐기)
  5. saveSession
  6. lastSync 갱신
  7. S1의 페이로드 검증 → 실패: markSeenWrap 후 return
  8. kind === "text":
       a. dup = await hasMessageFrom(pk, payload.id)
       b. dup 이 아니면 addMessage(...)          ← 중복이어도 c는 반드시 수행한다
       c. ack 봉투 생성(buildOutgoingWrap) + saveSession   ← 중복이어도 항상 생성
     kind === "ack":
       updateMessageStatusFrom(pk, payload.ref, "delivered", "out")
  9. markSeenWrap(rawEvent.id)                  ← 저장이 끝난 뒤에만 기록
[락 해제]

[단계 3 — 락 없음]
  10. ack 봉투가 있으면 net.publishWrap(ack)  — 실패는 console.warn만
  11. UI 갱신 (안 읽음 배지 / 채팅창 / 연락처 목록)
```

**핵심 규칙 3가지 — 반드시 지킬 것**
- **(F-07)** 중복 text여도 **ack는 항상 생성·발행**한다. 중복 검사는 `addMessage`만
  건너뛰게 하고, `return`으로 빠져나가지 않는다.
- **(F-08)** `markSeenWrap`은 **확정적 폐기 지점**과 **저장 완료 후**에만 호출한다.
  단계 2에서 예외가 밖으로 던져지면 `markSeenWrap`을 하지 **않는다**(다음 재생 때
  다시 처리되도록).
- **(F-09)** `net.publishWrap`은 **락 밖(단계 3)** 에서만 호출한다.
  `sendTextLocked`도 동일하게 바꾼다 — 락 안에서 봉투 생성 + `saveSession` +
  `addMessage`(상태 `"pending"`)까지 하고, 락을 나온 뒤 발행하고
  `updateMessageStatusFrom(pk, id, ok ? "sent" : "failed", "out")`으로 갱신한다.

**`"pending"` 상태 추가에 따른 UI 규칙** (`statusGlyph`):

| status | 글자 | 동작 |
|---|---|---|
| `pending` | `⋯` | 탭 불가 |
| `sent` | `✓` | 탭 불가 |
| `delivered` | `✓✓` | 탭 불가 |
| `failed` | `⚠` | 탭 시 재발행 |

**완료 기준**
- B의 ack가 유실된 상황을 재현(수신 후 ack 발행만 실패시킴)한 뒤, A가 재전송하면
  B가 **다시 ack를 보내고** A가 ✓✓에 도달함을 확인.
- 발신 시 `⋯` → `✓` → `✓✓` 순으로 바뀌는 것을 확인.
- 5회 왕복 후 모든 발신 메시지가 `delivered`인 것을 확인.
- `node test/pfs.test.mjs` 44개 통과.

---

### S4. 세션 락 밖 발행 정리 — (S3에 포함, 별도 커밋 없음)

S3의 (F-09) 규칙으로 흡수되었다. **별도 단계 없음.** S3 커밋에 포함한다.

---

### S5. 다중 탭 방어 — F-03

**대상**: `js/main.js`

**작업**
1. 기존 `enqueueSessionOp`(전역 프로미스 체인 하나)을 **상대 pk별 Web Lock**으로
   교체한다.

```js
// 세션 read-modify-write는 문서(탭) 단위 큐로는 부족하다. 같은 앱이 두 컨텍스트
// (설치된 PWA + 브라우저 탭 등)에서 열리면 각자 독립된 큐를 갖기 때문에 래칫
// 상태를 서로 덮어쓴다. Web Locks는 오리진 전체에서 상호배제를 보장한다.
const legacyQueues = new Map(); // navigator.locks 미지원 시 폴백(상대별 체인)

function withSessionLock(pk, taskFn) {
  if (navigator.locks && navigator.locks.request) {
    return navigator.locks.request("mildam-session-" + pk, taskFn);
  }
  const prev = legacyQueues.get(pk) || Promise.resolve();
  const result = prev.then(taskFn, taskFn);
  legacyQueues.set(pk, result.then(() => {}, () => {}));
  return result;
}
```

2. 호출부를 전부 교체한다.
   - `sendText(contact, body)` → `withSessionLock(contact.pk, () => sendTextLocked(...))`
   - `resendMessage(msg)` → `withSessionLock(msg.pk, () => resendMessageLocked(msg))`
   - `handleIncomingWrap`의 **단계 2만** → `withSessionLock(rumor.pubkey, ...)`
     (단계 1·3은 락 밖)
3. 구독 콜백은 더 이상 큐에 넣지 않는다. `handleIncomingWrap(rawEvent).catch(...)`
   를 바로 호출한다(내부에서 필요한 구간만 락을 잡는다).

**완료 기준**
- 같은 프로필로 **두 개의 탭**을 열고 양쪽에서 동시에 메시지를 연속 전송해도,
  상대가 **모든 메시지를 복호**하고 래칫이 깨지지 않음을 확인.
- 서로 다른 연락처와의 대화가 **병렬로** 진행되는 것을 확인(전역 직렬화 해제).
- `node test/pfs.test.mjs` 44개 통과.

---

### S6. 세션 복구 + 검열 탐지 — F-04, F-14

**대상**: `js/store.js`, `js/main.js`, `index.html`, `css/style.css`

#### S6-a. 세션 초기화 (F-04)

1. `store.js`에 추가: `export async function deleteSession(pk)` — `sessions`에서
   해당 레코드 삭제.
2. `index.html`의 `#view-safety`에 버튼 추가:
   `<button id="safety-reset" class="btn btn-danger">이 대화 세션 초기화</button>`
   와 안내 문단:
   `이 대화의 암호 세션을 새로 시작합니다. 초기화 이후에는 상대가 이전에 보낸 메시지를 더 이상 복호할 수 없습니다. 대화가 복구 불가능하게 멈췄을 때만 사용하세요.`
3. 확인 절차는 **2단계 탭**으로 구현한다. `confirm()`·`alert()` 사용 금지.
   - 1차 탭 → 버튼 문구를 **S48**로 바꾸고 5초 타이머 시작
   - 5초 내 재탭 → 실행. 5초 경과 → 원래 문구로 복원
   - **(P-5)** 확인 대기 중(1차 탭 후 5초 이내)에 `#safety-back`을 눌러 화면을
     벗어나거나, `showView()`로 다른 화면으로 전환되면, **타이머를 즉시
     취소하고 버튼 문구를 원래대로 되돌린다.** 방치된 확인 상태가 남아있다가
     나중에 안전코드 화면에 다시 들어와 버튼을 누르는 순간(원래 의도는
     "확인"이 아닌 최초 클릭이었는데) 곧바로 초기화가 실행되는 것을 막기
     위함이다. 구현은 `safety-back`의 클릭 핸들러와 `openSafetyView()`
     양쪽에서 이 취소 로직을 호출한다(안전코드 화면에 다시 들어올 때도
     이전 확인 상태가 남아있으면 안 된다).
4. 실행 시: `deleteSession(pk)` + 해당 `gaps` 레코드 삭제 → 토스트 **S45**.
5. `css/style.css`에 `.btn-danger { background: var(--danger); border-color: var(--danger); color:#fff; }` 추가.

#### S6-b. 수신 갭 탐지 (F-14)

1. `store.js`에 `gaps` 오브젝트 스토어를 추가한다(DB 버전 4에서 함께 생성,
   `keyPath: "pk"`). 레코드 형태:
   ```
   { pk, prevChainDh: <string|null>, chains: { <dhB64u>: { maxN: <int>, missing: [<int>...] } } }
   ```
2. `main.js`에서 **복호 성공 직후**(S3 단계 2) 아래 규칙을 그대로 적용한다.
   `h = content.h`(래칫 헤더)를 사용한다.

**(P-4로 재정렬됨 — 반드시 이 순서대로 구현할 것)** "새 체인인가"의 판정은
`chains[h.dh]`를 만들기 **전에** 먼저 내려야 한다. 원래 초안은 판정보다 생성이
먼저 와서 판정이 항상 거짓이 되는 순서 버그가 있었다.

```
1) isNewChain = (h.dh 가 chains 에 아직 없음)
2) if isNewChain and prevChainDh !== null and chains[prevChainDh] 존재:
     prev = chains[prevChainDh]
     for n = prev.maxN + 1 .. h.pn - 1: prev.missing 에 n 추가(중복 제외)
     prev.maxN = max(prev.maxN, h.pn - 1)   // 이 구간은 "확인됨"으로 표시
3) if isNewChain: chains[h.dh] = { maxN: -1, missing: [] }
4) c = chains[h.dh]
5) prevChainDh = h.dh
6) if h.n > c.maxN + 1:
     for n = c.maxN + 1 .. h.n - 1: c.missing 에 n 추가(중복 제외)
7) c.missing 에서 h.n 제거(있으면)
8) c.maxN = max(c.maxN, h.n)
9) Object.keys(chains).length 가 8개를 넘으면 Object.keys(chains)[0](가장
   먼저 추가된 것 — 문자열 키의 순회 순서는 삽입 순서를 그대로 보존하므로
   별도의 순서 추적 자료구조가 필요 없다)을 삭제한다
10) 저장
```
3. 총 누락 수 = 모든 체인의 `missing` 길이 합. **0보다 크면** 채팅방 상단에
   경고 줄(`#chat-gap`)을 표시하고 문구는 **S46**의 `{N}`을 총 누락 수로 치환한다.
   0이면 숨긴다.
4. `index.html`의 `#view-chat` 헤더 바로 아래에
   `<p id="chat-gap" class="gap-warning" hidden></p>` 추가.
   `css/style.css`에 `.gap-warning { background: var(--danger); color:#fff; margin:0; padding:8px 12px; font-size:13px; }` 추가.

**한계 명시**: 이 방식은 상대가 *실제로 보낸* 메시지 중 누락된 것만 탐지한다.
상대의 **마지막** 메시지가 통째로 삭제되고 후속 메시지가 없으면 탐지되지 않는다.
이 문장을 `README.md` 한계 표에 넣는다.

**완료 기준**
- 릴레이가 특정 메시지 1건을 의도적으로 전달하지 않도록 한 상태에서, 다음
  메시지 수신 시 경고 줄에 "받지 못한 메시지 1건"이 뜨는 것을 확인.
- 누락된 메시지가 뒤늦게 도착하면 경고가 사라지는 것을 확인.
- 세션 초기화 버튼이 2단계 탭으로만 동작하고, 초기화 후 새 메시지가 정상
  왕복하는 것을 확인.
- `node test/pfs.test.mjs` 44개 통과.

---

### S7. CSP · 프레임 차단 — F-01(부분), F-13

**대상**: `index.html`, `js/main.js`

1. `index.html`의 `<head>` 최상단(다른 어떤 태그보다 먼저)에 CSP 메타를 넣는다.
   `RELAY_WSS_ORIGIN`은 S8에서 `tools/set-relay.mjs`가 치환할 자리표시자다.

```html
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; manifest-src 'self'; worker-src 'self'; connect-src 'self' RELAY_WSS_ORIGIN; base-uri 'none'; form-action 'none'; object-src 'none'">
```

2. `js/main.js`의 `boot()` **맨 처음**에 프레임 차단을 넣는다
   (meta CSP는 `frame-ancestors`를 지원하지 않으므로 JS로 처리한다).

```js
if (window.top !== window.self) {
  document.body.textContent = "밀담은 다른 사이트 안에서 실행할 수 없습니다.";
  return;
}
```

**완료 기준**
- 앱 전체 기능(온보딩·친구추가·송수신·설정)이 CSP 적용 후에도 콘솔 CSP 위반
  0건으로 동작.
- 개발자도구에서 임의의 외부 오리진으로의 `fetch`가 CSP에 의해 차단되는 것을 확인.
- `node test/pfs.test.mjs` 44개 통과.

---

### S8. 맥 릴레이 구축 + 앱 전환

**대상**: 신규 `relay/`, 신규 `js/config.js`, 신규 `tools/set-relay.mjs`, `js/net.js`,
`js/crypto.js`, `js/main.js`, `helper/helper.mjs`

#### S8-a. 릴레이 구현

`relay/relay.mjs` (Node 20, 의존성은 **`ws@^8`과 `nostr-tools@^2` 정확히 둘**).
`relay/package.json`, `relay/config.example.json`을 함께 만든다.

`relay/config.json` 스키마 (없으면 안내 출력 후 `exit 1`):
```json
{
  "port": 18787,
  "bindHost": "127.0.0.1",
  "allowedPubkeys": ["<폰A pk>", "<폰B pk>", "<헬퍼 pk>"],
  "retentionDays": 7,
  "maxEventBytes": 131072
}
```

**EVENT 수용 규칙** — 아래를 **모두** 만족해야 저장한다. 하나라도 어기면
`["OK", id, false, "blocked"]`를 보내고 저장하지 않는다.
1. `verifyEvent(event) === true` (nostr-tools)
2. `event.kind === 1059`
3. `JSON.stringify(event).length <= maxEventBytes`
4. **(P-6)** `event.created_at`이 다음 창 안에 있을 것:
   `now - (retentionDays + 3) * 86400 <= event.created_at <= now + 600` (초 단위).
   과거 쪽은 `retentionDays`에 NIP-59 gift wrap 시각 무작위화 여유(최대 2일,
   PLAN.md §7.2) + 1일의 여유를 더한 것 — 보관 기간이 지나 어차피 버려질
   이벤트를 굳이 새로 받아 저장하지 않기 위함이다. 미래 쪽은 기기 시계
   오차만 흡수하면 되므로 10분이면 충분하다(서명이 이미 진위를 보장하므로
   느슨한 창이 필요한 게 아니라, 저장 낭비를 막는 용도일 뿐이다).
5. `event.tags`의 `p` 태그 값 중 하나가 `allowedPubkeys`에 포함

**REQ 규칙**
- 필터 개수 최대 5개. 초과 시 `CLOSED` 응답.
- `#p`가 없는 필터는 **아무 이벤트도 반환하지 않고** `EOSE`만 보낸다(전체 덤프 방지).
- `kinds`가 명시되면 `[1059]`만 허용한다.

**레이트 리밋**: 한 연결에서 초당 EVENT 20건을 초과하면 `NOTICE` 후 연결 종료.

**저장**: `relay/state/events.jsonl`에 append + 메모리 인덱스.
시작 시 로드하며 `retentionDays`가 지난 항목은 제외한다. 1시간마다 정리 후
파일을 재작성한다. `state/` 디렉터리 권한은 `0700`.

**로그 정책 (불변식 #2)**: pk와 이벤트 id는 **앞 8자만** 출력한다.
`event.content`는 **어떤 경우에도 로그에 남기지 않는다**.

#### S8-b. 앱 릴레이 설정 분리

1. `js/config.js` 신규:
   ```js
   // 이 값은 tools/set-relay.mjs 가 index.html의 CSP와 함께 갱신한다. 직접 고치지 말 것.
   export const RELAYS = ["wss://example-host.ts.net/relay"];
   ```
2. `js/net.js`에서 하드코딩된 `RELAYS` 상수를 **삭제**하고
   `import { RELAYS } from "./config.js";`로 바꾼다.
   `net.js`는 계속 `RELAYS`를 re-export 한다(기존 import 경로 유지).
3. `sw.js`의 `PRECACHE`에 `"js/config.js"`를 추가한다.
4. `tools/set-relay.mjs` 신규: 인자로 wss URL 하나를 받아
   **`js/config.js`의 `RELAYS`와 `index.html` CSP의 `connect-src`를 동시에** 갱신한다.
   두 곳이 어긋나면 앱이 조용히 오프라인이 되므로 반드시 한 스크립트가 둘 다 고친다.

#### S8-c. Tailscale 종단

`relay/README.md`에 아래를 기록한다(명령의 정확한 형태는 `tailscale serve --help`
실물을 따르되, **결과**는 아래를 만족해야 한다).
- 맥·폰 A·폰 B가 같은 tailnet에 있을 것
- `tailscale serve`로 `https://<맥>.ts.net/relay` → `http://127.0.0.1:18787` 프록시
- 브라우저에서 `wss://<맥>.ts.net/relay` 접속이 **유효한 인증서로** 성립할 것
  (자체서명 인증서는 브라우저가 거부하므로 사용 금지)
- 릴레이 포트를 공유기에서 포트포워딩하지 **않을** 것

#### S8-d. 릴레이 구독 인증 (NIP-42) — P-1, 이 문서에서 가장 중요한 보완

**왜 필요한가.** S8-a의 EVENT 수용 규칙은 **쓰기**를 서명으로 막지만, REQ(구독)는
누구든 보낼 수 있다. 이 상태로는 tailnet에 도달 가능한 **아무 기기나**
`{"kinds":[1059],"#p":["<폰A pk>"]}`로 구독해 두 사람의 전체 암호문·타이밍·
발신량을 조용히 열람할 수 있다. Tailscale이 네트워크 도달을 막아준다는 것과,
도달 가능한 기기가 이 릴레이 안에서 무엇을 볼 수 있는지는 별개의 문제다.
이 구멍을 막지 않으면 SECURITY-AUDIT.md §4.1이 내세운 "공개 릴레이보다 메타데이터가
안전해진다"는 주장이 성립하지 않는다. **쓰기는 인증이 필요 없다** — 서명 검증이
이미 완전히 막고 있으므로 추가 인증은 불필요한 복잡성이다(규칙 C).

**relay/relay.mjs에 추가**
1. WebSocket 연결이 열리면 즉시 무작위 16바이트 hex 챌린지를 만들어
   `["AUTH", challenge]`를 보내고, 연결별 상태에 `{authed:false, challenge, authedPubkey:null}`을 둔다.
2. `authed !== true`인 연결에서 REQ가 오면, **필터를 처리하지 않고**
   `["CLOSED", subId, "auth-required: 구독하려면 먼저 인증하세요"]`만 보낸다.
   (이 정확한 접두사 `"auth-required: "`가 중요하다 — nostr-tools `SimplePool`이
   클라이언트 쪽에서 이 접두사를 보고 자동으로 인증 후 재구독을 시도한다.)
3. `["AUTH", event]` 메시지를 받으면 아래를 **전부** 검증하고, 하나라도
   실패하면 무시한다(연결은 유지, `authed`는 그대로 `false`).
   - `verifyEvent(event) === true`
   - `event.kind === 22242`
   - `event.created_at`이 현재 시각 ±600초 이내(오래된 AUTH 이벤트 재생 방지)
   - `event.tags`에 `["challenge", <이 연결의 challenge와 정확히 일치>]` 존재
   - `event.tags`에 `["relay", <비어있지 않은 문자열>]` 존재(정확한 URL 일치는
     정규화 편차가 있을 수 있어 요구하지 않는다 — 존재 여부만 확인)
   - `event.pubkey`가 `allowedPubkeys`에 포함
   전부 통과하면 `authed = true`, `authedPubkey = event.pubkey`로 저장한다.
4. EVENT(발행) 처리는 **바꾸지 않는다** — 인증 여부와 무관하게 S8-a의 규칙만 적용한다.

**js/net.js에 추가**
1. 모듈 스코프에 `let authSigner = null;`과
   `export function setAuthSigner(fn) { authSigner = fn; }`을 추가한다.
2. `openSubscription()`이 `p.subscribe(RELAYS, filter, {...})`를 호출할 때
   `onauth: authSigner`를 params에 포함한다(구독에만 필요 — `publishWrap`의
   `p.publish(...)` 호출에는 추가하지 않는다. 발행은 인증이 필요 없다).

**js/crypto.js에 추가**
1. 기존 `import {...} from "../vendor/nostr-tools.js";`에 `finalizeEvent`를
   추가한다(이미 벤더 번들에 존재 — `vendor/VERSION.txt` 참고. 벤더 번들
   재생성 불필요).
2. `export function buildAuthSigner(identity)`를 추가한다. **정확한 함수
   시그니처는 실제 벤더 번들(`vendor/nostr-tools.js`가 감싸고 있는
   `AbstractRelay.auth()`/`onauth` 콜백 계약)을 직접 확인한 뒤 맞춘다**
   (규칙 B) — `finalizeEvent`로 kind 22242 이벤트를 만들어 서명해 돌려주는
   함수를 만든다는 **의도**만 고정하고, 콜백이 정확히 무엇을 인자로 받고
   무엇을 반환해야 하는지는 다음 방법으로 검증한다:
   - 스크래치 디렉터리에 `npm install nostr-tools@2.25.0`으로 실물을 내려받아
     `node_modules/nostr-tools/lib/esm/abstract-relay.js`의 `auth()` 메서드와
     `pool.js`/`abstract-pool.js`의 `onauth` 사용처를 읽는다(M0에서 벤더링할
     때 썼던 것과 동일한 방법).
   - 확인한 실제 계약에 맞춰 구현하고, 애초 가정(단순히
     `(authEvent) => finalizeEvent(authEvent, identity.sk)` 형태일 것이라는
     추정)과 달랐다면 그 차이를 커밋 메시지에 기록한다(`vendor/VERSION.txt`가
     이미 이런 식으로 편차를 기록해 둔 선례가 있다).

**js/main.js에 추가**
1. `startMessaging()`에서 `net.startReceiving(...)`을 호출하기 **전에**
   `net.setAuthSigner(buildAuthSigner(identity));`을 호출한다.
2. `crypto.js`에서 `buildAuthSigner`를 import한다.

**helper/helper.mjs에 추가**
헬퍼도 릴레이를 구독하므로(S9) 같은 인증을 통과해야 한다. 헬퍼는 실물
`nostr-tools`(`nostr-tools/pool`)를 쓰므로, `pool.subscribe(...)` 호출에
`onauth: (authEvent) => finalizeEvent(authEvent, identity.sk)` 형태로
(정확한 시그니처는 위와 동일하게 실물 라이브러리로 검증) 서명자를 전달한다.
`identity.sk`는 헬퍼가 이미 §16.2에서 자체 생성해 갖고 있는 것을 그대로
쓴다. 헬퍼의 pk도 `relay/config.json`의 `allowedPubkeys`에 포함되어야 한다
(S8-a의 스키마 예시에 이미 `<헬퍼 pk>`로 반영되어 있다).

**완료 기준**
- 로컬에서 릴레이를 띄우고 두 프로필이 **공개 릴레이 없이** 이 릴레이만으로
  양방향 송수신에 성공.
- allowlist에 없는 pk 앞으로 보낸 EVENT가 `blocked`로 거부됨을 확인.
- kind 1059가 아닌 이벤트가 거부됨을 확인.
- `#p` 없는 REQ가 아무 이벤트도 반환하지 않음을 확인.
- **(P-1)** 인증 없이 REQ를 보내면 `CLOSED`(`auth-required:` 접두사)로 거부되고,
  유효하게 서명된 AUTH 이벤트로 인증한 뒤에는 같은 구독이 정상적으로 동작함을
  두 프로필 모두에서 확인.
- **(P-1)** `allowedPubkeys`에 없는 키로 AUTH를 시도하면 `authed`가 계속
  `false`로 남아 REQ가 계속 거부됨을 확인.
- **(P-1)** 헬퍼(`node helper/helper.mjs`)가 인증을 통과해 정상적으로 구독하고,
  §16의 감지 로그가 그대로 나오는 것을 확인.
- `node test/pfs.test.mjs` 44개 통과.

---

### S9. 헬퍼 축소 — F-02, F-16

**대상**: `helper/helper.mjs`, `helper/README.md`, `sw.js`

1. **아카이브 기능을 전면 삭제**한다. 다음 식별자와 관련 코드를 모두 제거:
   `ARCHIVE_PATH`, `ARCHIVE_MAX_AGE_MS`, `REPUBLISH_INTERVAL_MS`,
   `loadArchive`, `rewriteArchive`, `appendArchive`, `pruneAndRepublish`,
   그리고 이를 호출하는 `setTimeout`/`setInterval`.
   (근거: 릴레이가 이제 같은 보관 역할을 하므로 완전한 중복이며, 탈취된 맥에
   메타데이터를 집적시키는 유일한 요소였다.)
2. 중복 푸시 방지는 **인메모리 `Set`**으로만 한다(재시작 시 비어도 무해).
3. 릴레이 목록을 `helper/config.json`의 `relayUrl` **단일 값**으로 읽는다.
   `helper/config.example.json`을 함께 만든다.
4. **F-16**: `pushsub` 등록 처리에 단조 검사를 추가한다.
   저장된 레코드의 `ts`보다 **크지 않은** `ts`의 등록 DM은 무시한다.
   `subs.json` 레코드를 `{ sub, ts }` 형태로 바꾼다.
5. `sw.js`의 `push` 핸들러에 `tag: "mildam-new"`와 `renotify: false`를 추가한다
   (탈취된 맥이 푸시를 남발해도 알림 1건으로 병합된다).
6. `helper/README.md`에 운영 하드닝 절을 추가한다:
   - 도우미 전용 macOS 사용자 계정에서 실행할 것
   - **전체 디스크 접근 권한(Full Disk Access) 부여 금지**
   - FileVault 활성화
   - 방화벽에서 인바운드 전면 차단(모든 연결은 아웃바운드/Tailscale)
   - 이 기기로 웹서핑 등 다른 용도 병행 금지
   - `state/` 권한 `0700`

**완료 기준**
- `helper/state/archive.jsonl`이 더 이상 생성되지 않음을 확인.
- 헬퍼가 맥 릴레이 1곳만 구독하고, 등록 DM 처리와 푸시 발송이 그대로 동작.
- 과거 `ts`의 등록 DM을 재생해도 구독이 되돌아가지 않음을 확인.
- `node test/pfs.test.mjs` 44개 통과.

---

### S10. TOFU 코드 핀 + 빌드 지문 — F-01(완화)

**대상**: 신규 `tools/gen-integrity.mjs`, 신규 `integrity.json`, `sw.js`, `js/main.js`, `js/store.js`, `index.html`

1. `tools/gen-integrity.mjs`: `sw.js`의 `PRECACHE` 목록과 **동일한 파일 집합**의
   SHA-256을 계산해 `integrity.json`을 생성한다(`integrity.json` 자신은 제외).
   ```json
   { "files": { "index.html": "<sha256hex>", "...": "..." },
     "fingerprint": "<정렬된 'path:hash' 줄들의 SHA-256>" }
   ```
2. `sw.js`의 `install`에서 각 파일을 fetch → SHA-256 → `integrity.json`과 비교한다.
   **하나라도 불일치하면 `throw`** 하여 설치를 중단시킨다(기존 SW가 계속 서빙된다).
3. `store.js`에 `meta` 키 `codePin` 읽기/쓰기를 추가한다.
4. `main.js` `boot()`에서:
   - `integrity.json`의 `fingerprint`를 읽는다.
   - `meta.codePin`이 없으면 저장한다(TOFU).
   - 다르면 **전체 화면 경고**를 띄운다: 문구 **S47**, 이전/새 지문 앞 16자를
     나란히 표시, "계속" 버튼(누르면 새 지문을 저장하고 진행).
5. 설정 화면(`#view-settings`)에 현재 빌드 지문 앞 16자를 monospace로 표시한다.
6. **한계 문구를 UI에 함께 표시한다**(불변식 #5). 설정 화면에 다음 문장을 넣는다:
   `이 지문은 배포본이 조용히 바뀌는 것을 탐지하기 위한 것입니다. 코드를 서빙하는 서버 자체를 장악한 공격자는 이 검사도 함께 조작할 수 있으므로, 완전한 방어가 아닙니다.`

**완료 기준**
- `tools/gen-integrity.mjs` 실행 → `integrity.json` 생성 → 앱 정상 부팅 → 설정
  화면에 지문 표시.
- 파일 하나를 1바이트 고친 뒤 SW 설치가 거부되는 것을 확인.
- 지문을 바꾼 뒤 재부팅하면 경고 화면이 뜨고, "계속"을 누르면 새 지문이 저장되어
  다음 부팅부터는 뜨지 않는 것을 확인.
- `node test/pfs.test.mjs` 44개 통과.

---

### S11. 문서 갱신

**대상**: `README.md`, `PLAN.md`

1. `README.md` 한계 표에 추가:
   - 두 폰 모두 **Tailscale 상시 연결 필요**. 없으면 대화 불가.
   - **맥이 단일 장애점**. 절전·재부팅·네트워크 단절 시 양쪽 모두 메시징 중단
     (공개 릴레이 폴백을 제거한 대가).
   - 갭 탐지는 상대의 **마지막** 메시지가 통째로 삭제된 경우는 탐지하지 못함.
   - 코드 지문 검사는 **표적 공격을 막지 못함**.
2. `README.md` 배포 절에 **불변식 #1**을 명시한다:
   `앱 코드는 맥이 아닌 정적 호스팅에 둔다. 맥은 릴레이와 알림만 담당한다.`
   GitHub Pages 대안으로 Codeberg Pages / Cloudflare Pages / GitLab Pages /
   Netlify를 나열하고, **어느 쪽이든 코드 변경이 필요 없음**(`start_url`이 상대경로)을 적는다.
3. `PLAN.md` 상단에 `이 문서는 docs/PLAN-V4-ZEROTRUST.md 에 의해 개정되었다.
   충돌 시 그 문서가 우선한다.` 한 줄을 추가한다. **그 외 PLAN.md 본문은 고치지 않는다.**

**완료 기준**: 위 항목이 모두 문서에 존재. `node test/pfs.test.mjs` 44개 통과.

---

## 4. 신규 문자열 (PLAN.md §9.7에 추가 — 문구 그대로 사용)

| ID | 문구 |
|---|---|
| S45 | 대화 세션을 초기화했습니다. 다음 메시지부터 새 세션으로 전송됩니다. |
| S46 | 받지 못한 메시지 {N}건이 있습니다. 상대에게 확인해 보세요. |
| S47 | 이 기기의 앱 코드 지문이 바뀌었습니다. 직접 업데이트한 적이 없다면 사용을 멈추고 확인하세요. |
| S48 | 정말 초기화하려면 5초 안에 다시 누르세요 |

---

## 5. 최종 수동 검증 체크리스트 (S11 완료 후 전부 수행)

1. 두 프로필 온보딩 → 상호 친구 추가 → 맥 릴레이만으로 5회 왕복, 전부 `✓✓`
2. B 완전 종료 중 A가 3건 발신 → B 재접속 시 3건 도착 + A가 `✓✓`
3. 같은 프로필 **두 탭** 동시 발신 → 상대가 전부 복호(래칫 무손상)
4. 2001자 / 잘못된 `id` / 미래 `ts` 페이로드 → 조용히 폐기, 정상 대화 무영향
5. B가 A↔C 대화 메시지 `id`로 ack 위조 → A의 C 대화 상태 **불변**
6. ack 유실 후 재전송 → 상대가 **재-ack** → `✓✓` 도달
7. 릴레이가 1건 누락 → 다음 수신 시 갭 경고 표시 → 뒤늦게 도착 시 경고 해제
8. 세션 초기화 2단계 탭 동작 → 확인 대기 중 화면 이탈 시 상태 취소됨 → 초기화는
   두 탭을 연속으로 눌렀을 때만 실행 → 초기화 후 새 세션으로 정상 왕복
9. CSP 적용 상태에서 전 기능 동작, 콘솔 CSP 위반 0건
10. allowlist 외 pk / kind≠1059 / `#p` 없는 REQ가 릴레이에서 거부됨
11. **(P-1)** 인증 없는 REQ는 `CLOSED`(auth-required)로 거부되고, 유효한 서명으로
    인증하면 같은 구독이 정상 동작함. allowlist 외 키로는 인증이 통과하지 않음.
    헬퍼도 인증을 통과해 정상 구독함
12. `helper/state/archive.jsonl` 미생성, 푸시 알림 정상 + `tag` 병합
13. 파일 1바이트 변조 시 SW 설치 거부, 지문 변경 시 경고 화면
14. `node test/pfs.test.mjs` → **44 passed**
15. (실기기) 갤럭시 Chrome·아이폰 Safari에서 Tailscale 켠 상태로 1·2 재수행

---

## 6. 금지사항 (위반 = 실패)

1. **맥이 앱 코드(HTML/JS)를 서빙하게 만드는 모든 구성** — 불변식 #1
2. `js/pfs.js`·`test/pfs.test.mjs` 수정. 44개 통과 상태를 모든 커밋에서 유지
3. 자체 암호 구현. 프리미티브는 WebCrypto와 벤더링된 nostr-tools만
4. kind 1059 이외의 이벤트 발행. `net.js`의 발행 가드 제거·우회
5. 공개 Nostr 릴레이를 코드에 남기거나 폴백으로 추가하는 것
6. `confirm()` / `alert()` / `prompt()` 사용
7. PWA에 프레임워크·번들러·npm·TypeScript 도입
   (npm은 `helper/`, `relay/`, `tools/` 안에서만, 각 문서가 명시한 의존성만)
8. 개인키·프리키·세션 상태·평문을 로그·네트워크·localStorage에 남기는 것
9. `Math.random` 사용
10. 문자열 표(§4)·`PLAN.md` §9.7·§11 문구 임의 수정
11. 지시되지 않은 리팩터링·기능 추가. `PLAN.md` §1.1 비목표는 요청받아도 구현하지 않음
12. TODO·스텁·주석 처리된 미완성 코드로 단계 완료 선언
13. 이 브랜치(`claude/telegram-encrypted-messaging-plan-bzpw6e`) 외 푸시
14. **(P-1)** 인증 없는 REQ를 그대로 서빙하는 릴레이 구성. S8-d의 AUTH 게이트를
    생략하거나, "어차피 Tailscale이 막아준다"는 이유로 우회하지 않는다 —
    네트워크 도달 가능성과 애플리케이션 접근 통제는 별개의 방어선이다

---

## 7. 모호성 해결 규칙

- **규칙 A**: 이 문서와 `PLAN.md`가 모두 침묵하는 결정이 나오면 **임의로 정하지
  말고 작업을 멈추고 사용자에게 질문**한다. `PLAN.md` §14의 기본값 표에 있는
  항목은 질문 없이 그 표를 따른다.
- **규칙 B**: 이 문서와 라이브러리·OS 실물이 충돌하면, **프로토콜·보안 사양은
  이 문서가 이기고**, API 시그니처·CLI 사용법은 실물이 이긴다. 달라진 점은
  커밋 메시지에 기록한다.
- **규칙 C**: "더 좋아 보이는" 개선·리팩터링·의존성 추가 금지.
- **규칙 D**: `js/pfs.js`에서 결함을 발견했다고 판단되면 **고치지 말고 멈추고
  보고**한다.
- **규칙 E**: 어떤 단계에서든 완료 기준을 충족하지 못하면, 다음 단계로 진행하지
  말고 멈추고 보고한다.
