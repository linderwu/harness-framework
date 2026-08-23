# Harness OpenClaw Persistent Direct Sessions

## Status

Approved design. Ready for implementation planning after operator review of
this written specification.

## Goal

Allow every authenticated Harness conversation to execute directly through
the selected OpenClaw agent with the agent's complete configured tool surface.
Each `(conversationId, OpenClaw agent)` pair owns an isolated, persistent
OpenClaw session that survives Harness and bridge restarts.

The conversation does not need a project or workflow-run binding. Existing
server authentication, bridge authentication, audit persistence, and runtime
identity checks remain mandatory.

## Terminology

- **Workflow binding** associates a Harness conversation with a project and
  workflow run.
- **Runtime session binding** deterministically routes a Harness conversation
  to an OpenClaw session key.
- **Direct conversation** is not workflow-bound but has a runtime session
  binding and may execute tools.
- **Persistent session** is the Gateway-owned OpenClaw session selected with
  `openclaw agent --session-key`.

OpenClaw channel bindings and ACP `/acp spawn --bind here` are not used. They
route supported messaging surfaces or ACP conversations and are separate from
the explicit session routing used by the Harness bridge.

## Architecture

### One session per conversation and agent

The session identity is derived from both the stable Harness conversation ID
and the selected OpenClaw agent:

```text
agent:<agentId>:harness-direct-v1-<normalized-conversation-id>
```

Examples:

```text
conversation:abc + gengar -> agent:gengar:harness-direct-v1-conversation-abc
conversation:abc + rowlet -> agent:rowlet:harness-direct-v1-conversation-abc
```

The derivation must:

- return the same key for the same agent and conversation;
- isolate different conversations and different agents;
- sanitize unsupported session-key characters;
- remain within OpenClaw's session-key length limit;
- append a deterministic hash when truncation is required;
- ignore any caller-supplied session key;
- keep the `harness-direct-v1` namespace stable for the lifetime of this
  contract.

Changing the identity algorithm requires a new namespace version. It must not
silently redirect an existing conversation to another session.

### Direct dispatch

All non-workflow-bound conversations dispatch directly to the selected Codex
or OpenClaw agent. The OpenClaw path:

1. validates the authenticated conversation and selected agent;
2. persists the operator entry and durable dispatch job;
3. derives the OpenClaw session key from server-owned identity fields;
4. sends an unrestricted direct-execution skill and the current operator
   request through the configured HTTP or A2A bridge;
5. invokes `openclaw agent --agent <agent> --session-key <key> --message
   <payload> --json`;
6. persists the response, audit data, and delivery cursor after success.

The payload must not contain `conversation.unbound_limited`, `read-only`, or
instructions that prohibit external systems, file writes, irreversible
actions, or project-independent execution solely because no workflow run is
bound.

Use a direct-execution skill such as:

```text
id: conversation.direct_execution
purpose: Execute the authenticated operator request directly without requiring
         a project or workflow binding.
constraint: Report tool results, side effects, and blockers accurately.
gate: Server authentication and bridge authorization remain required.
```

### Tool and execution policy

Runtime session routing does not grant tools. The OpenClaw deployment must
independently expose the unrestricted policy:

```json5
{
  agents: {
    defaults: {
      sandbox: { mode: "off" },
    },
  },
  tools: {
    profile: "full",
    exec: {
      host: "gateway",
      mode: "full",
      applyPatch: {
        enabled: true,
        workspaceOnly: false,
      },
    },
  },
}
```

The effective configuration must not contain global, provider, sender, or
per-agent allow/deny rules that narrow the selected agents. Agent-specific
sandbox overrides must also be off.

Because the Gateway runs in the OpenClaw container, `host: "gateway"` means
the container runtime. Required programs such as `yt-dlp`, FFmpeg, and the
selected transcription engine must be installed there, with network access,
credentials, writable mounts, and operating-system permissions supplied by
the deployment.

Harness `permissionMode: "full"` is audit metadata for OpenClaw. It does not
override OpenClaw tool policy, container capabilities, or operating-system
permissions.

## Conversation history and continuity

OpenClaw's persistent session is authoritative for OpenClaw turn continuity.
Harness remains authoritative for the dashboard transcript and dispatch audit.

When an OpenClaw agent first joins a Harness conversation, Harness may send one
bounded bootstrap history containing relevant earlier operator and agent
turns. Subsequent turns send only the current operator request because the
OpenClaw session already owns its history.

Bootstrap and delivery state must be persisted. An in-memory-only cursor is
not sufficient because a Harness restart would resend old history into the
persistent OpenClaw session. The persisted state records at least:

```json
{
  "provider": "openclaw",
  "agentId": "gengar",
  "sessionNamespace": "harness-direct-v1",
  "state": "active",
  "sessionKeyFingerprint": "sha256:...",
  "bootstrapDelivered": true,
  "lastDeliveredEntryId": "entry-..."
}
```

The full session key remains server-side and must not be exposed to browser
clients. A fingerprint is sufficient for UI diagnostics and audit
correlation.

## Lifecycle

- The first successful turn lazily creates the OpenClaw session.
- Later turns for the same conversation and agent reuse it.
- Renaming a Harness conversation does not change its session key.
- Restarting Harness or either bridge does not change the session key.
- Switching OpenClaw agents creates or resumes a separate per-agent session.
- Creating a new Harness conversation creates a new session identity.
- Deleting a Harness conversation removes Harness metadata, entries, jobs, and
  runtime references only. It does not delete the OpenClaw session.
- No automatic cleanup request is sent to OpenClaw for detached sessions.

## Idempotency and failure handling

Each dispatch uses a durable idempotency key derived from the persisted
conversation entry or job, not from process memory.

- A definitive bridge failure marks the entry failed and does not advance the
  delivery cursor.
- A successful bridge result records the response and advances the cursor
  exactly once.
- A timeout or transport disconnect is `delivery_unknown`, because OpenClaw
  may have accepted and continued the turn. Harness must not automatically
  repeat a side-effecting request.
- Recovery checks the persisted audit and OpenClaw session state before an
  operator-authorized retry.
- Missing binaries, credentials, network access, writable mounts, or tools are
  reported as runtime capability failures. They must not be translated into
  an unbound-mode refusal.
- A tool-policy, sandbox, or exec-policy mismatch is surfaced through bridge
  health as a configuration error.

## Security boundary

Unrestricted tools do not remove the surrounding trust boundary. The design
retains:

- authenticated Harness access;
- server-side input validation;
- OpenClaw bridge token validation;
- OpenClaw Gateway authentication;
- conversation, tool-result, and side-effect audit records;
- server-owned session-key derivation;
- transcript-as-context treatment that cannot override system authority.

Frontend state and prompt text are not authorization mechanisms. The browser
cannot choose an arbitrary OpenClaw session key or weaken runtime policy.

## Migration

Existing `agent:<agent>:harness-conversation-*` sessions may contain the old
limited-mode instructions. The first release of this design uses the new
`harness-direct-v1` namespace so existing Harness conversations start fresh,
unrestricted OpenClaw sessions.

Old OpenClaw sessions remain stored and are not deleted. Existing Harness
transcripts remain visible. No old delivery cursor is treated as proof that a
new `harness-direct-v1` bootstrap was delivered.

## Verification

### Unit and integration tests

- Same conversation and agent produce the same key.
- Different conversations or agents produce different keys.
- Long identities remain bounded and collision-resistant.
- Caller-supplied session keys are ignored.
- HTTP and A2A transports derive identical keys.
- Direct payloads contain no limited-mode prohibitions.
- The first agent turn receives bootstrap history once.
- Harness restart does not resend bootstrap history.
- Success advances the persisted cursor; failure does not.
- Unknown delivery does not trigger an automatic retry.
- Deleting a Harness conversation does not invoke OpenClaw session deletion.
- Bound workflow conversations keep their existing workflow behavior.
- Authentication and bridge-token checks remain unchanged.

### Live verification

From an authenticated direct Harness conversation:

1. send a YouTube URL to an OpenClaw agent;
2. verify the agent can call `yt-dlp`, FFmpeg, and the configured transcription
   engine;
3. verify the requested artifact is written to the configured writable mount;
4. send a follow-up and verify it reaches the same OpenClaw session;
5. open another Harness conversation and verify session isolation;
6. restart Harness and the bridge, then verify continuity without bootstrap
   duplication;
7. delete the Harness conversation and verify the OpenClaw session remains.

## Rollout order

1. Configure OpenClaw full tool policy and install runtime dependencies.
2. Restart and inspect the effective OpenClaw Gateway configuration.
3. Deploy direct Harness routing and the `harness-direct-v1` derivation.
4. Restart the OpenClaw bridge and Harness workers.
5. Run isolation, persistence, capability, and YouTube-ingestion smoke tests.
6. Retain old sessions without routing new turns to them.

## Acceptance criteria

- Every authenticated Harness conversation has an isolated persistent
  OpenClaw session per selected OpenClaw agent.
- Session identity is stable across retries and restarts.
- Direct conversations can call every tool permitted by the effective
  OpenClaw runtime configuration.
- No workflow binding is required for tool execution.
- Existing authentication and audit controls remain active.
- History bootstrap occurs at most once per conversation-agent-session
  namespace.
- Ambiguous delivery cannot silently duplicate external side effects.
- Harness conversation deletion leaves the OpenClaw session intact.

## References

- OpenClaw Agent CLI: https://docs.openclaw.ai/cli/agent
- OpenClaw tool configuration: https://docs.openclaw.ai/gateway/config-tools
- OpenClaw sandboxing: https://docs.openclaw.ai/gateway/sandboxing
- OpenClaw exec tool: https://docs.openclaw.ai/tools/exec
- OpenClaw ACP agents and bound sessions:
  https://docs.openclaw.ai/tools/acp-agents
