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

Compile lifecycle tests:

```powershell
npm exec -- tsc -p tsconfig.tests.json
```

Expected:

- exit code `0`
- `.tmp-tests/tests/*.js` is generated

Run lifecycle red tests only:

```powershell
node --test .tmp-tests/tests/conversation-lifecycle-structure.test.js
```

Expected before implementation:

- tests fail because required lifecycle behavior is missing
- failures mention missing `conversationId`, missing new-conversation command, fixed Codex session scope, or fixed OpenClaw session-key derivation
- no syntax error, import error, or runtime crash unrelated to the missing feature

Service helper checks to implement and verify:

- `createConversationService(...).getUnboundConversation()` returns `conversationId`
- explicit new-conversation helper creates a fresh conversation ID and leaves the old transcript untouched
- `postCodexConversationMessage(...)` persists user and response entries under the caller-supplied `conversationId`
- `getCodexConversationState(...)` reads the session keyed by the supplied `conversationId`
- OpenClaw dispatch derives stable session identity from `conversationId + agentId`

### API and Cookie

Handler-level checks:

```powershell
node --test .tmp-tests/tests/conversation-lifecycle-structure.test.js
```

Expected after implementation:

- `GET /api/conversation` returns HTTP `200` and JSON with `conversationId`
- `POST /api/conversation/control` without `conversationId` returns HTTP `400`

Manual HTTP probes against local app:

```powershell
curl.exe -i http://127.0.0.1:3000/api/conversation
curl.exe -i -X POST http://127.0.0.1:3000/api/conversation/control -H "Content-Type: application/json" --data '{"action":"resume"}'
curl.exe -i -X POST http://127.0.0.1:3000/api/conversation -H "Content-Type: application/json" --data '{"conversationId":"conv-1","content":"hello","idempotencyKey":"msg-1","targetAgent":"codex"}'
```

Expected after implementation:

- `GET /api/conversation` => HTTP `200`, JSON contains `conversationId`, `entries`, `allowedAgents`
- control POST without `conversationId` => HTTP `400`, JSON `error` mentions `conversationId`
- message POST with valid `conversationId` => HTTP `200` or `202`, JSON echoes `conversationId` and includes `userEntry`

Cookie/header persistence checks:

```powershell
$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
Invoke-WebRequest http://127.0.0.1:3000/api/conversation -WebSession $session | Out-Null
$session.Cookies.GetCookies("http://127.0.0.1:3000")
```

Expected after implementation:

- one cookie or equivalent session header stores current conversation identity
- after `New conversation`, cookie value changes
- after page reload, the same cookie value yields the same `conversationId`

Explicit cookie-header check:

```powershell
curl.exe -i http://127.0.0.1:3000/api/conversation -H "Cookie: jormungand_conversation_id=conv-1"
```

Expected after implementation:

- JSON `conversationId` resolves to `conv-1` or returns a safe replacement if `conv-1` is invalid
- invalid cookie does not return HTTP `500`

### Codex Bridge

Mock bridge request assertions in node tests:

- `POST /sessions` returns `{ id, threadId, status, turnStatus, cursor }`
- `POST /sessions/{bridgeSessionId}/turns` receives the current message
- `GET /sessions/{bridgeSessionId}/events?after={cursor}` returns `{ events, nextCursor }`
- repository persists the session under the caller-supplied `conversationId`

Bridge smoke checks:

```powershell
curl.exe -i "$env:CODEX_BRIDGE_URL/health"
```

Expected:

- HTTP `200`
- JSON contains `protocolVersion`

Conversation-scoped bridge behavior to verify:

- a new conversation creates a new Codex bridge session
- a follow-up message in the same conversation reuses the same bridge session
- event polling reads only the requested conversation session

Control-path expectations after implementation:

- `Pause` => active conversation status becomes `paused`; transcript remains visible; no new assistant text is appended while paused
- `Continue` => same `conversationId` resumes the same bridge session and live events continue
- `Stop` => active session becomes `stopped` or terminal failure for that `conversationId`; a later fresh conversation must not resume the stopped session

### OpenClaw HTTP and A2A

Bridge mock assertions to verify during implementation:

- outbound HTTP payload includes `conversationId` or an equivalent stable session field
- A2A envelope or environment includes a stable session key derived from `conversationId + agentId`
- same conversation plus same OpenClaw agent repeats the same session key
- changing either conversation or agent changes the session key

HTTP bridge recovery probe:

```powershell
curl.exe -i "$env:OPENCLAW_BRIDGE_URL/health"
curl.exe -i "$env:OPENCLAW_BRIDGE_URL/agent-runs/by-idempotency/test-key"
```

Expected:

- `/health` => HTTP `200`, JSON includes `capabilities`
- unknown idempotency key => HTTP `404`
- known running or completed idempotency key => HTTP `200`

A2A verification during manual runs:

- capture bridge logs and verify the same `sessionKey` is reused when sending two messages in one conversation to the same OpenClaw agent
- switch to another OpenClaw agent and verify a different `sessionKey`
- start a fresh conversation with the same OpenClaw agent and verify a different `sessionKey`

### UI and Component

- `components/task-conversation.tsx`
  - shows a visible `New conversation` action
  - includes `conversationId` in fetches and state updates
  - keeps current transcript until operator explicitly starts a new conversation
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

Run and record:

```powershell
npm test
npm run typecheck
npm run lint
npm run build
```

Expected after implementation:

- `npm test` => exit code `0`
- `npm run typecheck` => exit code `0`
- `npm run lint` => exit code `0`
- `npm run build` => exit code `0`

Review diff scope and stage only Jormungand lifecycle files:

```powershell
git status --short
git diff --name-only --cached
```

Expected:

- only lifecycle test-plan, lifecycle tests, and intended feature files are staged
- unrelated worktree files are not staged

Confirm tracked test artifacts include:

- lifecycle test plan
- new unit or contract tests
- any implementation files added later in the feature branch

## Post-Deploy Gates

Health:

```powershell
curl.exe -i https://<deployment-host>/health
curl.exe -i https://<deployment-host>/api/agent-health
```

Expected:

- `/health` => HTTP `200`, JSON `{ "ok": true, "service": "jormungandr", ... }`
- `/api/agent-health` => HTTP `200` with bridge entries, or the configured protected status if auth policy requires it

Deployment readiness:

- Zeabur dashboard shows the latest deployment as `Ready` for the feature commit
- deployment logs show no boot failure, migration failure, or missing env error
- deployed responses reflect the new commit behavior and not a stale build

Basic Auth:

```powershell
$pair = '{0}:{1}' -f $env:JORMUNGAND_BASIC_AUTH_USER, $env:JORMUNGAND_BASIC_AUTH_PASS
$bytes = [System.Text.Encoding]::UTF8.GetBytes($pair)
$basicAuth = 'Basic {0}' -f [Convert]::ToBase64String($bytes)
curl.exe -i https://<deployment-host>/ -H "Authorization: $basicAuth"
curl.exe -i https://<deployment-host>/health -H "Authorization: $basicAuth"
```

Do not put real credentials directly on the command line. Use environment variables, a secret-backed header, or `Get-Credential`, and avoid writing secrets into shell history, CI logs, or screenshots.

Expected:

- `/` without credentials => HTTP `401` or the configured auth challenge
- `/` with valid credentials supplied through a header or secret-backed mechanism => HTTP `200`
- `/health` status matches the existing site-auth policy; if public, it remains public and returns JSON

## Browser Cases

### 1. Same Agent, Continuous Messages

Steps:

1. Open the app and authenticate.
2. Stay in the same conversation.
3. Send message A to Codex or one OpenClaw agent.
4. Wait for the response.
5. Send message B to the same agent without clicking `New conversation`.

Expected:

- both turns appear under the same visible conversation
- returned `conversationId` remains unchanged
- same-agent provider session is reused
- no transcript reset occurs

### 2. Switch Between Two OpenClaw Agents

Steps:

1. Start one conversation.
2. Send a message to `openclaw.rowlet`.
3. Send a follow-up in the same conversation to `openclaw.gengar`.
4. Send another message back to `openclaw.rowlet`.

Expected:

- one conversation transcript remains visible
- `conversationId` stays the same for all three turns
- Rowlet session key is reused for Rowlet turns only
- Gengar receives a different isolated session key
- agent-specific continuity does not leak across agents

### 3. Reload Preserves Current Conversation

Steps:

1. Create conversation history with at least two turns.
2. Reload the page.

Expected:

- same transcript reloads
- same `conversationId` is restored from server or cookie state
- active session state and allowed agents are consistent with the pre-reload state

### 4. New Conversation Isolates Old Content

Steps:

1. Create a conversation with visible prior turns.
2. Click `New conversation`.
3. Send a new message in the fresh conversation.
4. Inspect the old conversation through UI history or API response.

Expected:

- a fresh `conversationId` is created
- old transcript is not mixed into the new conversation
- new messages appear only in the new conversation
- old conversation remains intact and recoverable

### 5. Enter New Task or Bind Existing Conversation

Steps:

1. Stay in unbound mode and send a message that clearly identifies an existing project or run.
2. Allow Codex manager routing to bind.
3. Alternatively start a truly new task from the dashboard flow.

Expected:

- binding response identifies the selected project and workflow run
- transcript either moves or links according to the final implementation contract, without inconsistent duplication
- conversation identity after binding is explicit and observable
- starting a truly new task does not silently reuse an unrelated prior conversation

### 6. Codex Pause, Continue, Stop

Steps:

1. In an active Codex conversation, send a prompt that runs long enough to expose live controls.
2. Click `Pause`.
3. Click `Continue`.
4. Click `Stop`.

Expected:

- `Pause` sends a control request tied to the active `conversationId` and freezes live assistant progress for that conversation only
- `Continue` resumes the same bridge session for the same `conversationId`; no transcript reset occurs
- `Stop` terminates the active session for that `conversationId`; the UI reflects a stopped or terminal state and disables the previous live turn
- another conversation, if opened separately, is unaffected

### 7. Failure and Safety Paths

Steps:

1. Force or simulate a bridge failure.
2. Retry in the same conversation.
3. Test with invalid or stale conversation identity where possible.
4. Test unauthenticated or invalid Basic Auth access to protected routes.

Expected:

- failures surface on the active conversation only
- invalid conversation identity fails closed with clear error handling
- retry does not corrupt the prior transcript
- protected routes remain protected

## Test Evidence

- command output for unit, typecheck, lint, and build gates
- commit SHA for the verified feature branch
- browser screenshots or recordings for each browser case
- captured API responses showing `conversationId`, binding, and control behavior
- bridge logs or structured traces showing:
  - Codex session keyed by `conversationId`
  - OpenClaw session reuse for same conversation plus same agent
  - OpenClaw isolation for different agents or different conversations
- Zeabur deployment URL, deployment status, and health-check evidence

## Completion Criteria

- all lifecycle unit, contract, and integration tests pass
- `npm test`, `npm run typecheck`, `npm run lint`, and `npm run build` pass on the feature branch
- browser cases 1 through 7 are executed with recorded evidence
- deploy gates and post-deploy gates pass
- no fixed global conversation or session identity remains in Codex or OpenClaw lifecycle paths except where intentionally preserved for backward compatibility and explicitly documented
