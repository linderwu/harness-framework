# A2A v0.3 Durable Runtime Design

**Date:** 2026-08-19

## Goal

Give Jormungand a durable A2A v0.3 runtime that records agent-to-agent
messages, task lifecycle transitions, raw protocol frames, and manager/worker
handoffs, while exposing a standards-shaped A2A server that can be discovered
and called by external agents.

## Scope

This change delivers one end-to-end A2A v0.3 vertical slice:

- Durable SQLite records for A2A messages, tasks, and append-only lifecycle events.
- Raw request and response JSON retained with redaction and content hashes.
- Idempotent outbound task submission and restart-safe recovery states.
- Manager-to-worker responses persisted as conversation entries and artifacts.
- A2A v0.3 discovery, message/send, message/stream, tasks/get, and tasks/cancel
  HTTP routes.
- The existing `OPENCLAW_A2A_COMMAND` remains a compatibility transport.
- Read APIs and tests that demonstrate reconstruction of a complete exchange.

## Non-goals

- A2A v1.0 method or schema compatibility in this change.
- External queues, push notification webhooks, or multi-replica scheduling.
- Replacing the existing agent profile roster with a remote registry.
- Storing bearer tokens, passwords, or site-auth credentials in audit records.

## Current Constraints

The application already has SQLite WAL persistence, durable conversation entries,
workflow artifacts, manager tasks, and a v0.3-shaped outbound envelope builder.
The current OpenClaw command path is synchronous and reduces A2A responses to
text, so the new runtime must add durable records without breaking existing
workflow and conversation callers.

## Architecture

### A2A data plane

`A2AMessage` is the immutable protocol exchange record. It identifies the
sender, receiver, context, task, parent message, protocol method, transport,
direction, idempotency key, request hash, and redacted raw request/response.

`A2ATask` is the normalized task projection. Its lifecycle is:

```text
submitted -> working -> completed
                    -> failed
                    -> canceled
                    -> unknown
```

`A2AEvent` is append-only and records every local or remote transition with an
ordered sequence number, event type, actor, timestamp, and redacted payload.

The repository exposes typed methods for creating messages/tasks, appending
events, updating task projections, reading a task timeline, and finding a task
or message by idempotency key. Existing generic `hive_events` remain the audit
source for manager and memory governance events.

### Dispatch and recovery

An outbound submission is persisted as `submitted` before transport execution.
The dispatcher then records `message_sent`, remote acceptance, progress frames,
and the terminal result. Duplicate idempotency keys return the existing task.
If a process restarts during transport, the task is marked `unknown` and can be
reconciled through the remote task identifier when available; it is never
silently treated as completed.

The first implementation keeps the existing single-process SQLite runtime and
does not add an external queue. The API returns a task identity while the
dispatcher may complete synchronously for current adapters.

### Manager and worker handoff

Hive worker dispatch creates a durable A2A task/message pair. Worker output is
written to a workflow artifact and a conversation entry with explicit sender,
receiver, reply, and task references before the manager wake is enqueued. The
manager context pack includes the latest worker response and referenced
artifacts, so a successful worker result is reconstructible and actionable.

### Standard A2A server

The server exposes a v0.3 Agent Card at `/.well-known/agent-card.json` and a
JSON-RPC endpoint for `message/send`, `message/stream`, `tasks/get`, and
`tasks/cancel`. Every inbound request is authenticated, schema-validated,
persisted before dispatch, and associated with a local task. Streaming emits
ordered lifecycle and artifact updates from the same event log.

The command adapter remains available for OpenClaw compatibility, but it is not
advertised as the standard server endpoint.

## Security and audit rules

- Validate method, message shape, size limits, task scope, sender, and target
  agent before dispatch.
- Keep raw protocol records redacted; never persist authorization headers or
  secret environment values.
- Treat agent-provided conversation and artifacts as untrusted context.
- Require idempotency keys for mutating message submission.
- Make lifecycle events append-only; only the control plane may change the
  normalized task status.
- Use the existing agent permission and approval policy for external or
  irreversible effects.

## Verification strategy

- Unit tests for redaction, hashes, lifecycle transitions, idempotency, and
  v0.3 envelope normalization.
- Repository tests for schema migration, restart persistence, and ordered event
  timelines.
- Integration tests for message/send, tasks/get, tasks/cancel, and SSE stream
  responses using a temporary SQLite database.
- Manager scheduler tests proving worker success content is persisted before
  the manager wake.
- Security tests proving invalid methods, unauthorized agents, oversized
  payloads, duplicate submissions, and secret-bearing headers are handled
  safely.

## Acceptance criteria

1. A single A2A exchange can be reconstructed from local storage using its
   message ID, task ID, context ID, raw frames, and ordered lifecycle events.
2. Restarting during an unfinished exchange preserves the task as `unknown` or
   another explicit nonterminal state and does not fabricate success.
3. Repeating the same idempotency key does not create a second task.
4. A manager can read a successful worker response and its artifact after the
   worker wake is processed.
5. An external v0.3 client can discover the Agent Card, submit a message, read
   the task, cancel it, and receive ordered stream updates.
6. Existing tests remain green and no audit record contains bearer tokens,
   passwords, or site-auth credentials.
