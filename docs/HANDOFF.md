# 밀담(Mildam) — 작업 완료 보고 및 인수인계

작성 시점: 2026-08-28 / 브랜치 `claude/telegram-encrypted-messaging-plan-bzpw6e`

**`docs/PLAN-V4-ZEROTRUST.md`의 S0~S11이 전부 구현·검증되었다.**
이 문서는 그 결과와, 다음 사람이 알아야 할 것을 담는다. 설계 근거는
`docs/SECURITY-AUDIT.md`, 작업 지시는 `docs/PLAN-V4-ZEROTRUST.md`가 정본이다.

---

## 1. 프로젝트

**밀담** — 자체 서버 없이 암호문만 주고받는 종단간 암호화 메신저 PWA.
갤럭시·아이폰 양쪽에서 쓸 수 있고, 구현은 HTML/CSS/바닐라 JS로 한정된다.

| 요소 | 채택 |
|---|---|
| 전송 | Nostr NIP-01 (비동기 전달 — 상대가 꺼져 있어도 도착) |
| 봉투 | NIP-17/59 gift wrap (kind 1059), NIP-44 v2 |
| 암호 | Signal식 Double Ratchet (`js/pfs.js`, 전방위 비밀성) |
| 저장 | IndexedDB (`mildam` v4) |
| 릴레이 | **맥에서 돌리는 전용 릴레이** + Tailscale (v4에서 전환) |
| 알림 | 맥의 도우미 데몬 + Web Push (암호문만 봄) |

### 설계 이력

1. **v1.0** WebRTC P2P → 상대가 접속 중이어야만 전달 가능, 폐기
2. **v2.0** 공개 Nostr 릴레이 경유 비동기 전달
3. **v3.0** (`PLAN.md`) Double Ratchet PFS + 푸시 도우미 — M0~M7로 구현
4. **v4.0** (`docs/PLAN-V4-ZEROTRUST.md`) 보안 감사 반영 Zero Trust 재설계 —
   **S0~S11로 구현 완료(이번 작업)**

---

## 2. 이 설계의 핵심 — 맥이 털려도 괜찮은 이유

원 요구는 "깃헙 페이지를 안 거치고 **맥을 서버로** 쓰고 싶다, 단 **맥이
해킹당해도 괜찮아야** 한다"였다. 답은 **역할을 쪼개는 것**이다.

> **맥은 릴레이(+알림)만 맡는다. 앱 코드(HTML/JS)는 절대 맥이 서빙하지 않는다.**

| 침해 대상 | 공격자가 얻는 것 | 복구 |
|---|---|---|
| **릴레이**(맥) | 암호문 + 메타데이터(누가·언제·몇 건). 평문·키 **불가**, 위조 **불가** | 피해 한정. 감내 가능 |
| **코드 오리진** | 악성 JS 주입 → **개인키·평문 유출** | **복구 불가** |

맥이 통째로 털려도 대화는 안전하다 — **맥이 코드를 서빙하지 않을 때만**.
이것이 불변식 #1이고 유일하게 타협 불가한 조항이다. 맥에 정적 서버를 띄워
앱까지 서빙하고 싶은 유혹이 생기겠지만, 그 순간 전제가 무너진다.

### 5개 불변식

1. **역할 분리** — 코드 호스팅과 릴레이는 다른 신뢰 도메인. 맥은 릴레이만
2. **릴레이 불신** — 평문·키가 남지 않는다. **읽기(REQ)도 인증 필요**
3. **`js/pfs.js`·`test/pfs.test.mjs` 동결** — 수정 금지, 문제 발견 시 보고
4. **자체 암호 구현 금지** — WebCrypto와 벤더링된 nostr-tools만
5. **정직한 한계 표기** — 막지 못하는 것은 README에 명시

---

## 3. 완료 현황

### 커밋

```
2841e8e S11: document the v4 limits, the deployment invariant, and the supersession
a7b0b49 S10: TOFU code fingerprint and install-time integrity check (F-01 mitigation)
9249614 S9:  strip the helper down to push only (F-02, F-16)
3146524 S8:  Mac relay, config split, and NIP-42 subscription auth
ebfdec0 S7:  content security policy and frame busting (F-01 partial, F-13)
59d7541 S6:  session reset + ratchet gap detection (F-04, F-14)
966d266 S5:  Web Locks per-peer session serialization (F-03)
0ce3882 S3:  three-phase incoming-wrap pipeline (F-07, F-08, F-09)
2a58ccc S2:  conversation isolation for message lookups (F-05)
6b58503 S1:  strict validation of decrypted payload fields (F-06)
b71f39f docs: self-review of the Zero Trust plan, fix 6 defects
bb8b9d3 docs: security audit and Zero Trust v4 work order
c0f8178 M7 … f4c1512 M0  (v3.0 구현)
```

> S6 커밋 제목에 `(WIP, blocked)`가 남아 있다. 당시 한쪽만 초기화하는
> 시나리오가 막혀 있었고, §5에 적은 대로 **한계 문서화로 해소**되어 지금은
> 완료 상태다. 이미 푸시된 커밋이라 제목은 그대로 두었다.

### S0~S11

| 단계 | 내용 | 상태 |
|---|---|---|
| S0 | 준비 | ✅ |
| S1 | 수신 페이로드 엄격 검증 (F-06) | ✅ |
| S2 | 대화 간 격리 — `messages` 복합키 `[pk,id]` (F-05) | ✅ |
| S3 | 수신 경로 3단계 재구성 (F-07/08/09) | ✅ |
| S4 | (S3에 포함) | ✅ |
| S5 | 다중 탭 방어 — Web Locks (F-03) | ✅ |
| S6 | 세션 초기화 + 검열 갭 탐지 (F-04, F-14) | ✅ |
| S7 | CSP + 프레임 차단 (F-01 부분, F-13) | ✅ |
| S8 | 맥 릴레이 + 설정 분리 + **NIP-42 읽기 인증**(P-1) | ✅ |
| S9 | 헬퍼 축소 — 아카이브 전면 삭제 (F-02, F-16) | ✅ |
| S10 | TOFU 코드 지문 + 설치 시 무결성 검사 (F-01 완화) | ✅ |
| S11 | 문서 갱신 (한계 표, 배포 불변식, PLAN.md 개정 표기) | ✅ |

### 검증 결과 (최종 트리 기준, 전부 재실행)

| 스위트 | 결과 |
|---|---|
| `test/pfs.test.mjs` | **44/44** (모든 커밋에서 유지) |
| 브라우저 회귀 12종 (`check_m0~m6`, `check_s1~s7`) | 전부 PASS |
| 실제 릴레이/헬퍼 프로세스 5종 (`check_s8_*`, `check_s9`, `check_s10`) | 전부 PASS |
| §5 최종 체크리스트 통합 항목 | 7/7 |

§5 체크리스트 15번(실기기 갤럭시 Chrome·아이폰 Safari)만 이 환경에서
수행 불가다. **실기기 확인은 남아 있다.**

---

## 4. 무엇이 달라졌나 — 감사 지적 대응

| 항목 | 이전 | 지금 |
|---|---|---|
| F-01 CSP 없음 | 없음 | `default-src 'none'` 기반 CSP + JS 프레임 차단 + TOFU 지문 |
| F-02 헬퍼 암호문 아카이브 | 30일치 축적 | **전면 삭제** (릴레이가 같은 역할, 중복이었음) |
| F-03 탭별 세션 경합 | 문서 단위 큐 | Web Locks (오리진 전체 상호배제) |
| F-04 래칫 영구 파손 | 탈출구 없음 | 안전코드 화면의 2단계 탭 세션 초기화 |
| F-05 대화 간 ack 위조 | 전역 `id` 조회 | 복합키 `[pk,id]` + `dir` 소유권 검사 |
| F-06 페이로드 무검증 | 복호되면 신뢰 | UUID·길이·ts 클램프·bidi 제거 |
| F-07 ack 유실 교착 | 중복이면 ack 생략 | 중복이어도 **항상** 재-ack |
| F-08 메시지 유실 | 처리 전 `markSeenWrap` | 확정 폐기·저장 완료 시점에만 |
| F-09 락 안에서 발행 | 발행이 락 점유 | 락 안=봉투 생성, 락 밖=발행 (`pending` 상태 추가) |
| F-13 클릭재킹 | 무방비 | `window.top !== window.self` 차단 |
| F-14 조용한 검열 | 탐지 불가 | 래칫 헤더 갭 추적 + 채팅방 경고 배너 |
| F-16 등록 DM 재생 | 되감기 가능 | `ts` 단조 검사 |
| **P-1 (자체 감사)** | **REQ 무인증** | **NIP-42 인증 필수 — 인증 전엔 이벤트 0건** |

**P-1이 가장 중요했다.** 쓰기는 서명이 막지만 읽기(REQ)는 누구든 보낼 수
있었다. 그 상태로는 tailnet에 닿는 아무 기기나 `#p` 필터 하나로 두 사람의
전체 암호문·타이밍·발신량을 열람할 수 있어, "공개 릴레이보다 메타데이터가
안전해진다"는 주장 자체가 성립하지 않았다.

---

## 5. 알아둬야 할 판단 두 가지

### (1) 한쪽만의 세션 초기화 — 한계로 문서화

`pfs.js`의 `managerDecrypt()`는 모르는 세션이 오면 "동시 개시 충돌"로 보고
공개키 사전순으로 승자를 정한다. **한쪽만의 초기화는 상대에게 이 충돌과
완전히 똑같이 보인다.** 그래서 초기화한 쪽 pk가 사전순으로 크면 상대는
이미 삭제된 옛 세션을 계속 쓰게 되고, 수신은 되는데 발신만 깨진다
(6회 관측 중 예측과 6/6 일치, 결정적).

고치려면 `pfs.js`를 건드려야 해서 **불변식 #3 위반**이고, 새 페이로드
종류를 추가하는 것도 계획서에 없는 기능이다(규칙 C). 그래서 계획서
S6-a 완료기준("초기화 후 정상 왕복")은 **양쪽 초기화 시나리오**로 충족하고,
한쪽만 하는 경우는 **불변식 #5에 따라 README 한계 표에 명시**했다.

관측 근거는 `probe_reset_collision.mjs`에 남아 있다.

### (2) 규칙 B 편차 — 릴레이가 AUTH에 OK를 보내야 한다

계획서 S8-d는 인증 성공 시 릴레이가 무엇을 응답할지 규정하지 않았다.
그런데 nostr-tools 2.25.0의 `AbstractRelay.auth()`는
`["OK", <auth 이벤트 id>, true, ...]`를 받아야 프로미스가 풀리고,
그래야 `SimplePool`이 재구독한다. 응답이 없으면 **인증은 됐는데 영영
구독이 안 되는** 상태가 된다.

그래서 성공 시 `OK true`, 거부 시 `OK false`를 보낸다(어느 쪽이든 연결은
유지되고 `authed`는 계획서대로 동작한다). 규칙 B에 따라 커밋 메시지에
기록했다.

한편 계획서가 추정한 서명자 형태
`(authEvent) => finalizeEvent(authEvent, sk)`는 **실물과 정확히 일치**했다.

---

## 6. 배포 순서 (중요)

**순서를 지켜야 한다.** `set-relay`가 파일을 고치므로 지문은 그 뒤에 만든다.

```bash
# 1) 맥에서 릴레이 준비
cd relay && npm install
cp config.example.json config.json     # allowedPubkeys에 폰A·폰B·도우미 pk

# 2) Tailscale 종단 (자세한 건 relay/README.md)
tailscale serve --bg --https=443 --set-path=/relay http://127.0.0.1:18787
npm start

# 3) 앱 종단 박아넣기 — config.js와 CSP를 동시에 갱신한다
node tools/set-relay.mjs wss://<맥>.ts.net/relay

# 4) 무결성 지문 생성 (반드시 3번 뒤에)
node tools/gen-integrity.mjs

# 5) 앱을 맥이 아닌 정적 호스팅에 올린다 ← 불변식 #1
#    GitHub / Codeberg / Cloudflare / GitLab Pages / Netlify 중 아무거나
#    start_url이 상대경로라 어느 쪽이든 코드 수정 불필요

# 6) 도우미
cd helper && npm install
cp config.example.json config.json     # relayUrl을 맥 릴레이로
node helper.mjs                        # 출력되는 도우미 pk를 릴레이 allowedPubkeys에 추가
```

`js/config.js`와 `index.html`의 CSP가 어긋나면 **앱이 아무 오류 없이 조용히
오프라인**이 된다. 그래서 반드시 `set-relay.mjs`로만 바꾼다.

---

## 7. 파일 목록

### 저장소 (git 관리)

| 경로 | 설명 |
|---|---|
| `index.html` `css/style.css` | UI. CSP 메타는 `<head>` 최상단 |
| `js/main.js` | 오케스트레이션 — 화면·이벤트·송수신 파이프라인·TOFU 검사 |
| `js/crypto.js` | NIP-17/44/59 봉투 + pfs 연결 + `buildAuthSigner` |
| `js/pfs.js` | **동결.** Double Ratchet |
| `js/store.js` | IndexedDB v4 (`gaps`·`codePin` 포함) |
| `js/net.js` | 릴레이 전송 + `setAuthSigner` |
| `js/config.js` | **릴레이 종단. `set-relay.mjs`만 고칠 것** |
| `js/util.js` `sw.js` `manifest.webmanifest` | 유틸 / SW(무결성 검사·푸시) / PWA |
| `integrity.json` | 배포본 지문. `gen-integrity.mjs`가 생성 |
| `relay/relay.mjs` | **맥 릴레이.** NIP-42 인증, EVENT 수용 규칙, 보관 |
| `relay/README.md` | 설치·Tailscale·접근통제·로그정책 |
| `helper/helper.mjs` | 푸시 도우미 (아카이브 없음) |
| `helper/README.md` | 설치 + **운영 하드닝** |
| `tools/set-relay.mjs` | 릴레이 종단 갱신 (config.js + CSP 동시) |
| `tools/gen-integrity.mjs` | 지문 생성 (sw.js PRECACHE에서 목록을 읽음) |
| `test/pfs.test.mjs` | **동결.** 44개 |
| `PLAN.md` | v3.0 사양 + 개정 표기 한 줄 |
| `docs/SECURITY-AUDIT.md` | F-01~F-16 |
| `docs/PLAN-V4-ZEROTRUST.md` | **작업 지시 정본** |
| `docs/HANDOFF.md` | 이 문서 |

`relay/config.json`, `relay/state/`, `helper/config.json`, `helper/state/`,
`node_modules/`는 `.gitignore` 처리되어 있다.

### 테스트 하네스 (git에 없음 — 별도 보관 필요)

| 파일 | 설명 |
|---|---|
| `fake_relay.mjs` | **핵심.** Playwright `routeWebSocket` 기반 인메모리 릴레이. `dropHosts`(연결 차단) / `blackholeHosts`(OK 미응답 → 진짜 타임아웃) / `swallowPredicate`+`releaseSwallowed()`(조용한 누락 후 지연 도착) / `disconnectAll()` / `onOutgoing` |
| `check_m0~m6.mjs` | M단계 회귀 |
| `check_s1/s2/s3/s5/s6/s7.mjs` | S단계 회귀 (페이크 릴레이) |
| `check_s8_relay.mjs` | 릴레이 와이어 프로토콜 21종 |
| `check_s8_app.mjs` | 앱↔실제 릴레이 종단간 |
| `check_s8_helper.mjs` | 헬퍼 NIP-42 인증 |
| `check_s9.mjs` | 아카이브 미생성 + F-16 단조 검사 |
| `check_s10.mjs` | 지문/무결성 |
| `final_checklist.mjs` | §5 통합 항목 |
| `probe_reset_collision.mjs` | §5(1)의 근거를 만든 관측 스크립트 |

---

## 8. 테스트 실행법

```bash
node test/pfs.test.mjs           # 44개, 항상 전부 통과해야 함

# 브라우저 테스트는 자리표시자를 치환한 "배포 사본"이 필요하다.
#   - 페이크 릴레이용(check_m*, check_s1~s7): CSP·config를 공개 릴레이 4곳으로
#   - 실제 릴레이용(check_s8_app 등): ws://127.0.0.1:<포트>
# 사본을 만들고 gen-integrity를 돌린 뒤 정적 서버로 서빙한다.
```

Chromium은 `/opt/pw-browsers/chromium`에 있다
(`chromium.launch({ executablePath: "/opt/pw-browsers/chromium" })`).

### 재발 방지용 함정 목록

- **보이지 않는 유니코드**: `sanitizeForDisplay`의 bidi 제거 정규식
  (`[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]`)을 그냥 타이핑하면
  실제 보이지 않는 글자가 파일에 박히는 사고가 **세 번** 났다(이 문서 초안
  포함). 손대야 하면 Python으로 바이트 단위 치환하고 `od -c`로 검증할 것.
- **라우팅은 페이지 생성 전에**: `attachFakeRelays(ctx)`를 `ctx.newPage()`
  뒤에 걸면 `boot()`이 이미 실제 인터넷으로 붙으려다 전부 실패한다.
- **한 메시지는 여러 호스트에 발행된다**: 한 호스트에서만 삼켜봐야 나머지로
  그대로 도착한다. 이벤트 `id`로 전 호스트를 함께 삼켜야 한다.
- **`dropHosts`는 새 연결만 막는다**: 이미 열린 연결은 `disconnectAll()`.
- **클릭 핸들러는 async를 안 기다린다**: `page.click()` 반환이 내부 `await`
  완료를 뜻하지 않는다. 상태를 폴링할 것.
- **테스트 스크립트가 크래시하면 릴레이가 고아로 남는다** — 포트를 물고
  있어 다음 실행이 `ECONNREFUSED`로 엉뚱하게 실패한다.
- **IndexedDB v4 이중 업그레이드**: `gaps` 스토어는 S2 시점(v4)에 미리
  만들어 뒀다. 같은 버전 번호로 두 번 업그레이드하지 않기 위함이다.
- **`set-relay` → `gen-integrity` 순서**: 반대로 하면 지문이 어긋나 SW
  설치가 거부된다.

---

## 9. 남은 일

1. **실기기 검증**(§5 체크리스트 15번) — 갤럭시 Chrome·아이폰 Safari에서
   Tailscale 켜고 온보딩·왕복·오프라인 전달 재수행. 이 환경에서 불가능한
   유일한 항목이다.
2. 실제 Tailscale 종단에서 `wss://` 인증서가 브라우저에 유효한지 확인
   (자체서명은 브라우저가 거부한다).
3. 테스트 하네스를 저장소에 넣을지 결정 — 지금은 스크래치에만 있어
   환경이 사라지면 유실된다.
