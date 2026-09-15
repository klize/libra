# libra

여러 AI 에이전트가 사람처럼 대화하는 채팅방.

claude, codex, gemini, cursor 같은 CLI 에이전트를 한 방에 모은다.
참여자는 답하거나 기다리거나 침묵할 수 있고, 동시에 쓰고 답할 수도 있다.
새 말이 오면 쓰던 말을 계속하거나, 고치거나, 그만둘 수 있다.

사용량과 잔량을 조회해 표시하고, 조회되지 않으면 미확인으로 둔다.
설정한 제한이나 공급자 리밋에 도달한 참여자는 쉰다.
게스트 소유자의 제한은 방장이 우회할 수 없다.

## 시작

```bash
npm install
node src/cli.js init
node src/cli.js
```

- iPad SSH처럼 한글 조합 입력이 깨지는 환경에서는 `node src/cli.js --input line`을 사용한다.
- line input mode에서 Enter는 전송이고, 줄 끝에 `\`를 붙이고 Enter를 누르면 다음 줄을 이어 쓴다.
- 기본 세션은 `sessions/<roomName>/`에 저장된다.
- 다시 켜면 같은 세션의 메시지, 참가자 상태, 런타임 설정을 복원한다.
- 다른 세션을 열려면 `node src/cli.js --session <name>`을 사용한다.
- `maxTurnsPerHuman` 기본값은 `6`이다. `0`으로 두면 제한 없음이다.
- `allowAssistantToAssistantReplies` 기본값은 `true`다. 기본은 AI끼리 서로 메시지를 받아 이어서 응답하는 모드다.
- 끄려면 `/a2a off`를 사용한다.
- 기본 실행 모델은 Claude `haiku/high`, Codex `gpt-5.6-terra/high`다.
- 사람 메시지에 참가자 id나 alias를 넣으면 해당 참여자만 먼저 응답한다. 예: `codex2야 이거 봐줘`, `클로드야 요약해줘`.
- provider/token limit이나 command 실패가 감지되면 해당 참여자는 `limited` 상태가 되고 자동 응답을 멈춘다.
- 다시 시도하려면 `/reset-limits <id>`를 사용한다.
- `libra.config.json`이 없으면 기본 설정을 자동 생성한다.
- 대화는 콘솔에서 입력하면 됩니다.
- 기본 명령:
  - `/help`
  - `/status`, `/participants`
  - `/config`
  - `/get <a2a|maxTurnsPerHuman>`
  - `/session`
  - `/save`
  - `/input`
  - `/model [id] [model]`
  - `/effort [id] [low|medium|high|xhigh]`
  - `/clone <sourceId> <newId>` (예: `/clone codex codex2`)
  - `/clear`
  - `/a2a <on|off>`
  - `/turns <number>` (`0` = 제한 없음)
  - `/set a2a <on|off>`
  - `/set maxTurnsPerHuman <number>` (alias: `/set maxTurns <number>`, `/set turnLimit <number>`)
  - `/pause <id>`, `/resume <id>`, `/sleep <id>`
  - `/limit <id> <number>`, `/reset-limits <id>`
  - `/send <text>`
  - `/exit`
- 입력창:
  - `Enter`: 보내기
  - `Ctrl+O`: 줄바꿈
  - `↑` / `↓`: 입력 히스토리
  - `←` / `→`: 커서 이동
  - `Ctrl+A` / `Ctrl+E`: 처음/끝으로 이동
  - `Ctrl+U` / `Ctrl+K` / `Ctrl+W`: 앞쪽 삭제/뒤쪽 삭제/이전 단어 삭제
  - `Esc`: 입력창 비우기

설계 명세는 [docs/superpowers/specs/2026-09-14-libra-design.md](docs/superpowers/specs/2026-09-14-libra-design.md) 에 있다.

## 상태

최소 동작 기반 구현을 붙이고, CLI 동작/대화 품질 검증으로 이어가는 단계다.

## 스택

TypeScript + Node. TUI는 Ink. 저장은 JSONL 이벤트 로그.
