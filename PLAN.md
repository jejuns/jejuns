# 밀담(Mildam) — 서버리스 종단간 암호화 메신저 구현 설계서 v1.0

> **이 문서는 구현 담당 AI(Sonnet)를 위한 유일한 사양서다.**
> 이 문서에 적힌 대로만 구현한다. 여기에 없는 기능은 만들지 않고,
> 여기에 적힌 결정은 바꾸지 않는다. §14(모호성 해결 규칙)와 §15(금지사항)를
> 가장 먼저 읽을 것.

---

## 1. 목표

- 두 사람이 1:1로 텍스트 메시지를 주고받는 메신저.
- **모든 메시지는 종단간(E2E) 암호화**된다. 중간의 어떤 서버·릴레이도 평문을 볼 수 없다.
- **운영자가 유지하는 서버가 없다.** 메시지는 WebRTC로 기기 간 직접(P2P) 전달된다.
- **갤럭시(Android Chrome/삼성인터넷)와 아이폰(iOS Safari 16.4+) 모두에서 동작**하는
  설치형 웹앱(PWA)이다. 앱스토어 배포 없음.
- 순수 HTML/CSS/JS로 구현한다. 프레임워크·빌드 도구 없음.

### 1.1 비목표 (v1에서 만들지 않는 것)

- 그룹 채팅, 음성/영상 통화, 파일·이미지 전송, 스티커
- 푸시 알림 (자체 서버가 없으므로 원천적으로 불가 — §2 참고)
- 오프라인 상대에게 메시지 저장 후 전달 (양쪽이 동시에 접속해야 대화 가능)
- 다중 기기 동기화, 계정 복구
- QR 코드 스캔 (v1은 초대코드 복사/붙여넣기만. QR은 v2)
- 앱 잠금(PIN), 저장 메시지 암호화(at-rest) — v2

## 2. 정직한 한계 (사용자에게도 앱 내에 고지할 것 — §9.7 문자열 참고)

서버가 없다는 선택의 대가를 명시한다. 구현자는 이 한계를 "개선"하려고
서버를 추가하면 안 된다.

| 한계 | 이유 |
|---|---|
| 두 사람이 **동시에 앱을 켜야** 대화 가능 | 메시지를 보관할 서버가 없음 |
| 푸시 알림 없음 | 푸시는 서버 필요 |
| 시그널링에 공개 Nostr 릴레이 사용 → 릴레이는 **접속 시각·방 ID·IP**를 볼 수 있음(메시지 내용은 절대 볼 수 없음) | WebRTC 연결 성립에는 최소한의 중개가 필요. 릴레이가 보는 시그널링 데이터도 room 비밀번호로 암호화됨(§7.2) |
| 웹 배포 특성상, 호스팅(GitHub Pages)이 악성 코드를 서빙하면 이론상 보안이 깨짐 | 웹앱의 근본 한계. 코드는 전부 저장소에 공개되어 검증 가능하게 유지 |
| iOS는 PWA 저장소를 드물게 정리할 수 있음 | `navigator.storage.persist()` 요청으로 완화(§8.4) |

## 3. 아키텍처 확정

```
[내 폰: PWA]  ←── WebRTC DataChannel (DTLS + 앱계층 AES-GCM) ──→  [상대 폰: PWA]
      │                                                                │
      └───── 시그널링만: Trystero(nostr 전략, 공개 릴레이) ─────────────┘

정적 파일 호스팅: GitHub Pages (메시지는 절대 경유하지 않음, HTML/JS만 서빙)
```

- **호스팅**: GitHub Pages. 이 저장소의 기본 브랜치 루트(`/`)에서 서빙.
  정적 파일만 서빙하므로 "지정 서버 없음" 조건을 만족(유지비 0, 메시지 미경유).
- **P2P 연결**: [Trystero](https://github.com/dmotz/trystero) 라이브러리,
  **nostr 전략** (공개 Nostr 릴레이를 시그널링에만 사용). 라이브러리는 런타임
  CDN 로드 금지 — 저장소에 벤더링(§4.2).
- **전송 암호화는 3중**: (1) WebRTC 기본 DTLS, (2) Trystero room password에 의한
  시그널링 암호화, (3) **이 문서가 정의하는 앱 계층 E2E 암호화(§6)**.
  (1)(2)가 있어도 (3)을 생략하지 않는다 — "누구도 열 수 없다"의 근거는 (3)이다.

## 4. 기술 스택 확정 (변경 금지)

- HTML5 + CSS + **바닐라 JavaScript (ES2020, ES Modules)**. 프레임워크 금지,
  TypeScript 금지, 번들러/빌드 도구 금지, npm 의존성 금지.
- 암호화: **브라우저 내장 WebCrypto (`crypto.subtle`)만 사용.** 외부 암호화
  라이브러리(libsodium 등) 금지.
- 저장소: **IndexedDB** (키·연락처·메시지). `localStorage`는 §8.3에 명시된
  1개 용도 외 금지.
- 외부 라이브러리는 **Trystero 단 하나**, 벤더링해서 사용.

### 4.2 Trystero 벤더링 절차

1. jsDelivr에서 nostr 전략 번들 파일을 내려받는다:
   `https://cdn.jsdelivr.net/npm/trystero@0.21.6/dist/trystero-nostr.min.js`
   (0.21.6이 존재하지 않으면 0.21.x 최신 패치 버전을 사용하고, 사용한 정확한
   버전을 `vendor/VERSION.txt`에 기록한다. 0.21.x 자체가 없으면 §14 규칙 A 적용.)
2. `vendor/trystero-nostr.min.js`로 저장하고 커밋한다.
3. 코드에서는 `import {joinRoom} from "../vendor/trystero-nostr.min.js"` 형태로만
   로드한다. 런타임에 CDN·외부 URL 로드 금지.

## 5. 파일 구조 확정

```
/                       (저장소 루트 = GitHub Pages 루트)
├── index.html          단일 페이지. 모든 화면(§9)이 <section>으로 존재
├── css/style.css
├── js/
│   ├── main.js         부팅, 화면 전환, 이벤트 바인딩 (오케스트레이션만)
│   ├── crypto.js       §6의 암호화 사양 구현 (WebCrypto 래퍼)
│   ├── net.js          §7의 Trystero 연결·핸드셰이크 상태기계
│   ├── store.js        §8의 IndexedDB 접근 계층
│   └── util.js         base64url·hex 변환, UTF-8 인코딩 헬퍼
├── vendor/
│   ├── trystero-nostr.min.js
│   └── VERSION.txt
├── icons/icon.svg      §10.3의 SVG 마크업 그대로
├── manifest.webmanifest
├── sw.js               서비스 워커 (§10.2)
├── PLAN.md             (이 문서)
└── README.md           설치·배포 방법 요약 (한국어)
```

모듈 간 의존 방향: `main.js → (net.js, store.js, crypto.js) → util.js`.
`crypto.js`·`store.js`·`net.js`는 DOM을 만지지 않는다.

## 6. 암호화 사양 (한 글자도 바꾸지 말 것)

### 6.1 인코딩 규약

- 바이너리 ↔ 문자열: **base64url, 패딩(`=`) 없음.** `util.js`에
  `bufToB64u(ArrayBuffer|Uint8Array): string`, `b64uToBuf(string): Uint8Array` 구현.
- 지문 표기: 소문자 hex.
- 문자열 → 바이트: 항상 UTF-8 (`new TextEncoder()`).

### 6.2 신원 키 (장기 키)

- 최초 실행 시 1회 생성:
  `crypto.subtle.generateKey({name:"ECDSA", namedCurve:"P-256"}, false, ["sign","verify"])`
  — `extractable:false` 고정. 개인키는 CryptoKey 객체 그대로 IndexedDB에 저장(§8.2).
- 공개키 직렬화: `crypto.subtle.exportKey("raw", publicKey)` → 65바이트 → base64url.
  이하 `idPub`라 부른다.
- **지문(fingerprint)**: `SHA-256(raw 공개키 65바이트)` → 64자 소문자 hex.
  이하 `fp`라 부른다. 연락처의 기본 키(primary key)로 사용.

### 6.3 초대코드 (친구 추가)

- 형식: `MD1.` + base64url( UTF-8( JSON `{"v":1,"name":<내 이름>,"pk":<idPub>}` ) )
- 파싱 규칙: 접두사가 `MD1.`이 아니거나, JSON 파싱 실패, `v !== 1`, `pk`를
  raw ECDSA P-256 공개키로 import 실패 → 오류 E01(§11).
- 친구 추가는 **상호 교환**이다: A가 B의 코드를 등록하고, B도 A의 코드를
  등록해야 대화방이 성립한다. 앱은 이를 §9.3 화면에서 안내한다.
- 초대코드는 비밀이 아니라 **공개키**다. 다만 진짜 상대의 코드인지가 보안의
  전제이므로, "신뢰할 수 있는 경로(직접 만나서, 이미 신뢰하는 채널)로
  교환하라"는 안내 문구를 표시한다(§9.7 S12).

### 6.4 방(room) 식별자

두 지문을 사전순 정렬해 유도한다 (양쪽에서 동일 값이 나온다):

```
roomId   = hex( SHA-256( UTF-8( "mildam-room-v1|" + min(fpA,fpB) + "|" + max(fpA,fpB) ) ) )   // 64자 hex
roomPw   = hex( SHA-256( UTF-8( "mildam-pw-v1|"   + roomId ) ) )                              // Trystero password
```

### 6.5 세션 수립 핸드셰이크 (연결할 때마다 새로 수행 — 전방 비밀성)

연결마다 임시(ephemeral) ECDH 키를 만들고 신원키로 서명해 교환한다.

1. 임시 키 생성:
   `crypto.subtle.generateKey({name:"ECDH", namedCurve:"P-256"}, false, ["deriveBits"])`
   → 공개키 raw export → base64url = `ephPub`.
2. 서명: `sig = base64url( ECDSA-SHA256.sign( idPriv, UTF-8("mildam-hs-v1|" + roomId + "|" + ephPub) ) )`
3. `hello` 메시지(§7.4) 송신: `{"t":"hello","v":1,"idPub":…,"ephPub":…,"sig":…}`
4. 수신 측 검증 (하나라도 실패 시 세션 중단 + 오류 E02):
   - `idPub`이 **저장된 연락처의 idPub과 바이트 단위로 완전히 동일**한가.
     (다르면 중간자 공격 가능성 — 절대 자동 갱신하지 않는다.)
   - `sig`가 그 `idPub`으로 검증되는가 (같은 문자열 `"mildam-hs-v1|"+roomId+"|"+ephPub` 대상).
5. 세션 키 유도 (양측 동일):
   ```
   secret  = ECDH.deriveBits( myEphPriv, peerEphPub, 256 )            // 256비트
   salt    = SHA-256( UTF-8( roomId + "|" + min(ephA,ephB) + "|" + max(ephA,ephB) ) )
             // ephA/ephB = 양측 ephPub의 base64url 문자열, 사전순 정렬
   hkdfKey = importKey("raw", secret, "HKDF", false, ["deriveKey"])
   sessKey = deriveKey({name:"HKDF", hash:"SHA-256", salt, info: UTF-8("mildam-msg-v1")},
                        hkdfKey, {name:"AES-GCM", length:256}, false, ["encrypt","decrypt"])
   ```
6. 세션 상태 초기화: `sendSeq = 0`, `recvSeq = 0`.

### 6.6 메시지 암호화

- 평문 페이로드: JSON `{"kind":"text","body":<본문 문자열>,"ts":<Date.now()>}`
- 송신 시 `sendSeq += 1` 후:
  ```
  iv  = crypto.getRandomValues(new Uint8Array(12))                       // 매번 새로
  aad = UTF-8( "mildam-msg-v1|" + roomId + "|" + myFp + "|" + sendSeq )
  ct  = AES-GCM.encrypt({iv, additionalData: aad}, sessKey, UTF-8(평문 JSON))
  ```
- 와이어 포맷(§7.4): `{"t":"msg","v":1,"seq":<sendSeq>,"iv":<b64u>,"ct":<b64u>}`
- 수신 측: `seq <= recvSeq`이면 **복호 없이 폐기**(리플레이 방지).
  AAD는 `상대 fp`와 수신한 `seq`로 재구성해 복호. 복호 실패(GCM 태그 불일치) 시
  해당 메시지 폐기 + 오류 E03 표시. 성공 시 `recvSeq = seq`.
- 수신 확인: 복호 성공 시 `{"t":"ack","v":1,"seq":<seq>}` 회신.
  송신 측은 ack 수신 시 해당 메시지 상태를 `sent → delivered`로 갱신(§8.2).

### 6.7 안전코드 (수동 검증)

```
safety = hex( SHA-256( UTF-8( "mildam-safety-v1|" + min(fpA,fpB) + "|" + max(fpA,fpB) ) ) )
```
64자 hex를 **8자씩 8그룹**으로 표시. 두 사람 화면에 같은 값이 떠야 정상.
§9.5 화면에서 표시만 한다(스캔·자동 비교 없음).

### 6.8 명시적 보안 규칙

- 개인키·세션키·평문을 `console.log`, 네트워크, `localStorage`에 절대 남기지 않는다.
- 모든 `generateKey`/`deriveKey`는 `extractable:false`.
- IV 재사용 금지(항상 `getRandomValues`). seq를 IV로 쓰지 않는다.
- 난수는 `crypto.getRandomValues`만. `Math.random` 금지.

## 7. 네트워킹 사양

### 7.1 라이브러리 사용 형태

```js
import {joinRoom} from "../vendor/trystero-nostr.min.js";
const room = joinRoom({appId: "mildam-v1", password: roomPw}, roomId);
const [sendE2e, onE2e] = room.makeAction("e2e");   // 액션은 "e2e" 단 하나
```
- 모든 앱 메시지(hello/msg/ack)는 `sendE2e(<JSON 문자열>)`로 보낸다.
- Trystero 기본 릴레이/STUN 설정을 그대로 쓴다(커스텀 릴레이 목록 지정 금지).

### 7.2 연결 정책

- 연락처마다 room 1개. **채팅방 화면에 들어가 있는 동안만** `joinRoom`하고,
  나가면 `room.leave()`. (모든 연락처에 상시 연결하지 않는다 — 배터리·릴레이 부하)
- `room.onPeerJoin` → 즉시 §6.5 핸드셰이크 시작(양측 모두 hello를 보낸다).
- `room.onPeerLeave` → 세션 폐기(`sessKey`, seq 초기화), UI 상태 `offline`.

### 7.3 연결 상태기계 (UI 표시용, §9.4)

```
idle → joining(room 참가 직후) → waiting(피어 없음) → handshaking(피어 있음, hello 교환 중)
     → secure(핸드셰이크 완료: 이때만 입력창 활성화) → offline(피어 이탈 → waiting으로 복귀 가능)
     오류 발생 시 → error(E02 등)
```
`secure`가 아닌 상태에서 전송 버튼은 비활성화한다. 큐잉·자동 재전송은 만들지 않는다.

### 7.4 와이어 메시지 3종 (이 외의 타입 금지)

| t | 방향 | 필드 |
|---|---|---|
| `hello` | 양방향, 세션당 1회 | `v`, `idPub`, `ephPub`, `sig` |
| `msg` | 양방향 | `v`, `seq`, `iv`, `ct` |
| `ack` | 수신→송신 | `v`, `seq` |

`v !== 1`이거나 알 수 없는 `t`는 조용히 폐기하고 `console.warn` 1줄만 남긴다.

## 8. 저장소 사양 (IndexedDB)

### 8.1 DB 정의

- DB 이름 `mildam`, 버전 `1`. 오브젝트 스토어 3개:

| 스토어 | keyPath | 내용 |
|---|---|---|
| `meta` | `k` | `{k:"identity", priv:<CryptoKey>, pub:<CryptoKey>, idPub:<b64u>, fp, name, createdAt}` 1건 |
| `contacts` | `fp` | `{fp, name, idPub, addedAt}` |
| `messages` | 자동 증가 `id` + 인덱스 `byContact`: `[fp, ts]` | `{fp, dir:"in"\|"out", body, ts, seq, status:"sent"\|"delivered"\|"received"}` |

### 8.2 규칙

- CryptoKey는 구조화 복제로 IndexedDB에 직접 저장한다(직렬화 시도 금지).
- 메시지 본문은 이 스토어에 평문 저장한다(**의도된 v1 결정** — 기기 잠금에
  의존. at-rest 암호화는 v2. 이 결정을 바꾸지 말 것).
- 수신 메시지는 복호 성공 직후, 송신 메시지는 send 직후 저장.

### 8.3 localStorage 허용 예외 (유일)

- `mildam.lastView`: 마지막으로 보던 화면 id 문자열. 이 외 일체 금지.

### 8.4 저장소 지속성

- 온보딩 완료 직후 `navigator.storage.persist()`를 1회 호출한다(결과는 무시하되
  `console.info`로 남긴다).

## 9. UI 사양

### 9.1 공통

- `index.html` 안에 5개 `<section>`: `#view-onboarding`, `#view-contacts`,
  `#view-add`, `#view-chat`, `#view-safety`. 화면 전환은 `hidden` 속성 토글.
- 언어: 한국어만. 모든 사용자 노출 문자열은 §9.7 표의 문구를 **그대로** 사용.
- 스타일: 다크 테마 고정. CSS 변수로:
  `--bg:#0f1420; --panel:#1a2233; --text:#e8ecf4; --muted:#8b94a7; --accent:#4f8cff; --danger:#ff5d5d;`
  폰트 `system-ui`, 최대 폭 `640px` 중앙 정렬, 터치 타깃 최소 44px.
  이 이상의 시각 디자인은 구현자 재량이되 **기능·문구·구조는 재량 아님**.

### 9.2 `#view-onboarding` (신원 없을 때만)

- 앱 이름 "밀담", 설명 S01, 이름 입력 `#ob-name`(1~20자, 공백만은 불가),
  버튼 `#ob-create` "시작하기".
- 완료 시: 신원 생성(§6.2) → meta 저장 → persist() → `#view-contacts`로.

### 9.3 `#view-add` (친구 추가)

- 상단: **내 초대코드** 읽기전용 `<textarea id="add-mycode">` + 버튼
  `#add-copy` "내 코드 복사" (`navigator.clipboard.writeText`, 성공 시 S13 토스트).
- 하단: 상대 코드 입력 `<textarea id="add-peercode">` + 버튼 `#add-submit` "친구 추가".
  파싱 성공 → contacts 저장 → S14 토스트 → 목록으로. 자기 자신 코드면 오류 E04.
  이미 있는 fp면 오류 E05. 안내 문구 S12 상시 표시.

### 9.4 `#view-contacts` / `#view-chat`

- 목록: 연락처 이름 + 마지막 메시지 미리보기(있으면). 항목 탭 → 채팅방.
  헤더에 `#nav-add` "＋ 친구 추가" 버튼. 연락처 0명이면 S11 표시.
- 채팅방: 헤더(상대 이름, 연결 상태 배지 — §7.3 상태를 S20~S25로 표기,
  `#chat-safety` "안전코드" 버튼, `#chat-back` 뒤로), 메시지 리스트(내 것 우측
  accent, 상대 좌측 panel, 시각 HH:MM, 내 메시지에 상태 ✓=sent ✓✓=delivered),
  하단 입력창 `#chat-input` + 전송 `#chat-send`(secure 상태에서만 활성).
  입장 시 히스토리를 `byContact` 인덱스로 로드해 시간순 표시.

### 9.5 `#view-safety`

- 상대 이름, §6.7 안전코드를 8자×8그룹 monospace로 표시, 설명 S30, 뒤로 버튼.

### 9.6 오류·토스트

- 화면 하단 토스트 `#toast` 하나로 통일(3초 후 자동 숨김). 오류는 §11 표의
  문구를 그대로 사용.

### 9.7 문자열 표 (그대로 사용)

| ID | 문구 |
|---|---|
| S01 | 서버 없이 기기끼리 직접 연결되는 종단간 암호화 메신저입니다. 대화 내용은 두 사람의 기기 밖으로 나가지 않습니다. |
| S11 | 아직 친구가 없습니다. ＋ 버튼으로 초대코드를 교환해 보세요. |
| S12 | 초대코드는 직접 만나서 또는 이미 신뢰하는 다른 채널로 교환하세요. 서로 상대의 코드를 등록해야 대화가 시작됩니다. |
| S13 | 코드가 복사되었습니다 |
| S14 | 친구가 추가되었습니다 |
| S20 | 연결 준비 중… |
| S21 | 상대를 기다리는 중… (두 사람 모두 이 방에 들어와 있어야 연결됩니다) |
| S22 | 보안 연결 수립 중… |
| S23 | 🔒 보안 연결됨 |
| S24 | 상대가 자리를 비웠습니다 |
| S25 | 연결 오류 |
| S30 | 두 사람의 화면에 같은 코드가 표시되면 대화가 도청·변조되지 않고 있다는 뜻입니다. 직접 만나거나 영상통화로 확인하세요. |

## 10. PWA 사양

### 10.1 manifest.webmanifest

```json
{"name":"밀담","short_name":"밀담","start_url":".","display":"standalone",
 "background_color":"#0f1420","theme_color":"#0f1420",
 "icons":[{"src":"icons/icon.svg","sizes":"any","type":"image/svg+xml","purpose":"any"}]}
```
`index.html` head에 manifest 링크, `theme-color` 메타, viewport
(`width=device-width, initial-scale=1, viewport-fit=cover`),
`apple-mobile-web-app-capable`/`apple-mobile-web-app-status-bar-style=black-translucent` 메타 포함.
(iOS 홈 화면 아이콘 PNG는 v1 미지원 — 한계로 README에 기록.)

### 10.2 sw.js

- 캐시 이름 `mildam-v1` (릴리스마다 숫자 증가). `install`에서 §5의 정적 파일
  전체를 precache, `activate`에서 이전 캐시 삭제 + `clients.claim()`,
  `fetch`는 same-origin GET에 한해 cache-first(미스 시 네트워크 후 캐시에 저장).
  cross-origin 요청은 서비스 워커가 건드리지 않는다.

### 10.3 icons/icon.svg (이 마크업 그대로)

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
| E01 | 초대코드 파싱/키 import 실패 | 초대코드 형식이 올바르지 않습니다 | 토스트만 |
| E02 | hello 검증 실패(키 불일치·서명 오류) | ⚠️ 상대 확인에 실패했습니다. 연결을 차단했습니다. 안전을 위해 다른 채널로 상대에게 확인하세요. | `room.leave()`, 상태 error |
| E03 | msg 복호 실패 | 메시지 하나를 해독하지 못해 버렸습니다 | 해당 메시지 폐기, 세션 유지 |
| E04 | 자기 코드 등록 시도 | 자기 자신은 추가할 수 없습니다 | 토스트만 |
| E05 | 중복 연락처 | 이미 추가된 친구입니다 | 토스트만 |
| E06 | WebCrypto/IndexedDB 미지원 브라우저 | 이 브라우저는 지원되지 않습니다. 최신 Chrome 또는 Safari를 사용하세요. | 부팅 중단, 전체 화면 안내 |

## 12. 구현 순서와 단계별 완료 기준 (이 순서대로 커밋)

| 단계 | 내용 | 완료 기준(전부 충족해야 다음 단계) |
|---|---|---|
| M0 | 골격: §5 파일 전부 생성, 화면 전환, manifest, sw, 벤더링 | 로컬 정적 서버로 열면 온보딩 화면 표시, Lighthouse에서 설치 가능 판정, 콘솔 오류 0 |
| M1 | crypto.js: §6.1~6.4·6.7 + store.js + 온보딩·친구 추가 | 두 브라우저 프로필에서 각각 신원 생성 → 코드 상호 등록 성공, 새로고침 후에도 신원·연락처 유지, roomId·안전코드가 양쪽에서 동일 |
| M2 | net.js: §6.5·§7 핸드셰이크 | 두 프로필이 같은 방에서 `secure` 도달, 한쪽 idPub을 임의 변조한 테스트에서 E02 발생 |
| M3 | 메시징: §6.6 + 채팅 UI + 히스토리 | 양방향 송수신, ✓→✓✓ 전환, 새로고침 후 히스토리 유지, seq 리플레이(같은 msg 재전송) 시 무시됨 |
| M4 | 안전코드 화면, 오류 처리 전체(§11), 미지원 브라우저 가드 | §13 체크리스트 전 항목 통과 |
| M5 | README 작성, GitHub Pages 활성화 안내 | README에 배포·사용법 기재 |

각 단계는 별도 커밋(메시지: `M0: …` 형식). 단계를 건너뛰거나 합치지 않는다.

## 13. 수동 테스트 체크리스트 (M4 완료 조건)

데스크톱 Chrome 일반 창 + 시크릿 창(또는 두 프로필)으로 수행:

1. 프로필 A·B 각각 온보딩 → 코드 교환 → 상호 추가
2. 양쪽 채팅방 진입 → 배지가 S21→S22→S23 순으로 변함
3. A→B, B→A 각 5개 메시지 왕복, 순서·시각·✓✓ 정상
4. B 새로고침 → A 배지 S24 → B 재진입 → 재연결 후 다시 S23, 대화 계속됨
5. A 새로고침 후 히스토리 남아 있음
6. 상대 코드 대신 자기 코드 입력 → E04, 깨진 문자열 → E01
7. DevTools Network에서 relay로 나가는 payload에 평문 본문이 없음을 확인
8. (모바일) 갤럭시 Chrome·아이폰 Safari에서 홈 화면 추가 후 1~5 재수행

## 14. 모호성 해결 규칙 (Sonnet 필독)

- **규칙 A**: 이 문서가 침묵하는 결정이 나오면, 임의로 정하지 말고 **작업을
  멈추고 사용자에게 질문**한다. 단, 아래 기본값 표에 있는 것은 질문 없이 표를 따른다.
- **규칙 B**: 이 문서와 외부 자료(라이브러리 문서 등)가 충돌하면, 보안 사양(§6)은
  이 문서가 이기고, 라이브러리 API 시그니처는 실제 라이브러리가 이긴다.
  후자의 경우 달라진 점을 커밋 메시지에 기록한다.
- **규칙 C**: "더 좋아 보이는" 기능·리팩터링·의존성 추가 금지. 비목표(§1.1)는
  요청받아도 이 브랜치에서 구현하지 않는다.

기본값 표: 타임스탬프 = `Date.now()` 밀리초 / 시각 표시 = 기기 로컬 24시간제
HH:MM / 이름 최대 20자 / 메시지 최대 2000자(초과 시 전송 버튼 비활성) /
토스트 3000ms / 정렬·비교 = 코드포인트 기준 `<`.

## 15. 금지사항 (위반 = 실패)

1. 자체 서버·서버리스 함수·DB·푸시 서비스·애널리틱스 등 **어떤 백엔드도 추가 금지**
2. 런타임 CDN/외부 URL 로드 금지 (Trystero가 접속하는 기본 릴레이·STUN 제외)
3. §6 암호화 알고리즘·파라미터·도메인 문자열(`mildam-…-v1`) 변경 금지
4. 프레임워크·번들러·npm 의존성·TypeScript 도입 금지
5. 개인키를 extractable로 만들거나 어떤 형태로든 export·전송·로그 금지
6. `Math.random` 사용 금지, IV 재사용 금지
7. 문자열 표(§9.7)·오류 문구(§11) 임의 수정 금지
8. TODO/스텁/주석 처리된 미완성 코드로 단계 완료 선언 금지
9. 이 브랜치 외 다른 브랜치에 푸시 금지
