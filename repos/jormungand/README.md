# Jormungand App Project

This directory is the runnable Next.js application root inside the Ouroboros
workspace.

Run app commands here:

```powershell
npm run dev
npm run codex-bridge
npm run openclaw-bridge
npm run test
npm run lint
npm run typecheck
npm run build
npm run c4:diagrams
npm run memory:backup
```

Generated C4 diagrams are written to the workspace root:

```text
../../wiki/c4/diagrams/
```

The workspace root still owns durable Ouroboros knowledge layers such as
`raw/`, `wiki/`, `spec/`, `graphify/`, and `graphify-out/`.

The app protects all routes with Basic authentication by default. `/health` is
the unauthenticated liveness endpoint for Zeabur. Set `SITE_AUTH_MODE=mutations`
only when public read-only access is intentional.

Set `JORMUNGAND_AGENT_PERMISSION_MODE=full` to select the shared full-access
agent permission contract. In full mode, the Codex bridge disables Codex
sandboxing and Codex app-server approval pauses, workflow approval gates are
bypassed, and managed `request_approval` actions remain in audit without
parking the run. Set `restricted` to keep the approval-gated workflow and
manager behavior. Site Basic authentication remains enabled.

Unbound conversations dispatch directly to the selected Codex or OpenClaw
agent and do not require a project or workflow binding. They may perform the
requested external commands and write artifacts when the configured bridge
runtime has those capabilities. Server-side authentication, bridge tokens,
conversation audit/history, and `JORMUNGAND_AGENT_PERMISSION_MODE` still
apply; frontend validation is not an authorization boundary.

The OpenClaw HTTP bridge uses `OPENCLAW_BRIDGE_TOKEN`; when that value is blank,
the app can reuse `OPENCLAW_GATEWAY_TOKEN` for compatibility with an existing
single-secret deployment. Separate tokens remain preferable for new installs.

## A2A v0.3 runtime

Jormungand exposes a public Agent2Agent v0.3 surface for discovery, JSON-RPC
task submission, task reads, cancellation, and local audit reconstruction.
This implementation is intentionally A2A v0.3 only. It does not advertise A2A
v1 methods or schemas.

### Authentication

The Agent Card is public discovery metadata and does not require site Basic
Auth or a bearer token:

```text
GET /.well-known/agent-card.json
```

The JSON-RPC and task/audit routes support an explicit bearer token:

```text
JORMUNGAND_A2A_TOKEN=<replace-me>
```

When `JORMUNGAND_A2A_TOKEN` is set, `POST /api/a2a`,
`GET|POST /api/a2a/tasks/:id`, and `GET /api/a2a/audit/:id` require
`Authorization: Bearer <token>`. Query-string tokens are ignored.

When `JORMUNGAND_A2A_TOKEN` is unset, those same API routes fall back to the
existing site Basic Auth boundary. Basic Auth and Bearer are not
simultaneously required on the same `Authorization` header.

Site Basic Auth counts every failed protected request per source IP, including
missing or malformed `Authorization` headers. After five consecutive failures,
that IP remains locked until the service restarts. A successful authentication
clears the IP's failure count. There is no manual unlock endpoint, and each
process keeps its own in-memory lockout state in multi-instance deployments.

### Discovery and routes

- `GET /.well-known/agent-card.json`
  Returns the A2A v0.3 Agent Card with `protocolVersion: "0.3"`, the
  `jsonrpcEndpoint`, supported target agents, and `message/send` plus
  `message/stream` capabilities.
- `POST /api/a2a`
  Accepts JSON-RPC 2.0 `message/send` and `message/stream`.
- `GET /api/a2a/tasks/:id`
  Returns the normalized task projection plus persisted lifecycle events and
  message hashes for the local task id.
- `POST /api/a2a/tasks/:id`
  Accepts cancel requests for the local task id. Use `{"action":"cancel"}`.
- `GET /api/a2a/audit/:id`
  Returns the redacted task, stored request/response frames, SHA-256 hashes,
  and ordered audit timeline for the local task id.

### Task states

Normalized task states are:

```text
submitted
working
input-required
completed
failed
canceled
unknown
```

`unknown` is an explicit recovery state, not a successful completion.

### Redaction and audit records

Every inbound A2A request is persisted before dispatch. The SQLite audit trail
stores:

- the local task record
- the redacted request frame
- the redacted response frame
- SHA-256 hashes of the stored request and response JSON
- append-only lifecycle events such as `message_queued`, `message_accepted`,
  `task_working`, `task_artifact_updated`, `task_completed`, `task_failed`,
  and `task_canceled`

Keys containing `authorization`, `token`, `password`, `secret`, `cookie`, or
`site_auth` are redacted. Bearer tokens and `token=...`-style secret fragments
inside strings are also rewritten before storage.

### Compatibility note

`OPENCLAW_A2A_COMMAND` remains a compatibility-only transport for reaching a
local OpenClaw adapter. It does not replace the public Jormungand A2A server
and does not change the public surface to v1.

### Example requests

Use placeholder values only:

```bash
A2A_ORIGIN=https://jormungand.example.com
A2A_TOKEN=replace-me
```

Read the Agent Card:

```bash
curl "$A2A_ORIGIN/.well-known/agent-card.json"
```

Submit `message/send`:

```bash
curl \
  -H "Authorization: Bearer $A2A_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": "rpc-1",
    "method": "message/send",
    "params": {
      "message": {
        "kind": "message",
        "role": "user",
        "messageId": "message-1",
        "contextId": "context-1",
        "parts": [
          { "kind": "text", "text": "Summarize the current task." }
        ],
        "metadata": {
          "idempotencyKey": "idempotency-1",
          "fromAgent": "external.user",
          "toAgent": "codex"
        }
      }
    }
  }' \
  "$A2A_ORIGIN/api/a2a"
```

Submit `message/stream`:

```bash
curl \
  -N \
  -H "Authorization: Bearer $A2A_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": "rpc-stream-1",
    "method": "message/stream",
    "params": {
      "message": {
        "kind": "message",
        "role": "user",
        "messageId": "message-stream-1",
        "contextId": "context-stream-1",
        "parts": [
          { "kind": "text", "text": "Stream the answer." }
        ],
        "metadata": {
          "idempotencyKey": "stream-idempotency-1",
          "fromAgent": "external.user",
          "toAgent": "codex"
        }
      }
    }
  }' \
  "$A2A_ORIGIN/api/a2a"
```

Read a task:

```bash
curl \
  -H "Authorization: Bearer $A2A_TOKEN" \
  "$A2A_ORIGIN/api/a2a/tasks/<task-id>"
```

Cancel a task:

```bash
curl \
  -H "Authorization: Bearer $A2A_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"action":"cancel"}' \
  "$A2A_ORIGIN/api/a2a/tasks/<task-id>"
```

Read the redacted audit record:

```bash
curl \
  -H "Authorization: Bearer $A2A_TOKEN" \
  "$A2A_ORIGIN/api/a2a/audit/<task-id>"
```

## Hive memory operations

Hive memory, manager checkpoints, and task conversation entries use SQLite in
WAL mode. Production must set:

```text
JORMUNGAND_DATA_DIR=/data
```

Mount a provider-managed persistent volume at that directory. The Docker
`VOLUME` declaration documents the mount point but does not itself provide
durable storage. The JSON workflow state and the Hive SQLite database both live
under the same configured data directory, so volume-level backups need to carry
the pair together.

The Superpowers skill catalog is loaded from the private
`linderwu/jormungand_skill` repository at runtime. Configure
`JORMUNGAND_SKILL_REPOSITORY_TOKEN` as a Zeabur secret using a GitHub token with
read-only access to that repository. The token is passed to Git through an
authorization header and is never embedded in the repository URL.

Schedule `npm run memory:backup` daily. It creates paired SQLite and workflow
state backups in `$JORMUNGAND_DATA_DIR/backups`, checks the SQLite integrity,
parses the JSON state copy, and retains the latest 14 timestamped backup pairs.
The paired state file uses the `.state.json` suffix alongside the SQLite
backup.
In an isolated verification environment, run this weekly:

```powershell
npm run memory:verify-backup -- "$JORMUNGAND_DATA_DIR/backups/hive-memory-YYYYMMDD-HHmmss.sqlite"
```

The verifier copies the SQLite backup and its paired workflow-state JSON to a
temporary directory and never overwrites the live database. Check
`/api/hive-memory/health` for schema version, database location, workflow state
status, latest backup time, and the latest integrity result. If startup or
health reports `unavailable`, stop autonomous managed work, preserve the SQLite
database and JSON workflow state together, verify the newest backup pair, and
restore both artifacts only in a separate recovery procedure before resuming
manager wakes.
