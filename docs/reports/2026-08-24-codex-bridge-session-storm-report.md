# Codex Bridge / Session Spawn Storm Report

Date: 2026-08-24

## Executive summary

The memory explosion was not caused by Cloudflare directly. Cloudflare only forwarded requests to the local Codex Bridge. The first confirmed leak was repeated Codex quota spawning; after adding quota cache, single-flight, timeout, and exact Windows process-tree cleanup, production debug data showed that quota was no longer the dominant source.

The remaining production source was session creation: repeated `POST /sessions` requests spawned `codex.cmd app-server --stdio` processes without reuse or a hard cap. A controlled run reached 20 wrappers immediately and 25 wrappers after five seconds with no user task. The session protection implementation now reuses same-key sessions, caps anonymous session creation, and removes terminal/dead sessions from routing maps.

## Root cause chain

### Quota path

```text
dashboard quota polling
  -> GET /agent-quota
  -> readCodexQuota()
  -> spawn codex.cmd app-server --stdio
  -> Windows cmd.exe -> node.exe -> codex.exe
```

The old quota path spawned on every cache miss, had no single-flight, and called `child.kill()` on only the outer shell. This produced hundreds of orphaned descendants.

### Session path

```text
dashboard/session caller
  -> POST /sessions
  -> createCodexSession()
  -> spawn codex.cmd app-server --stdio
```

Every session request created a new app-server, even when the request represented the same logical session. The server had no stable-key reuse and no maximum session cap.

## Production evidence

During the first real controlled run:

- Codex Bridge PID: `47704`
- Direct `cmd.exe` app-server wrappers: `356`
- Quota spawn log events: `6`
- Quota success-cache hits: `207`
- Quota failure-cache hits: `198`
- Quota cleanup successes: `6`
- Quota cleanup failures: `0`

This separated the two problems: quota protection was working, while session creation was responsible for the remaining process storm.

The older uncontrolled run reached `707` quota wrapper processes before cleanup. Those were removed by targeting the exact Bridge PID and its exact direct wrapper PIDs with Windows tree termination. No global `codex.exe` kill was used.

## Implemented changes

### Quota lifecycle

Implemented in [codex-bridge.mjs](../../repos/jormungand/scripts/codex-bridge.mjs):

- Successful quota result cache, default TTL `60,000 ms`.
- Failure cooldown cache, default TTL `5,000 ms`.
- Module-level single-flight Promise for concurrent cache misses.
- Overall quota timeout, default `20,000 ms`.
- Pending JSON-RPC request/timer rejection on close, error, and timeout.
- Exact Windows process-tree cleanup using the spawned child PID.
- Awaited cleanup on quota, run cancel/timeout, session stop/delete, idle prune, and failed creation paths.
- Optional non-secret quota lifecycle logging through `CODEX_BRIDGE_QUOTA_DEBUG=1`.

### Session lifecycle

- Stable key derived from `sessionKey` or `threadId` plus resolved workspace path.
- Same-key in-flight creation reuse.
- Same-key live session reuse.
- `CODEX_BRIDGE_MAX_SESSIONS`, default `8`.
- Capacity overflow returns `429` before spawning a child.
- Key/session map rollback on failed creation.
- Terminal/dead sessions are removed from routing maps.
- Follow-up turns/resumes on inactive or deleted sessions return `404`.
- Existing exact-PID process-tree cleanup is reused.

## Test evidence

### Quota lifecycle suite

File: [codex-quota-lifecycle.test.ts](../../repos/jormungand/tests/codex-quota-lifecycle.test.ts)

Passed `4/4`:

- 25 concurrent quota requests produce one spawn.
- Requests inside the success TTL reuse cache.
- Failure bursts use the failure cooldown and later retry correctly.
- Hung quota reads time out and clean wrapper/grandchild processes.

### Session lifecycle suite

File: [codex-session-lifecycle.test.ts](../../repos/jormungand/tests/codex-session-lifecycle.test.ts)

Passed `4/4`:

- Same-key concurrent creation returns exactly `1 x 201` and `24 x 200`, with one session ID and one spawn.
- Deleted sessions are cleaned and reject later turn/resume requests.
- Child-exited sessions are unrouted and reject later turn/resume requests.
- No-key creation respects `CODEX_BRIDGE_MAX_SESSIONS=2` and returns `429` after capacity.

### Real controlled session test

With a real local Codex Bridge and a valid Bridge-owned `sessionKey`:

- Requests sent: `25`
- Responses: `1 x 201`, `24 x 200`
- Distinct session IDs: `1`
- Bridge working set before cleanup: approximately `46 MB`
- Bridge private memory before cleanup: approximately `54 MB`
- Bridge stopped after test
- Exact app-server wrapper count after cleanup: `0`

An earlier real test used an arbitrary `threadId`; Codex correctly rejected it because native thread IDs must already exist. The corrected real test used `sessionKey`, which is the proper Bridge-level deduplication input.

### Static/runtime checks

- `node --check scripts/codex-bridge.mjs`: passed.
- `npx tsc -p tsconfig.tests.json --pretty false`: passed.
- `npm run typecheck`: passed during session verification.
- Focused quota and session suites: passed.

## Current state

- Codex Bridge `4177`: stopped after controlled testing.
- Codex app-server wrappers: `0` after cleanup.
- Lucky/MiniMax `4198`: not stopped by the Codex session test.
- Cloudflare tunnel: not modified.

## Residual risks

- The full repository `npm test` suite was not the final acceptance gate; the focused quota/session suites and type checks were the verified gates.
- Session failed-start rollback is implemented but has less direct automated coverage than reuse, cap, delete, and child-exit paths.
- Full descendant-tree cleanup is guaranteed on Windows; non-Windows remains direct-child SIGTERM/SIGKILL behavior.
- The launcher header should additionally document `CODEX_BRIDGE_MAX_SESSIONS`, `CODEX_BRIDGE_SESSION_IDLE_TTL_MS`, and `CODEX_BRIDGE_SESSION_DEBUG`.
- Real sessions that require an existing native Codex thread should provide `threadId`; new Bridge-level sessions should use `sessionKey`.

## Operational recommendation

Start the Bridge only through [start-pokemon-center-server.ps1](../../repos/jormungand/scripts/start-pokemon-center-server.ps1) after deploying the changes. Keep `CODEX_BRIDGE_SESSION_DEBUG=1` enabled during the next short observation, then disable it once session-create/reuse/cap counts are confirmed stable.
