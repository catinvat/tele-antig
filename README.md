# Tele-Antig

> **Unofficial** third-party extension. Not affiliated with Google.

Telegram으로 Google Antigravity의 Agent Manager를 원격 제어하는 VS Code 확장 프로그램.

외출 중에도 Telegram 메시지 하나로 에이전트에게 코딩 작업을 시키고, 파일 변경/터미널 실행/에러 알림을 실시간으로 받을 수 있습니다.

## 설치

### 1. VSIX 다운로드

[최신 릴리스](https://github.com/catinvat/tele-antig/releases/latest)에서 `tele-antig-x.x.x.vsix` 다운로드

또는 직접 빌드:

```bash
git clone https://github.com/catinvat/tele-antig.git
cd tele-antig
npm install
npm run package
```

### 2. Antigravity에 설치

1. `Ctrl+Shift+P` → **Extensions: Install from VSIX...**
2. 다운로드한 `.vsix` 파일 선택
3. 리로드

## 초기 설정

### 1. Telegram 봇 생성

1. Telegram에서 [@BotFather](https://t.me/BotFather)에게 `/newbot` 전송
2. 봇 이름과 username 설정 (username은 `_bot`으로 끝나야 함)
3. 발급된 **봇 토큰**을 복사 (예: `123456789:ABCDefGhIjKlMnOpQrStUvWxYz...`)

### 2. 토큰 등록

Antigravity에서:

1. `Ctrl+Shift+P` → **Tele-Antig: Set Telegram Bot Token**
2. 복사한 봇 토큰 붙여넣기
3. 토큰은 OS 키체인에 암호화 저장됩니다 (settings.json에 노출되지 않음)

### 3. 토큰 테스트 (권장)

1. `Ctrl+Shift+P` → **Tele-Antig: Test Token**
2. 토큰 형식, 네트워크 연결, API 유효성을 한 번에 진단
3. 성공하면 봇 이름이 표시됨
4. 실패하면 원인별 안내 (잘못된 토큰 / DNS 실패 / 방화벽 차단 / 타임아웃)

### 4. 봇 시작 및 Chat ID 설정

1. `Ctrl+Shift+P` → **Tele-Antig: Start Telegram Bot**
2. Telegram에서 생성한 봇에게 `/start` 전송
3. 봇이 알려주는 **Chat ID**를 복사
4. Antigravity에서 `Ctrl+Shift+P` → **Tele-Antig: Set Allowed Chat ID** → Chat ID 입력
5. 다시 `/start` 전송하면 명령어 목록이 표시됨

이제 준비 완료!

## 사용법

### Telegram 명령어

| 명령 | 설명 |
|---|---|
| 일반 메시지 | 에이전트에게 프롬프트 전달 |
| `/start` | 연결 상태 확인 |
| `/new` | 새 대화 시작 |
| `/status` | 워크스페이스, 열린 파일, 터미널, 알림 상태 |
| `/accept` | 에이전트 스텝 수락 |
| `/reject` | 에이전트 스텝 거부 |
| `/quiet` | 중요 알림만 (권한 요청 + 에러) |
| `/mute` | 전체 알림 끄기 |
| `/unmute` | 전체 알림 켜기 |

### 알림 레벨

| 레벨 | 명령 | 받는 알림 |
|---|---|---|
| 🔔 전체 | `/unmute` | 파일 변경, 터미널, 에러, 권한 요청 등 모든 알림 |
| 🔕 중요만 | `/quiet` | 권한 요청 + 에러만 (파일 변경, 터미널 출력 생략) |
| 🔇 꺼짐 | `/mute` | 모든 알림 차단 |

`/quiet` 모드가 권장됩니다 — 에이전트가 권한을 요청하거나 에러가 발생할 때만 알림이 옵니다.

### 권한 요청 감지

에이전트가 작업 중 권한을 요청하면 (터미널 명령 실행, 브라우저 접근, 파일 접근 등) Telegram에 수락/거부 인라인 버튼이 자동으로 전송됩니다.

감지 방법:
1. **Context Key 폴링** (1차): Antigravity 내부의 `canAcceptOrRejectCommand` 등의 상태를 2초마다 확인
2. **Activity Stall 감지** (폴백): 에이전트 활동 후 12초간 정지 → 권한 요청 추정

### 실시간 알림

봇이 자동으로 아래 이벤트를 Telegram에 전송합니다:

- 📁 파일 생성/수정/삭제
- 💻 터미널 명령 실행 및 출력
- 🔴 코드 에러 발생
- ⚠️ 에이전트 권한 요청 (인라인 버튼으로 수락/거부 가능)

### Antigravity 명령어 (Ctrl+Shift+P)

| 명령 | 설명 |
|---|---|
| `Tele-Antig: Start Telegram Bot` | 봇 시작 |
| `Tele-Antig: Stop Telegram Bot` | 봇 정지 |
| `Tele-Antig: Set Telegram Bot Token` | 토큰 설정 |
| `Tele-Antig: Set Allowed Chat ID` | 허용 Chat ID 설정 |
| `Tele-Antig: Test Token` | 토큰 + 네트워크 진단 |
| `Tele-Antig: Test Send to Agent` | 에이전트 전송 테스트 |

### 자동 시작

Antigravity 실행 시 봇을 자동으로 시작하려면:

Settings → `teleAntig.autoStart` → `true`

## 트러블슈팅

### "Network request for 'getMe' failed!"

v0.1.3에서 해결됨. grammy의 `fetch()` API가 Antigravity 환경에서 차단되는 문제를
Node.js `https` 모듈로 교체하여 수정했습니다. 최신 버전으로 업데이트하세요.

### 봇 시작 실패

1. `Ctrl+Shift+P` → **Tele-Antig: Test Token** 실행
2. Output 패널(`Tele-Antig`)에서 상세 진단 결과 확인
3. 원인별 조치:
   - **토큰 형식 오류**: `@BotFather`에서 토큰을 다시 복사하여 Set Token
   - **토큰 유효하지 않음**: `@BotFather`에서 `/mybots` → 토큰 확인 또는 재발급
   - **DNS/네트워크 오류**: 인터넷 연결, 방화벽, VPN/프록시 확인
   - **타임아웃**: 네트워크 속도 또는 방화벽 문제

### Chat ID를 모르겠어요

1. 봇을 먼저 시작 (Chat ID 없이도 시작 가능)
2. Telegram에서 봇에게 `/start` 전송
3. 봇이 당신의 Chat ID를 알려줌 → 복사
4. `Ctrl+Shift+P` → **Set Allowed Chat ID** → 붙여넣기

## 보안

- **봇 토큰**: OS 키체인에 암호화 저장 (`SecretStorage` API)
- **접근 제어**: `allowedChatId`가 설정되면 해당 사용자만 봇 사용 가능. 미설정 시 모든 요청 차단
- **민감정보 마스킹**: 터미널 출력에서 API 키, 토큰, 비밀번호 등 자동 `[REDACTED]` 처리
  - GitHub, OpenAI, Slack, AWS, SSH 키, Telegram 봇 토큰 패턴 감지
- **인라인 버튼 인증**: 수락/거부 버튼도 Chat ID 인증 필수
- **Markdown 인젝션 방지**: 파일 경로, 터미널 출력 등 모든 사용자 데이터 이스케이프

## 작동 원리

```
Telegram 메시지
    ↓
grammy (long-polling, Node.js https transport)
    ↓
AntigravityBridge
    ↓
vscode.commands.executeCommand('antigravity.sendPromptToAgentPanel', text)
    ↓
Antigravity Agent Manager (Gemini)
    ↓
파일 변경 / 터미널 실행 / 에러 발생 / 권한 요청
    ↓
FileSystemWatcher / TerminalShellExecution / DiagnosticsListener / Context Key Polling
    ↓
Telegram 알림 (알림 레벨에 따라 필터링)
```

### 권한 요청 감지 원리

Antigravity 내부의 에이전트 스텝 상태:
- `StepStatus.WAITING = 9` → 권한 요청 대기 중
- Context Key: `antigravity.canAcceptOrRejectCommand` 등이 true로 전환
- 2초 주기로 Context Key 폴링하여 WAITING 상태 감지
- Context Key 읽기 불가 시 → 활동 정지 패턴으로 폴백 감지

Antigravity의 비공식 내부 명령을 사용하여 Agent Manager에 직접 연결합니다. 별도의 Gemini API 키가 필요 없습니다.

## 개발

```bash
# 의존성 설치
npm install

# 개발 빌드 (sourcemap 포함)
npm run build:dev

# 프로덕션 빌드 + VSIX 패키징
npm run package

# TypeScript watch 모드
npm run watch
```

### 프로젝트 구조

```
src/
  extension.ts   # 확장 진입점, 명령 등록, 토큰 검증
  bot.ts         # Telegram 봇 (grammy + https transport, 알림 레벨)
  bridge.ts      # Antigravity Agent 브릿지 (context key polling + stall detection)
  config.ts      # 설정 관리 (SecretStorage)
  explorer.ts    # 내부 명령 탐색 도구
```

## 제한사항

- Antigravity의 비공식 내부 명령에 의존하므로, Antigravity 업데이트 시 동작이 변경될 수 있습니다
- 에이전트의 텍스트 응답을 직접 캡처하는 API가 없어, 파일 변경/터미널 출력으로 작업 상태를 추적합니다
- 권한 요청 감지는 Context Key 폴링 또는 활동 패턴 분석 기반이므로 100% 정확하지 않을 수 있습니다
- Antigravity가 실행 중이고 워크스페이스가 열려 있어야 합니다

## 면책사항

- 이 프로젝트는 **AI(Claude)를 사용하여 생성**되었습니다. 코드에 예상치 못한 버그나 보안 취약점이 존재할 수 있습니다.
- Google Antigravity의 **비공식 내부 명령을 리버스 엔지니어링**하여 사용합니다. Google과 무관하며, 사용에 따른 책임은 사용자에게 있습니다.
- 프로덕션 환경에서 사용하기 전에 반드시 직접 코드를 검토하세요.
- 이슈나 버그를 발견하면 [Issues](https://github.com/catinvat/tele-antig/issues)에 제보해주세요.

## 라이선스

MIT
