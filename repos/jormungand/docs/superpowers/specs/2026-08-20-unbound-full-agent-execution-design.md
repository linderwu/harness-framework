# Unbound Full Agent Execution

## Status

Approved design for implementation planning.

## Goal

Allow an unbound conversation to dispatch directly to its selected Codex or
OpenClaw agent with the same operator-approved full execution scope used by
the configured bridge. Unbound conversations must be able to run external
commands, write ingestion artifacts, and perform other workflow-independent
operations without first binding to a project or workflow run.

## Current behavior

`routeOpenClawUnboundConversation` creates the `conversation.unbound_limited`
skill. That skill explicitly prohibits external systems and irreversible
actions and declares the conversation read-only. The Codex branch of
`routeUnbound` instead invokes a conversation manager that must choose or
decline a project/workflow binding before the requested agent can act.

This makes the unbound conversation useful for guidance but prevents local
ingestion workflows such as `yt-dlp`, Whisper transcription, and writing to
`raw/` or `wiki/`.

## Proposed behavior

### Direct dispatch

`routeUnbound` will use one direct-dispatch path for both Codex and OpenClaw:

1. Persist the operator message and derive the existing per-agent conversation
   history delta.
2. Create a synthetic, unbound run identity only as an invocation envelope;
   it must not represent a project binding or workflow approval state.
3. Invoke the selected agent directly with the conversation content/history.
4. Mark the history cursor delivered only after the bridge reports success.
5. Persist the response and audit information using the existing conversation
   lifecycle.

The dispatch skill will replace `conversation.unbound_limited` with an
unbound full-execution skill whose purpose and constraints do not prohibit
external commands, file writes, or irreversible actions. It will still carry
the operator's requested scope and the normal runtime identity so the agent
knows which conversation initiated the action.

### Permission behavior

The existing `JORMUNGAND_AGENT_PERMISSION_MODE` contract remains the runtime
switch. In `full` mode, Codex receives `danger-full-access`; in `restricted`
mode, the existing Codex sandbox still applies. This change removes the
Unbound workflow-level prohibition; it does not pretend that Jormungand can
change privileges inside an already-running remote OpenClaw container.

### Security boundary

The change will not rely on frontend validation or frontend encryption as an
authorization boundary. The existing server-side site authentication,
Jormungand A2A authentication, bridge tokens, and audit persistence remain in
place. Frontend validation may improve the operator experience but cannot
authorize an action by itself.

No new credential storage or SSH-key handling is introduced.

## Scope

### In scope

- Remove the `conversation.unbound_limited` read-only/external-action guard.
- Remove the Unbound Codex manager-binding detour.
- Directly dispatch unbound requests to the selected agent.
- Preserve per-agent conversation history synchronization and response audit.
- Add regression tests for direct Codex and OpenClaw unbound dispatch.

### Out of scope

- Changing authentication or bridge-token policy.
- Changing the meaning of `JORMUNGAND_AGENT_PERMISSION_MODE`.
- Changing project-bound workflow behavior or approval gates.
- Granting privileges to a remote OpenClaw container that its deployment does
  not already have.
- Storing SSH passwords, private keys, or API credentials in the repository.

## Error handling

- A bridge failure returns the existing failed result and does not advance the
  conversation history cursor.
- A successful bridge result advances the cursor exactly once.
- The response remains associated with the originating unbound conversation;
  no project/workflow identifiers are invented.
- Existing authentication and bridge reachability errors remain unchanged.

## Tests

Add or update tests to prove:

- An unbound Codex message is sent directly to Codex rather than to the
  project-binding manager.
- An unbound OpenClaw message is sent directly with the full-execution skill,
  without the `unbound_limited` prohibition.
- The direct-dispatch payload retains conversation ID, target agent, and
  history delta.
- Failed delivery does not mark history as delivered.
- Successful delivery marks history as delivered and persists the response.
- Bound workflow conversations continue using their existing routing and
  approval behavior.
- Server-side authentication and bridge-token checks remain intact.

## Acceptance criteria

- From an authenticated unbound conversation, an operator can request an
  external ingestion action and the selected agent receives it directly.
- The agent is not instructed by Jormungand to refuse external commands or
  file writes solely because the conversation is unbound.
- With `JORMUNGAND_AGENT_PERMISSION_MODE=full`, the Codex bridge starts with
  full access after restart.
- Existing conversation history, audit, failure handling, and bound workflow
  tests pass.
- No frontend-only authorization is introduced.
