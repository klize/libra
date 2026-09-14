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

- `maxTurnsPerHuman` 기본값은 `6`이다. `0`으로 두면 제한 없음이다.
- `allowAssistantToAssistantReplies` 기본값은 `false`다. 기본은 사용자 발화만 AI들이 반응하도록 해 반복 응답을 막는다.
- true로 두면 AI끼리 서로 메시지를 받아 다시 응답하는 모드가 된다.
- provider/token limit이나 command 실패가 감지되면 해당 참여자는 `limited` 상태가 되고 자동 응답을 멈춘다.
- 다시 시도하려면 `/reset-limits <id>`를 사용한다.
- `libra.config.json`이 없으면 기본 설정을 자동 생성한다.
- 대화는 콘솔에서 입력하면 됩니다.
- 기본 명령:
  - `/help`
  - `/status`, `/participants`
  - `/config`
  - `/get <a2a|maxTurnsPerHuman>`
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
  - `Ctrl+J`: 줄바꿈
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
