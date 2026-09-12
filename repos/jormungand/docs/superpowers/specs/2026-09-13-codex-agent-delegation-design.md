# Codex Native Agent Delegation Design

**Date:** 2026-09-12
**Status:** Approved implementation direction

## Goal

Allow a Codex session launched through the DSH native route to call another registered agent, such as Pi or OpenClaw, through an explicit `dsh_agent_call` MCP tool and receive a durable, bounded result. Direct DSH-to-Codex routing must remain unchanged.

## Architecture

The local Codex Bridge launches a small stdio MCP server only for DSH v1 Codex sessions. The MCP server owns no credentials in tool input and accepts only configured agent identities. It calls the existing authenticated DSH v1 HTTP contract (`sessions`, `turns`, `turn status`, and event replay) so Pi, OpenClaw, and future runtimes share the existing receipt/unknown semantics.

```text
DSH web session
  -> dsh-native Codex turn
    -> Codex App Server
      -> dsh_agent_call MCP tool (stdio)
        -> local/remote authenticated DSH v1 bridge
          -> Pi or OpenClaw native runtime
```

The companion `dsh_agents_list` tool provides the configured target inventory and live capability observations without exposing bridge URLs or tokens. The current Codex target is not callable from its own delegation tool, preventing same-session recursion and deadlock.

## Target resolution

Target origins and credentials are resolved only from the bridge process environment. The model may choose an allowlisted `agentId`; optional host/workspace fields must match the configured identity. Pi uses the local Codex Bridge v1 endpoint. OpenClaw uses its configured HTTPS bridge endpoint when present. No tool argument can provide a URL, header, token, shell command, or SSH command.

## Call lifecycle

1. Validate tool input, target allowlist, message size, timeout, and delegation depth.
2. Reserve one DSH v1 session receipt using a generated request id and stable binding key.
3. Submit one DSH v1 turn. Never retry a POST after an ambiguous transport result.
4. Poll the durable turn receipt and bounded event pages until a confirmed terminal status or deadline.
5. Return structured text containing target, status, native identities, and bounded output. Unknown, failed, offline, and empty-output results remain distinguishable.

Default call deadline is 120 seconds and maximum delegation depth is one nested call. Tool output is bounded and never includes credentials.

## Codex integration

`codex app-server` receives a per-session MCP configuration through `-c mcp_servers.<name>.*` overrides. Legacy Codex sessions and quota probes do not receive the delegation server. Existing Codex item/event projection already identifies MCP tool calls, so DSH trajectory can show the nested call without a second UI.

## Security and failure policy

- Only DSH v1-enabled Codex sessions get the tool.
- Self-delegation and depth overflow are rejected before network I/O.
- Remote POSTs use the existing bearer token and HTTPS policy.
- No automatic POST retry; ambiguous outcomes return `unknown`.
- Target runtime errors are returned as tool errors, not converted to success.
- OpenClaw remains unavailable until its bridge endpoint and token are valid; the delegation feature must not bypass that boundary.

## Acceptance

- A Codex DSH web turn can call `dsh_agents_list` and see the configured Pi target.
- A Codex DSH web turn can call `dsh_agent_call` for Pi and receive a real response or an explicit runtime failure.
- Codex trajectory contains an MCP tool item for the delegation.
- Direct Codex calls still complete exactly as before.
- Unit tests cover protocol, target validation, receipt polling, timeout, unknown outcomes, self-delegation, and secret non-disclosure.
- A production DSH web smoke test proves Codex sees the tool and attempts a nested Pi call.
