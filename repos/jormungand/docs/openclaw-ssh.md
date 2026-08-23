# OpenClaw Direct Session Operator Checks

Run these checks from a shell in the OpenClaw Gateway container or an attached
shell with the same `openclaw` CLI, binaries, mounts, network access, and
credentials. Harness direct conversations use a persistent OpenClaw session per
`(conversationId, agent)` pair in the `harness-direct-v1` namespace. They do
not depend on ACP `/acp spawn --bind here` bindings.

## Effective policy

Direct routing does not grant tools by itself. The effective OpenClaw policy
must allow the selected agents to execute the required tools:

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

Keep `tools.exec.applyPatch.workspaceOnly=false` only where truly unrestricted
writes are required. The effective policy may still be narrower than the
snippet above if `tools.deny`, `tools.byProvider`, `tools.toolsBySender`,
per-agent tool restrictions, or per-agent sandbox overrides are present.

`tools.exec.host=gateway` means the Gateway container runtime. `yt-dlp`,
FFmpeg, the selected transcription engine, network access, credentials, and
writable mounts must all exist in that container before Harness can request
those actions successfully.

## Smoke checks

Use simple placeholder conversation ids when deriving session keys manually.
Jormungand sanitizes unsupported characters and enforces OpenClaw's key length
limit automatically for real Harness conversation ids.

```bash
export OPENCLAW_AGENT=gengar
export CONVERSATION_ID=conversation-smoke
export SECOND_CONVERSATION_ID=conversation-smoke-2
export SESSION_KEY="agent:${OPENCLAW_AGENT}:harness-direct-v1-${CONVERSATION_ID}"
export SECOND_SESSION_KEY="agent:${OPENCLAW_AGENT}:harness-direct-v1-${SECOND_CONVERSATION_ID}"
```

1. Confirm the target agent is available:

```bash
openclaw agents list --bindings
```

Verify that the selected agent exists and that no operator is relying on ACP
bindings for Harness direct-session continuity.

2. Inspect the current OpenClaw session inventory:

```bash
openclaw sessions --json
```

Record whether the expected `harness-direct-v1` keys already exist before the
smoke run.

3. Run a direct agent `--session-key` health check:

```bash
openclaw agent \
  --agent "$OPENCLAW_AGENT" \
  --session-key "$SESSION_KEY" \
  --message "Reply only with DIRECT_SESSION_OK." \
  --json
```

Expect a completed response without sandbox, exec-policy, missing-binary, or
tool-denied errors.

4. Verify same-conversation continuity from Harness:

- Start a new direct Harness conversation with the selected OpenClaw agent.
- Send `Remember token HARNESS-CONTINUITY-1 and reply with it once.`
- Send `What token did I ask you to remember?`
- Expect the follow-up reply to return `HARNESS-CONTINUITY-1`.
- Run `openclaw sessions --json` again and verify the same
  `agent:<agent>:harness-direct-v1-...` key is still present for that
  conversation.

5. Verify different-conversation isolation:

- Open a second Harness conversation with the same OpenClaw agent.
- Send `Remember token HARNESS-ISOLATION-2 and reply with it once.`
- Ask each conversation for the token it was told to remember.
- Expect each conversation to return only its own token.
- Run `openclaw sessions --json` and verify two different
  `harness-direct-v1` session keys exist for the two conversation ids.

6. Verify Harness restart continuity:

- Restart Harness and the OpenClaw bridge without deleting the conversation.
- Reopen the original Harness conversation and ask for
  `HARNESS-CONTINUITY-1` again.
- Expect the same token to be returned.
- Run `openclaw sessions --json` and verify the same session key remains in
  place after restart.

7. Verify deleting the Harness conversation does not delete the OpenClaw
session:

- Delete the original Harness conversation.
- Run `openclaw sessions --json` and verify the corresponding
  `harness-direct-v1` session key still exists remotely.
- If needed, confirm the remote session is still usable:

```bash
openclaw agent \
  --agent "$OPENCLAW_AGENT" \
  --session-key "$SESSION_KEY" \
  --message "What token did I ask you to remember?" \
  --json
```

Expect the session to remain available until the operator removes it from
OpenClaw explicitly.
