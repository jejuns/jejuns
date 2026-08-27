# 밀담(Mildam) — 서버리스 종단간 암호화 메신저 구현 설계서 v3.0

> **이 문서는 구현 담당 AI(Sonnet)를 위한 유일한 사양서다.**
> 이 문서에 적힌 대로만 구현한다. 여기에 없는 기능은 만들지 않고,
> 여기에 적힌 결정은 바꾸지 않는다. §14(모호성 해결 규칙)와 §15(금지사항)를
> 가장 먼저 읽을 것.
>
> **저장소에 이미 존재하는 `js/pfs.js`와 `test/pfs.test.mjs`는 완성·검증된
> 코드다(더블 래칫 PFS 계층). 절대 수정하지 말고 §6.6의 계약대로 호출만 한다.**
> v2.0 대비 변경: 전방 비밀성(더블 래칫) 추가, 도우미 기기(맥북에어)를 통한
> 푸시 알림·암호문 보관 추가, 초대코드 v3.

---

## 1. 목표

- 두 사람이 1:1로 텍스트 메시지를 주고받는 메신저.
- **비동기 전달**: 상대가 접속해 있지 않아도 보낼 수 있고, 상대는 나중에
  앱을 열면 밀린 메시지를 받는다.
- **종단간(E2E) 암호화 + 전방 비밀성(PFS)**: 중개하는 어떤 릴레이·도우미도
  평문을 볼 수 없고, 장기키가 유출되어도 과거 대화는 복호되지 않는다
  (더블 래칫 — 첫 왕복 이전 구간만 예외, §2).
- **운영자가 유지하는 유료 서버가 없다.** 전달·임시 보관은 공개 Nostr 릴레이,
  푸시 알림·보관 보강은 **집에 있는 맥북에어(도우미, §16)** 가 담당한다.
  도우미가 꺼져도 메시징 자체는 계속 동작한다(알림만 중단).
- **갤럭시(Android Chrome/삼성인터넷)와 아이폰(iOS Safari 16.4+) 모두에서 동작**하는
  설치형 웹앱(PWA). 앱스토어 배포 없음. iOS 푸시는 홈 화면에 추가된 PWA에서 동작.
- 순수 HTML/CSS/JS로 구현. 프레임워크·빌드 도구 없음.

### 1.1 비목표 (v3에서 만들지 않는 것)

- 그룹 채팅, 음성/영상 통화, 파일·이미지 전송, 스티커
- 다중 기기 동기화, 계정 백업/복구, 다른 Nostr 클라이언트와의 상호운용
- QR 코드 스캔 (초대코드 복사/붙여넣기만)
- 앱 잠금(PIN), 저장 메시지 암호화(at-rest)
- 알림 내용 미리보기 (도우미는 복호 키가 없으므로 원천 불가 — 의도된 설계)

## 2. 정직한 한계 (사용자에게도 앱 내에 고지할 것 — §9.7 문자열 참고)

| 한계 | 이유·완화 |
|---|---|
| 푸시 알림은 **도우미(맥북에어)가 켜져 있을 때만** 온다. 도우미가 꺼지면 알림만 멈추고 메시징은 정상 | 알림 발송에는 상시 구동 기기가 필요. 도우미는 바깥 방향 연결만 쓰므로 공유기 설정 불필요 |
| 알림에는 발신자·내용이 없다("새 메시지가 도착했습니다"만). 수신확인(ack)에도 알림이 갈 수 있다 | 도우미는 암호문만 보므로 구분 불가. 사용자별 2분 간격 제한으로 완화(§16.4) |
| 릴레이·도우미는 **수신자 공개키(수신함 주소), 암호문 크기, 접속 IP**를 볼 수 있음. 발신자는 은닉, 시각은 ±최대 2일 무작위화. 내용은 절대 볼 수 없음 | 프로토콜 특성. IP 은닉(VPN/Tor)은 범위 밖 |
| **PFS의 예외 구간**: 어떤 대화에서 첫 "왕복"이 이루어지기 전의 메시지들은 장기키 유출 시 복호될 수 있음(정적 ECDH 수준 보호). 첫 왕복 이후부터는 래칫이 돌아 과거 메시지가 보호됨 | 상대 부재중에도 첫 메시지를 암호화하기 위한 구조적 대가(Signal도 동일 계열의 예외 있음) |
| 상대가 아주 오래(30일+) 접속하지 않으면 메시지 유실 가능 | 공개 릴레이 4곳 중복 발행 + 도우미가 30일간 재발행(§16.5)으로 완화 |
| 웹 배포 특성상, 호스팅(GitHub Pages)이 악성 코드를 서빙하면 이론상 보안이 깨짐 | 웹앱의 근본 한계. 코드 전체 공개로 검증 가능성 유지 |
| iOS는 PWA 저장소를 드물게 정리할 수 있음(키 유실 위험) | `navigator.storage.persist()` 요청으로 완화(§8.4) |
| 도우미 맥북에어의 macOS 11은 보안 업데이트가 종료된 OS | 도우미는 바깥 방향 연결만 하고 대화 복호 키를 갖지 않으므로 위험 제한적. README에 명기 |

## 3. 아키텍처 확정

```
[내 폰: PWA] ── 암호문 발행/구독(WSS) ──> [공개 Nostr 릴레이 4곳] <── 구독/발행 ── [상대 폰: PWA]
                                                   ▲
                                                   │ 구독(바깥 방향)·재발행
                                     [도우미: 맥북에어 + Node 데몬 §16]
                                                   │ 새 암호문 감지 시
                                                   ▼ Web Push(바깥 방향 HTTPS)
                                        [구글/애플 푸시 게이트웨이] → 두 사람의 폰

정적 파일 호스팅: GitHub Pages (메시지 미경유, HTML/JS만 서빙)
```

- **전송·보관**: Nostr 공개 릴레이. 메시지는 **NIP-17**(kind 14 rumor →
  NIP-59 gift wrap kind 1059, NIP-44 v2 암호화 — Cure53 감사 완료 표준)로 발행.
- **PFS 계층**: rumor의 content는 평문이 아니라 **`js/pfs.js` 더블 래칫이
  출력한 봉투(§6.6)** 다. 즉 이중 암호화: 더블 래칫(내용 보호+PFS) 안쪽,
  NIP-17/44(전송·메타데이터 보호) 바깥쪽.
- **암호 구현 직접 작성 금지.** NIP 계층은 벤더링한 `nostr-tools`,
  PFS 계층은 제공된 `js/pfs.js`를 그대로 사용.

## 4. 기술 스택 확정 (변경 금지)

**PWA(폰 쪽)**: 바닐라 JS(ES2020, ES Modules), 프레임워크·번들러·npm·TS 금지.
저장은 IndexedDB. 외부 라이브러리는 벤더링한 `nostr-tools` 하나(+제공된 `pfs.js`).

**도우미(맥북에어 쪽, §16)**: Node.js 20 LTS(x64 — macOS 11 지원) 스크립트.
여기만 npm 허용, 의존성은 정확히 `nostr-tools@^2`와 `web-push@^3` 두 개.

### 4.2 nostr-tools 벤더링 절차 (PWA용)

1. `https://cdn.jsdelivr.net/npm/nostr-tools@2/+esm` 을 내려받아
   `vendor/nostr-tools.js`로 저장·커밋, 실제 버전을 `vendor/VERSION.txt`에 기록.
2. 코드에서는 `import {…} from "../vendor/nostr-tools.js"` 로만 로드.
   런타임 CDN·외부 URL 로드 금지(릴레이 WSS 제외).
3. 사용 기능: 키 생성/공개키 유도, schnorr 서명·검증, `SimplePool`,
   NIP-17/44/59 구현(`nip17` 모듈 우선, 없으면 `nip59`+`nip44` 조합),
   NIP-44 대화키(`getConversationKey` 상당). 정확한 export 이름은 벤더링된
   실물이 기준(§14 규칙 B).

## 5. 파일 구조 확정

```
/                       (저장소 루트 = GitHub Pages 루트)
├── index.html          단일 페이지. 모든 화면(§9)이 <section>으로 존재
├── css/style.css
├── js/
│   ├── main.js         부팅, 화면 전환, 이벤트 바인딩 (오케스트레이션만)
│   ├── crypto.js       §6 구현: 키·초대코드·안전코드·NIP-17 wrap/unwrap·pfs 호출
│   ├── net.js          §7 구현: SimplePool 관리, 발행·구독, 연결 상태
│   ├── store.js        §8 구현: IndexedDB 접근 계층
│   ├── util.js         base64url·hex 변환, UTF-8 인코딩 헬퍼
│   └── pfs.js          ★ 제공됨 — 더블 래칫. 수정 금지, import만
├── test/pfs.test.mjs   ★ 제공됨 — `node test/pfs.test.mjs` 44개 통과 상태 유지
├── vendor/ (nostr-tools.js, VERSION.txt)
├── helper/             §16 도우미 데몬 (맥북에어에서 실행)
│   ├── helper.mjs
│   ├── package.json    (deps: nostr-tools ^2, web-push ^3 — 정확히 둘)
│   └── README.md       §16.7의 설치 절차
├── icons/icon.svg      §10.3 마크업 그대로
├── manifest.webmanifest
├── sw.js               서비스 워커 (§10.2 — 캐시 + 푸시 수신)
├── PLAN.md             (이 문서)
└── README.md           설치·배포·한계 요약 (한국어)
```

의존 방향: `main.js → (net.js, store.js, crypto.js) → util.js`,
`crypto.js → pfs.js`. vendor import는 `crypto.js`·`net.js`만.
`pfs.js`는 무의존 단독 모듈이다.

## 6. 신원·암호화 사양 (한 글자도 바꾸지 말 것)

### 6.1 인코딩 규약

바이너리↔문자열은 base64url 무패딩(`util.js`의 `bufToB64u`/`b64uToBuf`).
공개키·이벤트 id는 64자 소문자 hex. 문자열→바이트는 UTF-8.
난수는 `crypto.getRandomValues` 또는 라이브러리 제공 함수만(`Math.random` 금지).

### 6.2 신원 키 + 래칫 프리키

최초 실행 시 1회 생성:
1. **신원키**: nostr-tools로 secp256k1 개인키(32바이트) + 공개키
   (x-only 64자 hex, 이하 `pk`). 지문 = `pk`.
2. **래칫 프리키(spk)**: `pfs.createRatchetPrekey()` 호출 →
   `{privateKey, pubRaw(65바이트)}`. `spk = bufToB64u(pubRaw)`.
3. **프리키 서명**: `spkSig = schnorr 서명( 신원 개인키,
   SHA-256( UTF-8("mildam-spk-v1|" + pk + "|" + spk) ) )` 의 64자*2 hex.
   (nostr-tools의 schnorr 서명/검증 유틸 사용.)

전부 IndexedDB `meta`에 저장(§8). 개인키·프리키 개인키의 표시·export·전송·로그 금지.

### 6.3 초대코드 v3

- 형식: `MD3.` + base64url( UTF-8( JSON
  `{"v":3,"name":<이름>,"pk":<pk>,"spk":<spk>,"sig":<spkSig>}` ) )
- 파싱 규칙: 접두사 `MD3.` 아님 / JSON 실패 / `v !== 3` / `pk` 64자 hex 아님 /
  `spk` base64url 65바이트 아님 → **E01**. schnorr 검증
  (`pk`, 위 §6.2-3과 같은 메시지, `sig`) 실패 → **E08**.
- 친구 추가는 상호 교환(서로 등록해야 표시). 안내 문구 S12.
- 연락처 저장 항목: `{pk, name, spkRaw(Uint8Array 65), addedAt}`.

### 6.4 대화 공통값 (연락처당 1회 계산, 캐시 가능)

```
convKey    = NIP-44 대화키( 내 신원 개인키, 상대 pk )        // nostr-tools 제공, 32바이트
rootSecret = await pfs.deriveRootSecret(convKey, 내pk, 상대pk) // 32바이트
ad         = pfs.makeAd(내pk, 상대pk)                          // 문자열
```

### 6.5 애플리케이션 페이로드 (평문 JSON — 래칫 봉투 안에 들어감)

| 필드 | 값 |
|---|---|
| `v` | `3` 고정 |
| `kind` | `"text"` 또는 `"ack"` |
| `id` | `crypto.randomUUID()` (text만) |
| `body` | 본문 (text만, 최대 2000자) |
| `ref` | 확인 대상 `id` (ack만) |
| `ts` | `Date.now()` 밀리초 |

수신 처리: text는 `id` 중복이면 폐기, 아니면 저장 후 `ack` 회신;
ack는 해당 발신 메시지를 `delivered`로. `v !== 3`·미지의 `kind`는 조용히 폐기.
표시 순서는 `ts` 오름차순.

### 6.6 발신·수신 파이프라인 (pfs.js 계약)

**발신** (`crypto.js`):
```
mgr = store에서 sessions[상대pk] 로드; 없으면 pfs.createManager(내pk, 상대pk)
env = await pfs.managerEncrypt(mgr,
        {rootSecret, peerSpkRaw: 연락처.spkRaw, ad}, UTF-8(페이로드 JSON))
store.sessions[상대pk] = mgr  // 매 호출 직후 반드시 저장
content = JSON 문자열 {"v":3,"e":"dr1","h":env.h,"iv":env.iv,"ct":env.ct}
→ content를 본문으로 하는 kind 14 rumor를 NIP-17/59로 상대 pk 앞 gift wrap(kind 1059) 발행
```
**수신** (unwrap 성공 + 발신자가 연락처에 있을 때):
```
content JSON 파싱; v!==3 || e!=="dr1" → 조용히 폐기
mgr = sessions[발신자pk] 로드(없으면 createManager)
pt = await pfs.managerDecrypt(mgr,
       {rootSecret, mySpk: {privateKey: meta.spkPriv, pubRaw: meta.spkPubRaw}, ad},
       {h:content.h, iv:content.iv, ct:content.ct})
성공: sessions[발신자pk] = mgr 저장 → 페이로드 처리(§6.5)
실패(throw): 조용히 폐기 + console.warn 1줄 (오류 UI 없음 — 중복·스팸일 수 있음)
```
- **wrap 이벤트 id 중복 제거를 pfs 호출 전에 수행한다**(§7.3) — 같은 봉투를
  두 번 넣으면 pfs는 정상적으로 실패(리플레이 방어)하지만 낭비다.
- `pfs.js`의 다른 내부 함수 호출 금지. 파일 수정 금지. 이상 발견 시 §14 규칙 A.

### 6.7 안전코드

```
safety = hex( SHA-256( UTF-8("mildam-safety-v2|" + min(pkA,pkB) + "|" + max(pkA,pkB)) ) )
```
8자×8그룹 표시(§9.5). (WebCrypto `digest` 사용.)

### 6.8 명시적 보안 규칙

- 개인키·프리키·세션 상태·평문을 로그·릴레이 외 네트워크·localStorage에 남기지 않는다.
- NIP-44/59와 pfs를 우회하는 자체 암호화 경로 금지. 평문 kind(1, 4 등) 발행 금지.
- 발행 직전 kind가 1059가 아니면(§16.6의 도우미 등록 DM 포함, 그것도 1059다)
  발행을 거부하는 가드를 `net.js`에 둔다.

## 7. 네트워킹 사양

### 7.1 릴레이 목록 (고정 — 코드 상수 `RELAYS`)

```
wss://relay.damus.io   wss://nos.lol   wss://relay.primal.net   wss://offchain.pub
```
발행은 4곳 모두 시도, 1곳 이상 OK면 `sent`. 전부 실패 시 E07 + 상태
`failed`(탭하여 재발행). 구독은 4곳 동시, wrap 이벤트 id로 중복 제거.
릴레이 변경 UI 없음.

### 7.2 구독 필터와 동기화 커서

`{kinds:[1059], "#p":[내 pk], since: max(0, lastSync - 172800)}` (2일 여유 —
gift wrap 시각 무작위화 폭). `lastSync`(초)는 meta에 저장, 정상 처리한 wrap의
`created_at`으로 단조 갱신. 최초값 = 신원 생성 시각.

### 7.3 수신 게이트 (순서 고정)

① wrap 이벤트 id가 처리 이력(`seenWraps`, §8.1)에 있으면 폐기 → ② unwrap
실패 시 폐기 → ③ 발신자 pk가 연락처에 없으면 폐기 → ④ §6.6 수신 파이프라인.
①~③은 조용히(콘솔 warn만), UI 오류 없음.

### 7.4 연결 상태기계

`connecting → online(릴레이 1+ 연결) → offline(0곳)`. 전송 버튼은 online에서만
활성. offline이면 30초 간격 재연결. 미전송 큐·자동 재전송 없음.

## 8. 저장소 사양 (IndexedDB)

### 8.1 DB 정의 — 이름 `mildam`, 버전 `3`

| 스토어 | keyPath | 내용 |
|---|---|---|
| `meta` | `k` | `identity`: `{k, sk(Uint8Array 32), pk, name, spkPriv(CryptoKey), spkPubRaw(Uint8Array 65), spkSig, createdAt}` / `lastSync`: `{k, value}` / `helper`: `{k, pk, vapid}`(§16.6 등록 후) |
| `contacts` | `pk` | `{pk, name, spkRaw, addedAt}` |
| `sessions` | `pk` | `{pk, mgr}` — pfs 매니저 상태 통째로(structured clone 가능함이 보장됨) |
| `messages` | `id` + 인덱스 `byContact`:`[pk,ts]` | `{id, pk, dir:"in"\|"out", body, ts, status:"sent"\|"delivered"\|"received"\|"failed"}` |
| `seenWraps` | `id` | `{id, at}` — 처리한 wrap 이벤트 id. 부팅 시 `at`이 7일 지난 것 삭제 |

### 8.2 규칙

- pfs 매니저는 **encrypt/decrypt 호출 직후마다** 저장한다(놓치면 래칫 상태
  불일치로 대화가 깨진다 — 이 문장을 주석으로 store.js에 남길 것).
- 메시지 본문 평문 저장은 의도된 결정(기기 잠금 의존). 변경 금지.

### 8.3 localStorage 허용 예외 (유일): `mildam.lastView`

### 8.4 온보딩 직후 `navigator.storage.persist()` 1회 호출(결과는 console.info).

## 9. UI 사양

### 9.1 공통

`<section>` 6개: `#view-onboarding`, `#view-contacts`, `#view-add`,
`#view-chat`, `#view-safety`, `#view-settings`. 전환은 `hidden` 토글.
한국어만, 문자열은 §9.7 표 그대로. 다크 테마 고정, CSS 변수
`--bg:#0f1420; --panel:#1a2233; --text:#e8ecf4; --muted:#8b94a7; --accent:#4f8cff; --danger:#ff5d5d;`
`system-ui`, 최대폭 640px 중앙, 터치 타깃 44px+. 시각 디자인만 재량.

### 9.2 `#view-onboarding`: 앱 이름 "밀담", S01+S02, 이름 입력 `#ob-name`(1~20자),
`#ob-create` "시작하기" → §6.2 생성 → meta 저장 → persist() → 목록으로.

### 9.3 `#view-add`: 내 초대코드 `#add-mycode`(읽기전용) + `#add-copy` "내 코드 복사"
(성공 S13) / 상대 코드 `#add-peercode` + `#add-submit` "친구 추가"
(성공 S14, 자기 코드 E04, 중복 E05, 형식 E01, 서명 E08) / 안내 S12 상시.

### 9.4 `#view-contacts` / `#view-chat`

목록: 이름 + 마지막 메시지 미리보기 + 안 읽은 수 배지(입장 시 0). 헤더에
`#nav-add` "＋ 친구 추가", `#nav-settings` "⚙ 설정", 연결 배지(S20/S23/S26).
0명이면 S11.
채팅방: 헤더(이름, 연결 배지, `#chat-safety` "안전코드", `#chat-back` 뒤로),
말풍선(내 것 우측 accent/상대 좌측 panel, HH:MM, ✓ sent ✓✓ delivered,
failed는 ⚠ 탭→재발행), 입력 `#chat-input` + `#chat-send`(online에서만).
히스토리는 `byContact`로 `ts` 오름차순. 수신은 어느 화면에서든 백그라운드 처리.

### 9.5 `#view-safety`: 상대 이름, 안전코드 8자×8그룹 monospace, S30, 뒤로.

### 9.6 `#view-settings` (알림)

- 도우미 코드 입력 `#set-helpercode` + `#set-helper-save` "도우미 등록"
  (형식 오류 E09, 성공 S41).
- `#set-notify` "알림 켜기" (도우미 미등록 시 비활성 + S42 표시):
  `Notification.requestPermission()` → 거부 시 S43 토스트 → 허용 시
  `sw`의 `pushManager.subscribe({userVisibleOnly:true, applicationServerKey: meta.helper.vapid})`
  → 구독 JSON을 §16.6 등록 DM으로 도우미에 발송 → 성공 S44.
- 안내 문구 S40 상시 표시. 뒤로 버튼.

### 9.7 문자열 표 (그대로 사용)

| ID | 문구 |
|---|---|
| S01 | 자체 서버 없이 공개 릴레이로 암호문만 주고받는 종단간 암호화 메신저입니다. 대화 내용은 두 사람 외에는 누구도 읽을 수 없습니다. |
| S02 | 메시지는 상대가 꺼져 있어도 전달됩니다. 알림은 설정에서 도우미를 등록하면 받을 수 있습니다. |
| S11 | 아직 친구가 없습니다. ＋ 버튼으로 초대코드를 교환해 보세요. |
| S12 | 초대코드는 직접 만나서 또는 이미 신뢰하는 다른 채널로 교환하세요. 서로 상대의 코드를 등록해야 대화가 시작됩니다. |
| S13 | 코드가 복사되었습니다 |
| S14 | 친구가 추가되었습니다 |
| S20 | 연결 중… |
| S23 | 🔒 암호화 연결됨 |
| S26 | 오프라인 — 네트워크를 확인하세요 |
| S30 | 두 사람의 화면에 같은 코드가 표시되면 대화 상대가 바꿔치기되지 않았다는 뜻입니다. 직접 만나거나 영상통화로 확인하세요. |
| S40 | 알림은 집의 도우미 기기가 켜져 있을 때 옵니다. 도우미는 암호문만 볼 수 있어 알림에 내용이 표시되지 않습니다. |
| S41 | 도우미가 등록되었습니다 |
| S42 | 먼저 도우미 코드를 등록하세요 |
| S43 | 알림 권한이 거부되었습니다. 브라우저 설정에서 허용해 주세요. |
| S44 | 알림이 켜졌습니다 |

## 10. PWA 사양

### 10.1 manifest.webmanifest — v2.0과 동일:

```json
{"name":"밀담","short_name":"밀담","start_url":".","display":"standalone",
 "background_color":"#0f1420","theme_color":"#0f1420",
 "icons":[{"src":"icons/icon.svg","sizes":"any","type":"image/svg+xml","purpose":"any"}]}
```
head에 manifest·theme-color·viewport(`viewport-fit=cover`)·apple 메타 포함.
(iOS 홈 아이콘 PNG 미지원은 한계로 README 기재.)

### 10.2 sw.js

- 캐시 `mildam-v3`(릴리스마다 증가): §5 정적 파일 precache, activate에서 구캐시
  삭제+`clients.claim()`, same-origin GET cache-first. WSS·cross-origin 불간섭.
- `push` 이벤트: `self.registration.showNotification("밀담",
  {body:"새 메시지가 도착했습니다", icon:"icons/icon.svg"})`. 페이로드 파싱 안 함.
- `notificationclick`: 알림 닫고 열린 클라이언트 focus, 없으면 `clients.openWindow(".")`.

### 10.3 icons/icon.svg — v2.0과 동일 마크업:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="112" fill="#0f1420"/>
  <circle cx="256" cy="236" r="130" fill="#4f8cff"/>
  <path d="M196 340h120l-40 72z" fill="#4f8cff"/>
  <text x="256" y="272" font-family="sans-serif" font-size="120" font-weight="700"
        fill="#0f1420" text-anchor="middle">밀</text>
</svg>
```

## 11. 오류 코드 표 (문구 그대로)

| 코드 | 상황 | 사용자 문구 | 동작 |
|---|---|---|---|
| E01 | 초대코드 형식 오류 | 초대코드 형식이 올바르지 않습니다 | 토스트 |
| E04 | 자기 코드 등록 | 자기 자신은 추가할 수 없습니다 | 토스트 |
| E05 | 중복 연락처 | 이미 추가된 친구입니다 | 토스트 |
| E06 | WebCrypto/IndexedDB 미지원 | 이 브라우저는 지원되지 않습니다. 최신 Chrome 또는 Safari를 사용하세요. | 부팅 중단 |
| E07 | 4개 릴레이 전부 발행 실패 | 전송에 실패했습니다. 네트워크 확인 후 메시지를 탭해 다시 보내세요. | `failed` |
| E08 | 초대코드 프리키 서명 불일치 | 초대코드 검증에 실패했습니다. 상대에게 코드를 다시 받아 확인하세요. | 토스트, 저장 안 함 |
| E09 | 도우미 코드 형식 오류 | 도우미 코드 형식이 올바르지 않습니다 | 토스트 |

(unwrap 실패·미등록 발신자·pfs 복호 실패는 조용한 폐기 — §7.3, §6.6.)

## 12. 구현 순서와 단계별 완료 기준 (이 순서대로, 단계당 1커밋 `M0: …`)

| 단계 | 내용 | 완료 기준 |
|---|---|---|
| M0 | 골격: §5 파일(제공된 pfs/test 제외 신규 생성), 화면 전환, manifest, sw(캐시만), 벤더링 | 온보딩 표시, 설치 가능 판정, 콘솔 오류 0, `node test/pfs.test.mjs` 44개 통과 유지 |
| M1 | §6.2~6.3 신원·프리키·초대코드 + store + 온보딩·친구 추가 | 두 프로필 상호 등록 성공, 새로고침 후 유지, 안전코드 양쪽 동일, 변조 코드에 E08 |
| M2 | net + §6.4~6.6 파이프라인(pfs 통합) | 양방향 송수신, **한쪽 완전 종료 중 보낸 메시지가 재접속 시 도착**, 세션이 새로고침 후에도 이어짐(래칫 지속) |
| M3 | 채팅 UI 전체 + 히스토리 + ✓/✓✓/⚠ + 안 읽음 배지 | ✓→✓✓, 히스토리 유지, 중복 wrap 1건만 표시 |
| M4 | 안전코드 화면, 오류 전체, 미지원 가드, lastSync·seenWraps 정리 | §13의 1~7 통과 |
| M5 | helper/ 데몬 + README(§16) | §13의 8~9 통과(데스크톱에서 데몬 실행으로 검증) |
| M6 | 설정 화면 + sw push + 도우미 등록 DM | §13의 10 통과 |
| M7 | 저장소 README 완성, Pages 배포 안내 | 배포·사용법·한계(§2)·맥북에어 설치(§16.7 링크) 기재 |

## 13. 수동 테스트 체크리스트

데스크톱 Chrome 두 프로필(A/B)로:

1. 각자 온보딩 → 코드 교환 → 상호 추가 (변조 코드는 E08)
2. 둘 다 연 상태 왕복 5회: 실시간 도착, ✓✓, 순서·시각 정상
3. **B 종료 → A가 3개 전송 → B 재접속 → 3개 도착 + A의 ✓→✓✓** (핵심)
4. A 새로고침 후 히스토리 유지·중복 없음·**대화 계속됨(래칫 상태 복원)**
5. 자기 코드 → E04, 깨진 코드 → E01
6. 오프라인 전송 → E07·⚠ → 온라인 후 탭 재전송 성공
7. DevTools WS 프레임: 나가는 이벤트가 kind 1059뿐, 평문 없음
8. `node test/pfs.test.mjs` → 44 passed
9. 데몬: `node helper/helper.mjs` 첫 실행 → 도우미 코드 출력, A·B pk로 온
   wrap 감지 로그, 재발행 파일 생성
10. 설정에서 도우미 등록 + 알림 켜기 → B 종료 후 A 발신 → (데스크톱 알림으로)
    "새 메시지가 도착했습니다" 수신
11. (모바일) 갤럭시 Chrome·아이폰 Safari 홈 화면 추가 후 1~4 재수행,
    아이폰은 알림(10)도 재수행

## 14. 모호성 해결 규칙 (Sonnet 필독)

- **규칙 A**: 문서가 침묵하는 결정은 임의로 정하지 말고 **멈추고 사용자에게
  질문**한다(아래 기본값 표 제외). `pfs.js`에서 문제를 발견했다고 판단되면
  수정하지 말고 멈추고 보고한다.
- **규칙 B**: 문서 vs 외부 자료 충돌 시, 프로토콜·보안 사양(§6·§7·§16)은 이
  문서가 이기고, 라이브러리 API 이름·시그니처는 실물 라이브러리가 이긴다
  (달라진 점은 커밋 메시지에 기록).
- **규칙 C**: 임의 기능·리팩터링·의존성 추가 금지. 비목표는 요청받아도
  이 브랜치에서 구현하지 않는다.

기본값: 시각 표시 로컬 24시간 HH:MM / 이름 20자 / 메시지 2000자 / 토스트
3000ms / 문자열 비교 코드포인트 `<` / 재연결 30초 / `lastSync`·`created_at`은
초, 그 외 타임스탬프 밀리초.

## 15. 금지사항 (위반 = 실패)

1. 유료·상시 클라우드 백엔드, 애널리틱스 추가 금지 (도우미 데몬은 §16 명세 내에서만)
2. PWA의 런타임 CDN/외부 URL 로드 금지 (§7.1 릴레이 WSS 제외)
3. §6·§7·§16 프로토콜 규격(NIP-17/44/59, 봉투·페이로드 스키마, 도메인 문자열,
   릴레이 목록) 변경 금지. 자체 암호 구현 금지. 평문 이벤트 발행 금지
4. **`js/pfs.js`·`test/pfs.test.mjs` 수정 금지.** 테스트 44개 통과 상태를
   모든 커밋에서 유지
5. PWA에 프레임워크·번들러·npm·TS 도입 금지 (npm은 helper/ 안에서만, 명시된 2개)
6. 개인키·프리키·세션 상태의 표시·export·전송·로그 금지. `Math.random` 금지
7. 문자열 표(§9.7)·오류 문구(§11) 임의 수정 금지
8. TODO/스텁으로 단계 완료 선언 금지
9. 이 브랜치 외 푸시 금지

## 16. 도우미(헬퍼) 사양 — 집의 맥북에어(2013, macOS 11)에서 실행

역할 두 가지뿐: **① 새 암호문 감지 → 내용 없는 푸시 알림 발송, ② 암호문
30일 보관·재발행**. 대화 복호 키가 없으므로 내용 접근은 불가능하다.
바깥 방향 연결만 사용한다(포트 개방·도메인·인증서 불필요).

### 16.1 파일과 실행

`helper/helper.mjs` 단일 스크립트, Node 20 LTS. `node helper.mjs`로 실행.
상태는 같은 폴더의 `state/` 아래 JSON/JSONL 파일(§16.5). npm 의존성은
`nostr-tools@^2`, `web-push@^3` 정확히 둘.

### 16.2 첫 실행(초기화)

1. 도우미 자신의 nostr 키쌍 생성 → `state/identity.json`
2. `web-push` VAPID 키쌍 생성 → `state/vapid.json`
3. **도우미 코드 출력**: `MDH1.` + base64url( UTF-8( JSON
   `{"v":1,"pk":<도우미 pk>,"vapid":<VAPID 공개키(base64url 그대로)>}` ) )
   — 사용자가 폰 설정 화면(§9.6)에 붙여넣는 값. 이후 실행 때도 매번 출력.

### 16.3 사용자 등록 (푸시 구독 수신)

- 폰 앱은 §9.6에서 도우미 pk 앞으로 NIP-17 DM을 보낸다. rumor content:
  `{"v":3,"kind":"pushsub","sub":<PushSubscription.toJSON()>,"ts":…}`
  (이 DM은 도우미가 읽어야 하므로 **pfs 봉투 없이** NIP-17/44만으로 보낸다.)
- 도우미는 자기 수신함(`#p` = 도우미 pk, kind 1059)을 구독해 unwrap하고,
  발신자 pk별로 구독을 `state/subs.json`에 저장(같은 pk 재등록은 교체).
  `kind:"pushsub"` 외 페이로드는 폐기.

### 16.4 감시와 알림

- `state/subs.json`의 모든 사용자 pk에 대해 §7.1의 릴레이 4곳에
  `{kinds:[1059], "#p":[pk들]}` 구독.
- 이벤트 도착 시 해당 pk의 구독으로 `web-push` 발송(본문 없는 빈 페이로드 또는
  `{}` — sw는 페이로드를 읽지 않는다).
- **사용자별 최소 간격 120초** (초과분은 무음 폐기). 410/404 응답이면 그
  구독을 삭제(폰에서 재등록 필요 — README에 기재).

### 16.5 보관·재발행

- 감시 중 수신한 wrap 이벤트를 `state/archive.jsonl`에 (최초 목격 시각과 함께)
  추가(이벤트 id 중복 제거).
- 24시간마다: 최초 목격 후 30일 이내의 이벤트를 릴레이 4곳에 재발행,
  30일 지난 항목은 파일에서 삭제.

### 16.6 앱 쪽 대응 (재확인)

도우미 등록 DM 발송(§9.6)도 kind 1059 wrap이므로 §6.8의 발행 가드와 충돌하지
않는다. 도우미 pk는 연락처가 아니며 채팅 UI에 나타나지 않는다.

### 16.7 맥북에어 설치 절차 (helper/README.md에 이 내용을 그대로 상세화)

1. nodejs.org에서 **Node 20 LTS macOS x64 `.pkg`** 설치(macOS 11 지원 버전).
2. `cd helper && npm install && node helper.mjs` → 출력된 도우미 코드를 두 폰에 등록.
3. 잠자기 방지: 시스템 환경설정 → 배터리/전원 어댑터에서 "디스플레이가 꺼져
   있을 때 컴퓨터 자동 잠자기 방지" 켜기 + 터미널에서 `sudo pmset -a sleep 0`.
   **뚜껑은 열어두고** 화면 밝기만 최소로(뚜껑을 닫으면 잠들 수 있음).
4. 자동 시작·재시작: `~/Library/LaunchAgents/com.mildam.helper.plist`
   (KeepAlive=true, RunAtLoad=true, `node helper.mjs` 실행) 등록 →
   `launchctl load ~/Library/LaunchAgents/com.mildam.helper.plist`.
5. 주의 기재: macOS 11은 보안 업데이트 종료 → 이 기기로 웹서핑 등 다른 용도
   병행 금지, 도우미 전용으로 사용. 전원·와이파이 상시 연결.
