# 밀담 도우미 — 맥북에어 설치 절차

이 도우미는 집에 있는 맥북에어(2013년형, macOS 11)에서 상시 실행합니다.
하는 일은 딱 두 가지뿐입니다: **① 새 암호문이 도착하면 내용 없는 푸시 알림
보내기, ② 암호문을 30일간 보관·재발행**해서 상대가 아주 오래 접속하지
않아도 메시지가 유실될 확률을 낮추는 것. 대화 내용을 복호화할 키가 없으므로
도우미는 원천적으로 대화 내용을 볼 수 없습니다.

도우미는 바깥 방향 연결(공개 릴레이 구독, 푸시 게이트웨이로 발송)만
사용합니다. 공유기 포트포워딩, 도메인, 인증서, 고정 IP는 전혀 필요 없습니다.

## 1. Node.js 설치

[nodejs.org](https://nodejs.org)에서 **Node 20 LTS macOS x64 `.pkg`** 설치
파일을 받아 설치합니다. (macOS 11을 지원하는 버전입니다. Apple Silicon용이
아니라 Intel(x64)용을 받으세요 — 2013년형 맥북에어는 인텔 칩입니다.)

터미널에서 확인:

```
node --version   # v20.x.x 가 나오면 성공
```

## 2. 도우미 실행

```
cd helper
npm install
node helper.mjs
```

처음 실행하면 화면에 이런 형태의 **도우미 코드**가 출력됩니다:

```
========================================================
도우미 코드 (밀담 앱의 설정 → 도우미 등록에 붙여넣으세요):
MDH1.eyJ2IjoxLCJwayI6Ii4uLiJ9
========================================================
```

이 코드를 **두 사람의 폰**에서 밀담 앱 → 설정 → "도우미 코드" 입력란에
붙여넣고 "도우미 등록"을 누른 뒤, "알림 켜기"를 누르세요. 도우미 코드는
실행할 때마다 같은 값이 다시 출력되므로(신원이 `state/` 폴더에 저장되어
유지됩니다), 이후 재부팅 시에는 다시 등록할 필요가 없습니다.

## 3. 맥이 잠들지 않도록 설정

도우미는 맥이 켜져 있고 화면이 잠들지 않을 때만 동작합니다(화면이 꺼지는
것 자체는 상관없지만, **시스템 절전 모드로 들어가면** 도우미 프로세스가
멈춥니다).

1. **시스템 환경설정 → 배터리(또는 전원 어댑터)**에서 "디스플레이가 꺼져
   있을 때 컴퓨터 자동 잠자기 방지"를 켭니다.
2. 터미널에서 다음 명령으로 절전을 완전히 꺼둡니다:
   ```
   sudo pmset -a sleep 0
   ```
3. **뚜껑은 열어두세요.** 화면 밝기만 최소로 낮추면 됩니다 — 노트북 뚜껑을
   닫으면 위 설정과 무관하게 잠들 수 있습니다.
4. 전원 어댑터를 항상 연결해두고, 와이파이도 상시 연결 상태로 둡니다.

## 4. 재부팅해도 자동으로 다시 시작하게 설정

`~/Library/LaunchAgents/com.mildam.helper.plist` 파일을 아래 내용으로
만듭니다(`/절대/경로/여기`는 실제로 `helper` 폴더를 둔 경로로 바꾸세요):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.mildam.helper</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/절대/경로/여기/helper/helper.mjs</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/절대/경로/여기/helper</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/절대/경로/여기/helper/state/out.log</string>
  <key>StandardErrorPath</key>
  <string>/절대/경로/여기/helper/state/err.log</string>
</dict>
</plist>
```

`/usr/local/bin/node`는 `which node`로 실제 경로를 확인해 바꿔 넣으세요.
그 다음 등록합니다:

```
launchctl load ~/Library/LaunchAgents/com.mildam.helper.plist
```

이제 맥을 재시작해도 도우미가 자동으로 다시 켜집니다. `RunAtLoad` + `KeepAlive`
덕분에 프로세스가 죽어도 자동으로 재시작됩니다.

## 5. 중요한 주의사항

- **macOS 11(Big Sur)은 보안 업데이트가 종료된 OS**입니다. 이 맥북은
  도우미 전용으로만 쓰고, 평소 웹서핑이나 다른 계정 로그인 등 다른 용도로
  병행 사용하지 마세요. 도우미 자체는 대화 내용을 볼 수 없는 키를 쓰지만,
  구형 OS로 다른 작업까지 하는 것은 별개의 위험입니다.
- 도우미가 꺼져 있어도 **메시징 자체는 계속 정상 동작**합니다(공개
  릴레이로 바로 오가므로). 다만 그동안은 알림이 오지 않습니다.
- 알림에는 발신자·내용이 전혀 표시되지 않습니다("새 메시지가
  도착했습니다"만 뜹니다) — 도우미가 애초에 암호문만 볼 수 있기 때문입니다.
- 이 폴더의 `state/`는 도우미의 신원 키, VAPID 키, 등록된 사용자의 푸시
  구독 정보, 30일치 암호문 백업을 담습니다. 다른 사람과 공유하거나
  깃에 올리지 마세요(이미 `.gitignore`로 제외되어 있습니다).
