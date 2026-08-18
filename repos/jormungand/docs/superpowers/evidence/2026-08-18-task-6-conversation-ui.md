# Task 6 Conversation UI Evidence

Date: 2026-08-18

## Scope

- `components/task-conversation.tsx`
- `tests/conversation-ui-structure.test.ts`
- `tests/conversation-ui-behavior.test.ts`

## RED

Command:

```text
npx tsc -p tsconfig.tests.json
node --test .tmp-tests/tests/conversation-ui-structure.test.js .tmp-tests/tests/conversation-ui-behavior.test.js
```

Observed result before implementation:

- `npx tsc -p tsconfig.tests.json` passed.
- Targeted UI tests failed `5` of `11`.
- Failing checks were the new conversation-manager helper exports and new source-contract assertions:
  - `conversation manager helpers use the list, new, rename, and archive routes with normalized payloads`
  - `conversation deletion replacement flow confirms deletion, clears stale switch state, and stops on delete errors`
  - `task conversation exposes a new conversation action with pending reset behavior`
  - `conversation manager uses managed metadata, archived filtering, and explicit delete confirmation`
  - `conversation header surfaces the managed title, access mode, dialog copy, and action labels`

This confirmed the new tests were exercising behavior the component did not yet implement.

## GREEN

Commands:

```text
npx tsc -p tsconfig.tests.json
node --test .tmp-tests/tests/conversation-ui-structure.test.js .tmp-tests/tests/conversation-ui-behavior.test.js
```

Observed result after implementation:

- `npx tsc -p tsconfig.tests.json` passed.
- Targeted UI tests passed `11` of `11`.

## Full Verification

Commands:

```text
npm test
npm run typecheck
```

Observed result:

- `npm test` passed `205` of `205`.
- `npm run typecheck` passed.

## Notes

- The component preserves the pre-existing user-owned unbound conversation selector/new-conversation work and extends it with managed title display, access-mode status, archived toggle, rename, archive/unarchive, delete confirmation, and helper-backed mutation flows.
- Full-suite verification required preserving an older source-contract expectation in `task-conversation.tsx` by keeping the original submit gate shape and adding the manager-action guard as a second statement.

## Follow-up Fix

Issue addressed:

- Task 6 left `New conversation` less strictly locked than rename/archive/delete. The button only used `isConversationActionPending`, and the handler only short-circuited `isStartingConversation`.

Fix applied:

- Added a shared runtime helper `isConversationManagerLocked(...)`.
- Routed the New conversation button and `startNewConversation()` through the same lock used by the other manager actions.
- Added a focused runtime test covering the running and controlling cases.

Follow-up verification:

```text
npx tsc -p tsconfig.tests.json
node --test .tmp-tests/tests/conversation-ui-structure.test.js .tmp-tests/tests/conversation-ui-behavior.test.js
npm test
npm run typecheck
```

Observed result:

- Focused UI tests passed `12` of `12`.
- `npm test` passed `206` of `206`.
- `npm run typecheck` passed.

## Follow-up Fix 2

Issues addressed:

- After successful delete, the UI could still retain the deleted conversation state until replacement creation completed, which risked showing stale content if replacement creation failed.
- New/delete identity transitions still had explicit summary refresh calls in the handlers instead of relying on the identity-change refresh effect.

Fix applied:

- Split deletion from replacement creation so `handleDeleteConversation()` now:
  - waits for delete success,
  - invalidates polling immediately,
  - clears entries, session, events, metadata, and active selection before requesting a replacement identity,
  - leaves the composer disabled with a visible error if replacement creation fails.
- Added `buildDeletedConversationState()` for the cleared post-delete state contract.
- Removed the explicit summary refresh calls from new/delete identity transitions and relied on the `activeConversationId` refresh effect instead, with a guard that skips the transient cleared identity during replacement creation.

Follow-up verification:

```text
npx tsc -p tsconfig.tests.json
node --test .tmp-tests/tests/conversation-ui-structure.test.js .tmp-tests/tests/conversation-ui-behavior.test.js
npm test
npm run typecheck
```

Observed result:

- Focused UI tests passed `13` of `13`.
- `npm test` passed `207` of `207`.
- `npm run typecheck` passed.

## Follow-up Fix 3

Issue addressed:

- Delete-to-replacement still had a hydration race: after delete success, clearing `conversationId` could let the normal unbound hydration effect call `GET /api/conversation` against the stale cookie before replacement creation completed.

Fix applied:

- Added an explicit replacement-in-progress state for the delete -> new flow.
- Added `shouldSkipUnboundHydration(...)` and used it to short-circuit the normal unbound hydration effect while replacement is in progress and no active identity exists.
- Updated the cleared deleted state helper to record replacement-in-progress.
- Kept replacement state true on replacement-create failure so the error remains visible, the active identity stays undefined, and the composer remains disabled until a fresh identity exists.

Follow-up verification:

```text
npx tsc -p tsconfig.tests.json
node --test .tmp-tests/tests/conversation-ui-structure.test.js .tmp-tests/tests/conversation-ui-behavior.test.js
npm test
npm run typecheck
```

Observed result:

- Focused UI tests passed `14` of `14`.
- `npm test` passed `208` of `208`.
- `npm run typecheck` passed.

## Follow-up Fix 4

Issue addressed:

- The first replacement-race fix blocked stale hydration after replacement-create failure, but it also left the same replacement flag in the manager lock path, which kept the whole manager locked and prevented `New conversation` retry.

Fix applied:

- Split transient `isReplacingDeletedConversation` from recovery `isConversationIdentityUnavailable`.
- Updated `shouldSkipUnboundHydration(...)` so it returns true when there is no active identity and either:
  - delete replacement is still in progress, or
  - conversation identity is unavailable after replacement-create failure.
- Updated `isConversationManagerLocked(...)` so it includes transient replacement state but does not include recovery state.
- Added `buildReplacementFailureState()` and used it when replacement creation fails:
  - transient replacement flag clears,
  - recovery flag stays true,
  - active identity remains undefined,
  - stale hydration stays blocked,
  - `New conversation` retry becomes available.

Follow-up verification:

```text
npx tsc -p tsconfig.tests.json
node --test .tmp-tests/tests/conversation-ui-structure.test.js .tmp-tests/tests/conversation-ui-behavior.test.js
npm test
npm run typecheck
```

Observed result:

- Focused UI tests passed `14` of `14`.
- `npm test` passed `208` of `208`.
- `npm run typecheck` passed.
