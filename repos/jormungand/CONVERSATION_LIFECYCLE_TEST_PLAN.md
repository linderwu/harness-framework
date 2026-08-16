# Conversation Lifecycle Test Plan

## Scope

This plan covers the Jormungand conversation lifecycle change set requested for the conversation-first workflow:

- Add a visible `New conversation` flow in the UI.
- Keep all messages in the same conversation until the operator explicitly starts a new conversation or the system binds into a new task.
- Reuse provider sessions for the same conversation plus the same OpenClaw agent.
- Isolate provider sessions across different OpenClaw agents.
- Key Codex session state by conversation ID instead of a fixed global unbound identifier.

This plan supplements the existing `REMOTE_CODEX_CONVERSATION_TEST_PLAN.md` and does not replace it.

## Test Goals

- Prove that conversation identity is explicit, durable, and observable from UI through API and bridge layers.
- Prove that the `New conversation` action creates a fresh conversation without mutating or erasing prior transcript state.
- Prove that session reuse follows the intended contract:
  - same conversation + same OpenClaw agent => same provider session
  - same conversation + different OpenClaw agent => isolated session
  - Codex session => keyed by conversation ID
- Prove that reload, task binding, pause/continue/stop, and failure paths preserve the correct conversation/session association.

## Risks

- High: fixed `global:unbound-conversation` and fixed Codex session ID can leak state between unrelated operator threads.
- High: OpenClaw HTTP or A2A session keys derived from synthetic workflow IDs can fragment continuity or merge unrelated turns.
- High: UI may show one transcript while backend or bridge state is attached to another session identity.
- Medium: cookies or persisted client state may not survive reload or may accidentally start a new conversation.
- Medium: task binding may move or duplicate entries incorrectly when an unbound conversation becomes task-bound.
- Medium: Codex control actions may target the wrong session when multiple conversations exist.
- Medium: regressions in existing unbound conversation, task conversation, or bridge health flows.

## Environment Preconditions

- Worktree is based on commit `90d95c8`.
- Baseline remains green before lifecycle implementation:
  - `npm test`
  - `npm run typecheck`
  - `npm run lint`
- Required env/config available for integrated verification:
  - `CODEX_BRIDGE_URL`
  - `OPENCLAW_BRIDGE_URL` or `OPENCLAW_A2A_COMMAND`
  - bridge auth tokens when non-loopback
  - Zeabur deployment target and Basic Auth credentials
- Browser verification can access the deployed site and authenticated routes.
- Test data includes at least:
  - Codex
  - two OpenClaw agents, preferably `openclaw.rowlet` and `openclaw.gengar`

## Test Layers

### Unit and Service

- `lib/conversation.ts`
  - creates a fresh conversation identifier on explicit new-conversation action
  - keeps existing conversation identifier when posting normal follow-up messages
  - preserves same conversation across multiple unbound turns before binding
  - binds or moves conversation only when manager decision explicitly targets a run
  - rejects invalid or cross-run conversation IDs
- `lib/codex-conversation.ts`
  - keys session persistence by `conversationId`
  - does not read or write only one fixed global conversation ID
  - pause, resume, and stop operate on the requested conversation session
- `lib/agent-bridge.ts`
  - supplies stable conversation identity into OpenClaw HTTP and A2A paths
  - derives OpenClaw session key from conversation identity plus agent identity
  - reuses session key for same conversation plus same agent
  - isolates session key across agents
- `lib/hive-services.ts`
  - routes unbound and bound flows without collapsing all traffic into one global conversation

### API and Cookie

- `app/api/conversation/route.ts`
  - `GET` returns current `conversationId`
  - `POST` accepts current `conversationId`
  - `POST` supports explicit new-conversation creation flow
  - response returns `conversationId`, any updated binding, and visible transcript
- `app/api/conversation/control/route.ts`
  - requires or forwards `conversationId` for Codex controls
  - cannot operate only against a fixed global session
- Cookie/session persistence
  - current conversation survives reload
  - new conversation rotates the persisted conversation identifier
  - stale or invalid cookie fails closed to a safe fresh conversation

### Codex Bridge

- Codex bridge session creation is per `conversationId`
- event polling reads only the requested conversation session
- pause, continue, and stop target only that conversation session
- stopped or failed sessions do not poison new conversation startup

### OpenClaw HTTP and A2A

- HTTP bridge accepts stable caller-supplied conversation identity or session key input
- A2A path accepts stable caller-supplied session key input
- same conversation plus same OpenClaw agent reuses provider session
- different agent in same conversation gets separate session key
- different conversation with same agent gets separate session key
- idempotency recovery still works with stable conversation identity

### UI and Component

- `components/task-conversation.tsx`
  - shows a visible `New conversation` action
  - includes `conversationId` in fetches and state updates
  - keeps current transcript until operator explicitly starts new conversation
  - preserves current conversation on reload
  - updates visible controls based on the active conversation session
- `components/harness-dashboard.tsx`
  - passes initial conversation ID/state into task conversation
  - preserves selected conversation after refresh
  - handles task binding without losing previous conversation history

### Regression

- existing unbound conversation behavior still works for one continuous thread
- existing task-bound conversation routes still work
- manager binding parser still rejects invented targets
- bridge health, quotas, and dashboard status continue to render
- existing Codex control UI still works for the active conversation
- existing OpenClaw idempotency recovery remains intact

## Pre-Deploy Gates

- Run and record:
  - `npm test`
  - `npm run typecheck`
  - `npm run lint`
  - `npm run build`
- Review diff scope and stage only Jormungand lifecycle files.
- Do not stage unrelated worktree changes.
- Confirm tracked test artifacts include:
  - lifecycle test plan
  - new unit/structural tests
  - any implementation files added later in the feature branch

## Post-Deploy Gates

- Health
  - `GET /health` returns success
  - bridge health panel shows expected bridge readiness
- Deployment readiness
  - latest Zeabur deployment is complete and serving the expected commit
  - no boot-time errors in deployment logs
- Basic Auth
  - protected application routes require valid Basic Auth
  - public health route remains reachable only where intended by existing site-auth rules

## Browser Cases

### 1. Same Agent, Continuous Messages

Steps:
1. Open the app and authenticate.
2. Stay in the same conversation.
3. Send message A to Codex or one OpenClaw agent.
4. Wait for the response.
5. Send message B to the same agent without clicking `New conversation`.

Expected:
- Both turns appear under the same visible conversation.
- Returned `conversationId` remains unchanged.
- Same-agent provider session is reused.
- No transcript reset occurs.

### 2. Switch Between Two OpenClaw Agents

Steps:
1. Start one conversation.
2. Send a message to `openclaw.rowlet`.
3. Send a follow-up in the same conversation to `openclaw.gengar`.
4. Send another message back to `openclaw.rowlet`.

Expected:
- One conversation transcript remains visible.
- `conversationId` stays the same for all three turns.
- Rowlet session key is reused for Rowlet turns only.
- Gengar receives a different isolated session key.
- Agent-specific continuity does not leak across agents.

### 3. Reload Preserves Current Conversation

Steps:
1. Create conversation history with at least two turns.
2. Reload the page.

Expected:
- Same transcript reloads.
- Same `conversationId` is restored from server/cookie state.
- Active session state and allowed agents are consistent with pre-reload state.

### 4. New Conversation Isolates Old Content

Steps:
1. Create a conversation with visible prior turns.
2. Click `New conversation`.
3. Send a new message in the fresh conversation.
4. Navigate back to inspect prior conversation if the UI provides history, or verify via API/devtools response.

Expected:
- A fresh `conversationId` is created.
- Old transcript is not mixed into the new conversation.
- New messages appear only in the new conversation.
- Old conversation remains intact and recoverable if history access exists.

### 5. Enter New Task or Bind Existing Conversation

Steps:
1. Stay in unbound mode and send a message that clearly identifies an existing project/run.
2. Allow Codex manager routing to bind.
3. Alternatively start a truly new task from the dashboard flow.

Expected:
- Binding response identifies the selected project and workflow run.
- Transcript either moves or links according to the final implementation contract, but does not duplicate inconsistently.
- Conversation identity after binding is explicit and observable.
- Starting a truly new task does not silently reuse an unrelated prior conversation.

### 6. Codex Pause, Continue, Stop

Steps:
1. In an active Codex conversation, send a prompt that runs long enough to expose live controls.
2. Click `Pause`.
3. Click `Continue`.
4. Click `Stop`.

Expected:
- Each control call targets the active conversation’s Codex session.
- UI status updates reflect paused, resumed, and stopped states.
- Another conversation, if opened separately, is unaffected.

### 7. Failure and Safety Paths

Steps:
1. Force or simulate a bridge failure.
2. Retry in the same conversation.
3. Test with invalid or stale conversation identity where possible.
4. Test unauthenticated or invalid Basic Auth access to protected routes.

Expected:
- Failures surface on the active conversation only.
- Invalid conversation identity fails closed with clear error handling.
- Retry does not corrupt prior transcript.
- Protected routes remain protected.

## Test Evidence

- Command output for unit, typecheck, lint, and build gates
- Commit SHA for the verified feature branch
- Browser screenshots or recordings for each browser case
- Captured API responses showing `conversationId`, binding, and control behavior
- Bridge logs or structured traces showing:
  - Codex session keyed by `conversationId`
  - OpenClaw session reuse for same conversation plus same agent
  - OpenClaw isolation for different agents or different conversations
- Zeabur deployment URL, deployment status, and health check evidence

## Completion Criteria

- All lifecycle unit/structural/integration tests pass.
- `npm test`, `npm run typecheck`, `npm run lint`, and `npm run build` pass on the feature branch.
- Browser cases 1 through 7 are executed with recorded evidence.
- Deploy gates and post-deploy gates pass.
- No fixed global conversation/session identity remains in Codex or OpenClaw lifecycle paths except where intentionally preserved for backward-compatibility and explicitly documented.
