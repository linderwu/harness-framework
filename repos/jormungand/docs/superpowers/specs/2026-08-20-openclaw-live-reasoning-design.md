# OpenClaw Live reasoning preview 設計

## 目標

讓 Jormungand 的 Live Agent session 能在 OpenClaw 執行期間接收並顯示即時活動；如果 OpenClaw bridge 或模型實際提供 reasoning frame，則以可折疊的 reasoning preview 顯示。沒有 reasoning frame 時，仍顯示 working、tool、assistant delta、completed 與 failed 等安全狀態。

## 範圍

### 包含

- 建立跨 Codex/OpenClaw 的 server-side live event contract。
- OpenClaw bridge 保存短期、bounded 的 run event journal，並提供以 idempotency key 查詢的事件 endpoint。
- Jormungand server 在 OpenClaw request 執行期間輪詢 bridge events，轉發到 conversation SSE stream。
- Live conversation UI 支援 OpenClaw agent，顯示活動、即時 assistant text 與 opt-in reasoning preview。
- reasoning frame 的 parser 支援結構化 `reasoning`/`thinking` 欄位與封裝的 `<think>` 內容，但不把任意 stdout 當作 reasoning 顯示。
- bridge 不支援事件時的安全 fallback：只顯示 working/completed/failed。

### 不包含

- 不讀取 `~/.openclaw` 私有 state、SQLite、transcript 或 cache files。
- 不宣稱可取得模型未輸出的完整內部 chain-of-thought。
- 不新增 npm dependency；沿用現有 HTTP、SSE 與 child-process transport。
- 不把 reasoning 預設持久化到 Hive memory 或 conversation transcript。
- 不修改 Codex bridge 的既有 session 行為。

## 架構

```text
Browser Live Agent panel
        │ EventSource
        ▼
/api/conversation/live
        │ in-process event bus
        ▼
invokeConfiguredAgent(OpenClaw)
        │ bounded polling by idempotency key
        ▼
OpenClaw bridge /agent-runs/by-idempotency/:key/events
        │ short-lived event journal
        ▼
openclaw agent --json stdout parser
```

Live event contract：

```ts
type AgentLiveEvent = {
  id: string
  sequence: number
  conversationId: string
  agentId: AgentKind
  type: "started" | "status" | "tool" | "assistant_delta" | "reasoning" | "completed" | "failed"
  message?: string
  text?: string
  delta?: string
  createdAt: string
  metadata?: { runId?: string; source?: string; phase?: string }
}
```

The event bus keeps only a bounded recent window per conversation and removes idle channels after completion. The SSE route sends a ready frame, replays the bounded snapshot, then streams new events. The browser closes the stream after completed or failed.

## OpenClaw event handling

The bridge emits a started event before spawning the child and completed/failed after exit. During stdout processing it parses complete JSON lines when present. Reasoning is accepted only from explicit structured fields (`reasoning`, `thinking`, `reasoning_content`, or a typed thinking stream) or a closed `<think>...</think>` block. Arbitrary logs, shell output, prompts, tool arguments, and stderr are never sent as reasoning text.

If a deployed OpenClaw version exposes Gateway `agent`/session events later, that adapter can feed the same bridge event journal without changing the app or UI contract. The current CLI path remains compatible and honest about its limits.

## UI behavior

- Rename the panel conceptually to Live Agent session while preserving existing Codex controls and behavior.
- OpenClaw sends open an EventSource before the POST request so events can arrive while the request is still running.
- Reasoning is hidden by default behind a disclosure control and is labeled `Reasoning preview`.
- Status/tool events remain visible in the normal activity list.
- If the browser reconnects, the SSE route replays only the bounded recent window; no transcript backfill is promised for old reasoning.
- On bridge 404/timeout/event incompatibility, the UI remains usable and shows a status fallback instead of an erroring panel.

## Security and limits

- The live route requires the existing conversation identity and only publishes events keyed to that conversation.
- Event text is bounded before publication; each event and each conversation window has a size limit.
- Reasoning is treated as sensitive operator-visible data, not durable memory.
- No bridge token, prompt, raw tool arguments, stderr, or private OpenClaw storage path is emitted to the browser.
- Event sequence numbers are monotonic per conversation; duplicate or regressed bridge events are ignored.

## Testing and acceptance

- Unit tests prove event normalization, reasoning extraction, size limits, sequence monotonicity and fallback behavior.
- Bridge source tests prove the events endpoint, bounded journal and cleanup hooks exist without requiring Docker/OpenClaw.
- API tests prove SSE framing, conversation scoping and terminal closure semantics.
- UI structure/behavior tests prove OpenClaw live events and reasoning disclosure render without breaking Codex controls.
- Run project test, typecheck, lint and production build before integration.

