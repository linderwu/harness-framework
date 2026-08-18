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
