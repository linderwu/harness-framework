# Full-access agent execution and conversation management

## Status

Approved design for implementation in Jormungand (耶夢加德).

## Goal

Deliver three connected improvements:

1. Run configured agents with full local execution permissions: unrestricted workspace access, network access, and no agent approval boundary.
2. Give unbound conversations durable management: create, switch, rename, archive, unarchive, and delete.
3. Make conversation actions feel tactile with the approved Layered press button treatment while preserving accessibility and responsive behavior.

## Scope boundaries

Full access applies to agent execution and workflow approval coordination. The application’s Basic Auth boundary remains unchanged. Existing conversation entries, Codex sessions, artifacts, and audit events remain the source of truth for their respective data; the new conversation index supplies only durable title and lifecycle metadata.

Bound project/workflow conversations keep the existing project/run binding semantics. The new management list owns unbound `conversation:*` conversations so this change does not redefine workflow-run identity.

## Architecture

### Conversation data model

Add a `conversations` table through a new Hive schema migration:

```sql
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);
```

The existing tables remain in place:

```text
conversations        title, lifecycle state, and timestamps
conversation_entries  persisted user and agent messages
codex_sessions        bridge session identity and cursor
```

The repository exposes focused operations for listing summaries, creating metadata, renaming, changing lifecycle state, and deleting an unbound conversation. Summary queries continue to calculate message count, latest message time, and latest message preview from `conversation_entries` instead of duplicating message data.

The migration backfills metadata for existing `conversation:*` identities and the legacy unbound identity. A missing title is derived from the first user message, truncated to the UI title limit, with `New conversation` as the fallback.

### Lifecycle rules

- Create: create metadata and a new conversation identity before the first message is sent.
- Switch: change the active identity only; never copy or move entries.
- Rename: update only the metadata title.
- Archive: set `state = archived`, retain all entries and session data, and hide it from the default active list.
- Unarchive: set `state = active` and clear `archived_at`.
- Delete: stop a running Codex session, then delete metadata, entries, and the conversation’s Codex session in one repository operation.
- A running conversation cannot be archived or deleted; the API returns a conflict and the UI directs the operator to stop it first.
- Existing project-bound conversations remain managed by the project/run selector and are not moved into the unbound management list.

### Full-access execution

Introduce one server-side permission mode used consistently by the bridge and workflow engine. The requested default is `full`; `restricted` remains available as a deliberate fallback for test or deployment environments.

In `full` mode:

- `codex exec` is invoked with `--dangerously-bypass-approvals-and-sandbox`.
- Codex app-server `thread/start` receives `danger-full-access` and `approvalPolicy: never`.
- Codex app-server `turn/start` receives the full-access sandbox policy and `approvalPolicy: never`.
- The workspace-only writable root and `networkAccess: false` restrictions are omitted.
- Workflow advancement does not create or wait on approval gates.
- Manager actions are not converted into pending approval requests for external or irreversible effects.
- Conversation, event, artifact, and agent-run audit records continue to be persisted.

In `restricted` mode, the current `workspace-write`, workspace-root, network-disabled, and approval-gated behavior remains available for regression testing and controlled deployments.

The conversation header exposes the active mode as `Full access` so the operator can distinguish execution capability from ordinary session status. Website authentication is not changed by this mode.

## API contract

Keep `/api/conversation` for message and live-session operations. Add durable management endpoints:

```text
GET    /api/conversations
POST   /api/conversations
PATCH  /api/conversations/:id
DELETE /api/conversations/:id
```

### `GET /api/conversations`

Returns active unbound conversation summaries by default. `includeArchived=true` includes archived summaries. Each summary contains `conversationId`, `title`, `state`, `messageCount`, `latestMessageAt`, and `latestMessage`.

### `POST /api/conversations`

Creates and persists a new active conversation. An optional title is normalized and validated; otherwise the title is `New conversation`. The response returns the new conversation identity and metadata and sets the conversation cookie.

### `PATCH /api/conversations/:id`

Accepts a title update, `state: active`, or `state: archived`. Titles are trimmed and must contain 1–80 characters. The route returns `404` for an unknown identity, `400` for invalid input, and `409` when archiving or unarchiving violates the current session state.

### `DELETE /api/conversations/:id`

Requires `confirm: true`. A running session returns `409`. On success, the route stops the bridge session when necessary and removes the conversation metadata, entries, and Codex session. Unknown identities return `404`.

Management operations are idempotent where practical: repeated archive/unarchive requests return the resulting summary, while repeated delete of an absent identity returns `404`.

## UI design

### Conversation manager

Update `TaskConversation` to display the current conversation title in the header. The manager control lists active conversations first, optionally exposes archived conversations, and provides actions for rename, archive/unarchive, and delete. New conversation creates a metadata record and immediately resets the visible message/session state to the new identity.

Rename uses an inline form or native dialog with the 1–80 character constraint. Delete uses a native confirmation dialog and explains that messages and the Codex session will be removed. Loading and mutation states disable conflicting controls; API errors remain visible with an actionable message.

The layout is mobile-first: the header action group wraps, titles have `min-width: 0` and ellipsis handling, controls use content-sized widths, and the composer never depends on a fixed-width action button. The manager must not introduce horizontal scrolling at 320px or 375px viewport widths.

### Layered press buttons

Apply the selected visual treatment to conversation actions, including primary send/new actions and compact manager actions:

```css
box-shadow: 0 4px 0 var(--button-depth);
transform: translateY(0);
```

The active state reduces the depth and translates the button down by the same amount. Focus uses a visible keyboard ring; disabled controls lose the depth cue and remain readable; danger actions use a solid danger color rather than relying on shadow alone. Motion is reduced or removed under `prefers-reduced-motion: reduce`.

The style is a tactile control layer, not a nested card or decorative shadow system. Conversation content remains the visual priority.

## Error handling

- Repository errors are converted to stable API status codes and concise messages.
- A failed bridge stop prevents deletion from proceeding, preserving recoverability.
- Stale client polling is invalidated whenever the active conversation changes or is deleted.
- A failed rename/archive/delete leaves the current conversation selection and entries intact.
- Empty lists show an explicit new-conversation action; archived-only lists explain how to restore an item.

## Verification

Add or update tests for:

- schema migration and legacy conversation backfill;
- repository create/list/rename/archive/unarchive/delete behavior;
- running-session conflict rules and deletion cleanup;
- all management route success and validation/error responses;
- full and restricted bridge command/payload contracts;
- workflow behavior with and without approval gates;
- conversation manager UI actions, loading/error locking, and stale-poll invalidation;
- Layered press active, focus, disabled, and responsive structure.

Run the narrowest relevant tests first, then:

```text
npm test
npm run typecheck
npm run lint
npm run build
```

Finally verify the conversation manager and button interaction in a desktop browser and at mobile viewport widths.

## Success criteria

The change is complete when:

1. A full-mode agent can execute outside the workspace sandbox, use the network, and proceed without workflow approval gates.
2. An operator can create, switch, rename, archive, unarchive, and delete unbound conversations with durable persistence.
3. Existing conversation and project-binding behavior remains compatible.
4. Conversation controls visibly use the Layered press interaction and remain accessible and responsive.
5. The specified tests, typecheck, lint, build, and browser checks pass.
