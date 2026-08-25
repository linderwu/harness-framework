# Agent Output Routing Design

## Goal

Keep each agent's final response and live activity in the correct surface:

- OpenClaw `finalAssistantVisibleText` is the only assistant response persisted in Conversation.
- Lucky removes closed `<think>...</think>` blocks from Conversation output and publishes those blocks as `reasoning` Live Agent session events.
- Codex Live session activity remains visible for native conversations and becomes available for bound workflow conversations through the same live-event bus.

## Current findings

1. OpenClaw already prefers `finalAssistantVisibleText` for `output` and removes that field from response details. The remaining UI issue is that live panels are gated by `isUnbound`, so bound workflow conversations do not render the live activity surface.
2. Lucky writes provider records into a journal, but its records are not normalized into the `sequence`, `type`, `text`, and `delta` shape consumed by `agent-bridge.ts`. Its final `output` also currently preserves provider `<think>` markup.
3. Codex native session state is exposed by `lib/codex-conversation.ts`, but only unbound conversations return that state. Bound workflow conversation dispatches use the one-shot `/agent-runs` bridge path and currently do not publish live events because the relay only accepts OpenClaw agents and the invocation path does not pass `conversationId`.

## Design

### 1. Provider output contract

Keep the final Conversation body separate from live activity:

- `output` / `AgentArtifactResult.body` contains only visible assistant text.
- `reasoning` events contain provider reasoning or closed `<think>` content.
- `assistant_delta` events contain visible incremental text only.
- `details` may contain bounded diagnostics, but never `finalAssistantVisibleText`.

Lucky will emit normalized live journal records while preserving its existing journal fields for compatibility. Closed think blocks are extracted before the final response is returned.

### 2. Shared relay coverage

Generalize the bridge live relay from OpenClaw-only to bridge-backed agents (`openclaw.*`, `mavis`, and bound `codex`). Pass the active workflow/conversation ID from `ConversationService` through `hive-services.ts` into `invokeConfiguredAgent`, so the live bus can associate events with the visible conversation.

Codex one-shot runs will publish bounded lifecycle/output events through a new bridge event journal. This is observable process activity, not hidden chain-of-thought. Native Codex session events remain the source for unbound Codex conversations.

### 3. Conversation UI

- Render `Live Agent session` for bound and unbound bridge-backed agents.
- Keep the native `Codex Live session` panel for conversations that have a Codex native session.
- Do not let an OpenClaw/Lucky live preview hide a Codex native session panel.
- Open the SSE stream for bridge-backed Codex when the conversation is bound; keep native unbound Codex on its existing session polling path.
- Preserve responsive existing panel structure and bounded text behavior.

## Error handling and limits

- Malformed provider live records are ignored by the existing normalizer.
- Live polling remains best-effort and must not fail the final response.
- Lucky/Codex journal events inherit bounded event count/text limits.
- A missing or stale live stream leaves the final Conversation response intact and exposes the existing status/error state.

## Acceptance criteria

- OpenClaw final response contains `finalAssistantVisibleText` only; live details do not contain that field.
- Lucky final response never contains a closed `<think>...</think>` block, while the matching live stream contains a `reasoning` event with the think text.
- Bound OpenClaw and Lucky conversations render `Live Agent session` and show reasoning/visible deltas without duplicating final text into the response-details panel.
- Bound Codex conversation dispatch passes its conversation ID and renders live lifecycle/output activity.
- Unbound Codex native session panel remains visible with events, final text, and controls.
- Existing OpenClaw, Lucky, Codex session, conversation, typecheck, test, lint, and build checks pass.

## Scope exclusions

- No redesign of the conversation layout or new provider protocol.
- No exposure of hidden Codex chain-of-thought; only explicit observable bridge/session events are shown.
- No changes to workflow approval policy or agent permissions.
