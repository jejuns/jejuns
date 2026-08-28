# 밀담(Mildam) 작업 인수인계 문서

작성 시점: 2026-08-28 / 브랜치 `claude/telegram-encrypted-messaging-plan-bzpw6e`

이 문서는 **지금까지의 전체 작업 맥락**과 **정확한 현재 위치**, 그리고 **다음
작업자가 즉시 이어받기 위해 알아야 할 것**만 담는다. 설계 근거는
`docs/SECURITY-AUDIT.md`, 작업 지시는 `docs/PLAN-V4-ZEROTRUST.md`가 정본이다.

---

## 1. 프로젝트가 무엇인가

**밀담** — 자체 서버 없이 공개 Nostr 릴레이로 암호문만 주고받는 종단간 암호화
메신저 PWA. 갤럭시·아이폰 양쪽에서 쓸 수 있어야 하고, 구현은 HTML/CSS/바닐라
JS로 한정된다.

| 요소 | 채택한 것 |
|---|---|
| 전송 | Nostr NIP-01 릴레이 (비동기 전달 — 상대가 꺼져 있어도 도착) |
| 봉투 | NIP-17/59 gift wrap (kind 1059), NIP-44 v2 |
| 암호 | Signal식 Double Ratchet 자체 모듈 `js/pfs.js` (전방위 비밀성, PFS) |
| 저장 | IndexedDB (`mildam`, 현재 v4) |
| 알림 | 집의 맥에 상주하는 도우미(helper) + Web Push — 도우미는 암호문만 봄 |

### 설계 이력

1. **v1.0** — WebRTC P2P 직결. 상대가 접속 중이어야만 전달 가능 → 폐기.
2. **v2.0** — 공개 Nostr 릴레이 경유 비동기 전달로 전환.
3. **v3.0** (`PLAN.md`) — Double Ratchet PFS + 맥 기반 푸시 도우미 추가. **M0~M7로 구현 완료.**
4. **v4.0** (`docs/PLAN-V4-ZEROTRUST.md`) — 보안 감사 결과를 반영한 Zero Trust
   재설계. **현재 이걸 S0~S11로 구현 중.**

---

## 2. 가장 중요한 아키텍처 결정 (반드시 유지)

사용자의 요구는 "깃헙 페이지를 거치지 않고 **맥을 서버로** 쓰고 싶다, 단
**맥이 해킹당해도 괜찮아야** 한다"였다. 이에 대한 답이 v4의 핵심이다.

> **맥은 릴레이(+푸시 도우미)만 맡는다. 앱 코드(HTML/JS)는 절대 맥이 서빙하지
> 않는다.**

이유는 두 침해의 복구 가능성이 근본적으로 다르기 때문이다.

| 침해 대상 | 공격자가 얻는 것 | 복구 가능성 |
|---|---|---|
| **릴레이**(맥) | 암호문 + 메타데이터(누가 언제 몇 건). 평문·키는 **불가**, 위조도 **불가**(서명 검증) | 제한적 피해. 감내 가능 |
| **코드 오리진** | 악성 JS를 주입해 **개인키·평문 유출**. E2EE가 통째로 무의미해짐 | **복구 불가** |

즉 맥이 완전히 털려도 대화는 안전하지만, 그건 **맥이 코드를 서빙하지 않을
때만** 성립한다. 이것이 불변식 #1이고, 이 문서에서 유일하게 타협 불가한 조항이다.

### 5개 불변식 (`PLAN-V4-ZEROTRUST.md` §1)

1. **역할 분리** — 코드 호스팅과 릴레이는 서로 다른 신뢰 도메인. 맥은 릴레이만.
2. **릴레이 불신** — 릴레이에 평문·키가 남지 않는다. 읽기(REQ)도 인증 필요.
3. **`js/pfs.js`와 `test/pfs.test.mjs`는 동결** — 수정 금지. 문제 발견 시 고치지 말고 **보고**.
4. **자체 암호 구현 금지** — 검증된 라이브러리만.
5. **정직한 한계 표기** — 막지 못하는 것은 README에 명시.

---

## 3. 현재 상태 (핵심)

### 커밋 히스토리

```
966d266 S5: Web Locks per-peer session serialization (F-03)     ← HEAD
0ce3882 S3: three-phase incoming-wrap pipeline (F-07, F-08, F-09)
2a58ccc S2: conversation isolation for message lookups (F-05)
6b58503 S1: strict validation of decrypted payload fields (F-06)
b71f39f docs: self-review of the Zero Trust plan, fix 6 defects
bb8b9d3 docs: security audit and Zero Trust v4 work order
c0f8178 M7: repository README
...     M0~M6 (v3.0 구현)
```

### S0~S11 진행 현황

| 단계 | 내용 | 상태 |
|---|---|---|
| S0 | 준비 | ✅ 완료 |
| S1 | 수신 페이로드 엄격 검증 (F-06) | ✅ 커밋됨 |
| S2 | 대화 간 격리 — `messages` 복합키 `[pk,id]` (F-05) | ✅ 커밋됨 |
| S3 | 수신 경로 3단계 재구성 (F-07/08/09) | ✅ 커밋됨 |
| S4 | (S3에 포함, 별도 커밋 없음) | ✅ — |
| S5 | 다중 탭 방어 — Web Locks (F-03) | ✅ 커밋됨 |
| **S6** | **세션 복구 + 검열 탐지 (F-04, F-14)** | ⚠️ **코드 완료, 1개 완료기준 블로킹 — §4 참조** |
| S7 | CSP · 프레임 차단 (F-01 부분, F-13) | ⬜ 미착수 |
| S8 | 맥 릴레이 구축 + 앱 전환 (S8-d: NIP-42 읽기 인증) | ⬜ 미착수 |
| S9 | 헬퍼 축소 — 암호문 아카이브 제거 (F-02, F-16) | ⬜ 미착수 |
| S10 | TOFU 코드 핀 + 빌드 지문 (F-01 완화) | ⬜ 미착수 |
| S11 | 문서 갱신 (README 한계표, PLAN.md 개정 표기) | ⬜ 미착수 |

### 작업 트리 (커밋 안 됨)

```
 M css/style.css   ← .btn-danger, .gap-warning
 M index.html      ← #safety-reset 버튼, #chat-gap 배너
 M js/main.js      ← S6-a 세션 초기화, S6-b 갭 탐지
 M js/store.js     ← deleteSession, getGaps/saveGaps/deleteGaps, gaps 스토어
```

`node test/pfs.test.mjs` → **44/44 통과** (S1~S6 내내 유지됨).
기존 회귀 스위트(check_m0~m6, check_s1~s5) → **전부 PASS**.

---

## 4. ⚠️ S6 블로커 — 반드시 읽을 것

S6은 코드가 다 작성됐고 21개 검증 중 **20개가 통과**한다. 남은 1개가 막혔는데,
**원인이 S6 코드가 아니라 동결된 `js/pfs.js`의 설계 속성**이라서 계획서 §7
Rule D·E("pfs.js 문제는 고치지 말고 보고", "완료기준 미달이면 멈추고 보고")에
따라 임의로 고치지 않고 여기 보고한다.

### 증상

계획서 S6-a 완료기준 중 *"초기화 후 새 메시지가 정상 왕복하는 것을 확인"* 이
**상대 공개키의 사전순에 따라 결정적으로 절반은 실패**한다.

### 원인 (코드 경로까지 확정)

`js/pfs.js` `managerDecrypt()` 277~287행. 모르는 `sid`의 메시지가 도착했는데
수신자가 이미 `role:"init"`인 세션을 갖고 있으면, **동시 개시 충돌**로 간주하고
신원 공개키가 사전순으로 작은 쪽의 세션을 승자로 채택한다.

```js
mgr.currentSid = mgr.myPk < mgr.peerPk ? mgr.currentSid : sid;
```

문제는 **한쪽만의 세션 초기화가 상대에게는 동시 개시 충돌과 완전히 똑같이
보인다**는 점이다. 상대는 "쟤가 일부러 리셋했다"와 "우연히 동시에 개시했다"를
구분할 방법이 없다.

그래서 초기화한 쪽의 pk가 사전순으로 **크면**, 상대는 **옛 세션을 계속
currentSid로 유지**하고 모든 발신(ack 포함)을 옛 세션으로 보낸다. 그런데 그
세션은 초기화한 쪽이 이미 지웠으므로 복호할 수 없다 →
`pfs: no receiving chain to skip`.

**수신은 정상, 발신만 영구히 깨지는 단방향 파손**이라 더 나쁘다. 상대 화면에는
아무 이상이 없어 보이고, 초기화한 쪽만 답장을 영영 못 받는다.

### 실측 (`probe_reset_collision.mjs`, 6회)

```
trial 0: pkB<pkA=false | bob받음=true | ack왕복=true  | bob역할=resp
trial 1: pkB<pkA=false | bob받음=true | ack왕복=true  | bob역할=resp
trial 2: pkB<pkA=false | bob받음=true | ack왕복=true  | bob역할=resp
trial 3: pkB<pkA=true  | bob받음=true | ack왕복=false | bob역할=init   ← 파손
trial 4: pkB<pkA=false | bob받음=true | ack왕복=true  | bob역할=resp
trial 5: pkB<pkA=true  | bob받음=true | ack왕복=false | bob역할=init   ← 파손
```

예측과 6/6 일치. 플레이키가 아니라 **결정적**이다.

### 선택지 (사용자 결정 필요 — 계획서 §7 Rule A)

| 안 | 내용 | 대가 |
|---|---|---|
| **(A) 권장** | `pfs.js`는 그대로 두고, 초기화 시 새 페이로드 `kind:"reset"`을 함께 보내 상대도 자기 세션을 지우게 한다. 상대의 **수신은 멀쩡하므로** 이 신호는 반드시 도착한다. 이후 상대가 새로 개시하면 수렴한다. | `js/main.js`만 수정. 불변식 #3 유지. 계획서에 없는 페이로드 종류 추가 → 계획 개정 필요 |
| (B) | `pfs.js`의 충돌 해소 로직에 "리셋 세대(epoch)" 개념을 넣어 진짜 리셋과 동시 개시를 구분 | **불변식 #3 위반.** 와이어 포맷 변경 + 44개 테스트 전면 재검증 |
| (C) | 고치지 않고 "세션 초기화는 **양쪽이 함께** 눌러야 한다"로 UI 문구·README 한계표에 명시 | 코드 위험 0. 사용자가 규칙을 지켜야만 동작 |

내 권고는 **(A)** 이고, 그게 과하면 **(C)** 로도 불변식은 지켜진다. 다만 어느
쪽이든 **계획서 개정이므로 사용자 승인 없이 진행하지 않았다.**

---

## 5. S6에서 실제로 구현된 것

### S6-a 세션 초기화 (F-04 — 래칫이 영구히 어긋났을 때의 탈출구)

- `js/store.js`: `deleteSession(pk)`
- `index.html`: `#view-safety`에 경고 문단 + `#safety-reset` 버튼
- `js/main.js`: `handleSafetyReset()` — **2단계 탭** 확인 (`confirm()` 금지),
  1차 탭 시 문구가 "정말 초기화하려면 5초 안에 다시 누르세요"로 바뀌고 5초 타이머 시작
- **P-5 대응**: 확인 대기 중 화면을 벗어나면 `cancelSafetyResetConfirm()`으로
  즉시 취소. `#safety-back` 핸들러와 `openSafetyView()` **양쪽**에서 호출한다
  (방치된 확인 상태가 남아 나중에 첫 클릭이 곧바로 초기화를 실행하는 것을 막음)

검증됨: 1차 탭만으로는 실행 안 됨 / 이탈 후 재진입 시 확인 상태 소멸 /
2연타 시 세션·갭 레코드 삭제 + 토스트 / 초기화 후 새 세션으로 발신 성공.

### S6-b 수신 갭 탐지 (F-14 — 릴레이의 조용한 메시지 누락 탐지)

래칫 헤더 `h = {sid, dh, pn, n}`는 **AEAD의 AAD에 묶여 있어 위조가 불가능**하다.
따라서 복호에 성공했다는 사실 자체가 헤더 값을 신뢰할 근거다. 이걸로 상대가
보낸 메시지 번호의 빠진 구간을 추적한다.

- `js/store.js`: `gaps` 스토어(`keyPath:"pk"`) + `getGaps`/`saveGaps`/`deleteGaps`
  - 레코드: `{ pk, prevChainDh, chains: { <dh>: { maxN, missing: [] } } }`
- `js/main.js`: `recordGapObservation(pk, h)` — 계획서 P-4 재정렬 반영
  (`isNewChain` 판정을 `chains[h.dh]` 생성보다 **먼저**), 체인 8개 초과 시 가장 오래된 것 삭제
- `js/main.js`: `updateGapWarning(pk)` — 누락 합계 > 0이면 `#chat-gap` 배너 표시

**단계 3 처리에 주의점 하나**: `handleIncomingWrapLocked`는 복호 성공 이후에
폐기되더라도 `{ kind:null, gapUpdated:true }`를 반환한다. 갭 관측은 이미
반영됐으므로 배너는 갱신돼야 하기 때문이다. `null` 반환은 **복호 자체가
실패한 경우로만** 한정된다.

검증됨: 릴레이가 1건을 삼키면 "받지 못한 메시지 1건" 배너 표시 → 뒤늦게
도착하면 배너 사라지고 누락 수 0으로 정정.

**한계(README에 넣을 것)**: 상대의 **마지막** 메시지가 통째로 삭제되고 후속
메시지가 없으면 탐지되지 않는다.

---

## 6. 파일 목록

### 저장소 (git 관리)

| 파일 | 설명 |
|---|---|
| `PLAN.md` | v3.0 원본 명세. **S11에서 "v4에 의해 개정됨" 한 줄 추가 필요** |
| `docs/SECURITY-AUDIT.md` | 보안 감사 — F-01~F-16 취약점 16건 (읽기 전용 분석) |
| `docs/PLAN-V4-ZEROTRUST.md` | **작업 지시 정본.** S0~S11, 불변식, 금지사항 14개, 모호성 규칙 A~E |
| `docs/HANDOFF.md` | 이 문서 |
| `index.html` `css/style.css` | UI |
| `js/main.js` | 오케스트레이션 (화면·이벤트·송수신 파이프라인) |
| `js/crypto.js` | NIP-17/44/59 봉투 + pfs 연결 |
| `js/pfs.js` | **동결.** Double Ratchet |
| `js/store.js` | IndexedDB (현재 v4) |
| `js/net.js` | 릴레이 전송 |
| `js/util.js` `sw.js` `manifest.webmanifest` | 유틸 / 서비스워커 / PWA |
| `test/pfs.test.mjs` | **동결.** 44개 테스트 |
| `helper/helper.mjs` | 푸시 도우미 (**S9에서 아카이브 기능 제거 예정**) |
| `vendor/nostr-tools.js` | 벤더 번들 |

### 테스트 하네스 (스크래치패드 — **git에 없음, 컨테이너 소멸 시 유실**)

이 파일들은 저장소에 커밋하지 않기로 했으므로 별도로 보관해야 한다.

| 파일 | 설명 |
|---|---|
| `fake_relay.mjs` | **핵심.** Playwright `routeWebSocket` 기반 인메모리 NIP-01 릴레이 시뮬레이터. 샌드박스에 실제 릴레이 접속 경로가 없어 필수. 옵션: `dropHosts`(연결 차단), `blackholeHosts`(연결은 되나 OK 미응답 → 진짜 publish 타임아웃 재현), `swallowPredicate`+`releaseSwallowed()`(조용한 누락 후 지연 도착 재현), `disconnectAll()`, `onOutgoing` |
| `check_m0~m6.mjs` | M단계 회귀 테스트 |
| `check_s1/s2/s3/s5.mjs` | S단계 회귀 테스트 |
| `check_s6.mjs` | S6 검증 (21개 중 20개 통과, 마지막 1개가 §4 블로커) |
| `probe_reset_collision.mjs` | §4 블로커의 근거를 만든 관측 스크립트 |
| `local_relay_server.mjs` `run_helper_patched.mjs` | 도우미 실검증용 |

---

## 7. 테스트 실행 방법

```bash
# 1. pfs 단위 테스트 (44개, 항상 전부 통과해야 함)
node test/pfs.test.mjs

# 2. 정적 서버 (Playwright 테스트의 전제)
python3 -m http.server 8123     # 저장소 루트에서

# 3. 브라우저 회귀 테스트
cd <스크래치패드>
node check_s6.mjs               # 개별
for f in check_m0 check_m1 check_m2 check_m3 check_m4 check_m6 \
         check_s1 check_s2 check_s3 check_s5; do
  echo "=== $f ==="; node "$f.mjs" 2>&1 | tail -5
done
```

Chromium은 `/opt/pw-browsers/chromium`에 사전 설치돼 있다
(`chromium.launch({ executablePath: "/opt/pw-browsers/chromium" })`).

### 테스트 작성 시 걸렸던 함정 (재발 방지)

- **라우팅은 페이지 생성 전에.** `attachFakeRelays(ctx)`를 `ctx.newPage()` 뒤에
  걸면 `boot()`이 이미 실제 인터넷으로 연결을 시도해 전부 실패한다.
- **한 메시지는 4개 호스트에 발행된다.** 한 호스트에서만 삼켜봐야 나머지
  3개로 그대로 도착한다. 이벤트 `id`로 전 호스트를 함께 삼켜야 한다.
- **`dropHosts`는 새 연결만 막는다.** 이미 열린 연결을 끊으려면 `disconnectAll()`.
- **클릭 핸들러는 async를 기다려주지 않는다.** `page.click()` 반환이
  `openChat()` 내부 `await`의 완료를 뜻하지 않으므로 상태를 폴링할 것.
- **IndexedDB 마이그레이션 테스트**는 앱이 로드되지 않는 동일 오리진 경로
  (`__no_such_page__`)로 먼저 이동해 시드해야 연결 충돌이 안 난다.

---

## 8. 다음 작업자가 할 일

1. **§4 블로커에 대한 사용자 결정을 받는다** (A/B/C). 그 전까지 S6은 완료가 아니다.
2. 결정 반영 후 S6 커밋. `PLAN-V4-ZEROTRUST.md`도 함께 개정.
3. S7 → S8 → S9 → S10 → S11 순차 진행. **건너뛰기 금지.**
4. 매 단계: `node test/pfs.test.mjs` 44/44 유지, 실제 동작 검증(코드 리뷰만으로
   완료 처리 금지), 단계별 개별 커밋.
5. 전 단계 완료 후 `PLAN-V4-ZEROTRUST.md` §5 수동 검증 체크리스트 수행.

### 지켜야 할 규칙 (계획서 §7)

- **Rule A** — 계획서가 침묵하면 임의 판단하지 말고 **멈추고 묻는다**.
- **Rule B** — 라이브러리 실제 API가 계획서의 가정과 다르면 현실이 이기지만,
  프로토콜·보안 사양은 계획서가 이긴다.
- **Rule C** — 요청되지 않은 개선 금지.
- **Rule D** — `pfs.js`는 고치지 말고 **보고**한다.
- **Rule E** — 완료기준 미달이면 커밋하지 말고 **보고**한다.

### 알려진 함정

- **보이지 않는 유니코드 이스케이프**: `sanitizeForDisplay`의 bidi 문자 제거
  정규식(`[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]`)을 그냥 타이핑하면
  실제 보이지 않는 글자가 파일에 들어가는 사고가 **두 번** 났다. 이 정규식을
  다시 건드려야 하면 Python 스크립트로 바이트 단위 치환하고 `od -c`로 검증할 것.
- **IndexedDB v4 이중 업그레이드 위험**: S6의 `gaps` 스토어는 S2 시점(v4)에
  미리 만들어 뒀다. 같은 버전 번호로 두 번 업그레이드하지 않기 위함이다.
