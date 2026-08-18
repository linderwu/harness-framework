# Task 2 Bridge Permission Verification

Date: 2026-08-18
Worktree: `C:\Users\linder\.config\superpowers\worktrees\harness-framework\jormungand-full-access-conversation-management\repos\jormungand`
Task: Apply full permissions at the bridge boundary

## TDD Sequence

### RED

Commands:

```powershell
npx tsc -p tsconfig.tests.json
node --test .tmp-tests/tests/bridge-security.test.js .tmp-tests/tests/codex-conversation-structure.test.js .tmp-tests/tests/agent-bridge-profile.test.js
```

Observed result:

- `npx tsc -p tsconfig.tests.json` passed before implementation.
- The targeted test run failed `4` assertions before bridge implementation.
- Actual failure reason: the new source-contract assertions failed because full/restricted bridge permission behavior was not implemented yet.
- Failure details from the run:
  - `tests/agent-bridge-profile`: expected `capturedPayload.permissionMode` to be `"restricted"` but received `undefined`.
  - `tests/bridge-security`: the new `codexBridgeSource` assertion for `JORMUNGAND_AGENT_PERMISSION_MODE?.trim().toLowerCase() === "restricted" ? "restricted" : "full"` did not match.
  - `tests/codex-conversation-structure`: the new session-policy assertions for `permissionMode === "full"` and the full/restricted branch contract did not match the bridge source.

### GREEN

Command:

```powershell
node --test .tmp-tests/tests/bridge-security.test.js .tmp-tests/tests/codex-conversation-structure.test.js .tmp-tests/tests/agent-bridge-profile.test.js
```

Observed result:

- Passed `19/19`.

### TypeScript test build

Command:

```powershell
npx tsc -p tsconfig.tests.json
```

Observed result:

- Passed.

### Full suite

Command:

```powershell
npm test
```

Observed result:

- Passed `179/179`.

### Typecheck

Command:

```powershell
npm run typecheck
```

Observed result:

- Passed.
