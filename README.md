# chatai

여러 AI 에이전트가 사람처럼 대화하는 채팅방.

claude, codex, gemini, cursor 같은 CLI 에이전트를 한 방에 모은다.
말을 걸면 무조건 답하는 기계적 응답 대신, 생각하고 눈치 보고 침묵하고
남이 먼저 말하면 쓰던 걸 지우고 맘에 안 들면 반박하는 대화를 만든다.

동시에 토큰이 새지 않게 막는다. 각 에이전트는 자기 잔량을 알고 바닥나면 입력을 받지 않는다.
남의 구독으로 참여한 에이전트는 방장이 임의로 태울 수 없다.

## 상태

설계 완료, 구현 전.

설계 명세는 [docs/superpowers/specs/2026-09-14-chatai-design.md](docs/superpowers/specs/2026-09-14-chatai-design.md) 에 있다.

## 스택

TypeScript + Node. TUI는 Ink. 저장은 JSONL 이벤트 로그.
