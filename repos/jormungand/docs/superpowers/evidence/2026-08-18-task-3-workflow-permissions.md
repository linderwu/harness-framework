# Task 3 Evidence: Workflow Permissions

Date: 2026-08-18
Worktree: `C:\Users\linder\.config\superpowers\worktrees\harness-framework\jormungand-full-access-conversation-management\repos\jormungand`

## Scope

Task 3 wires workflow and manager approval behavior to the shared agent permission mode:

- `full` bypasses workflow approval gates and manager approval waits while preserving audit records.
- `restricted` preserves the existing approval-gated behavior.

## RED

### 1. Added failing tests

Files updated before implementation:

- `tests/workflow.test.ts`
- `tests/managed-workflows.test.ts`
- `tests/hive-manager.test.ts`
- `tests/hive-mission-e2e.test.ts`
- `tests/context-builder.test.ts`
- `tests/bridge-security.test.ts`

### 2. Ran targeted RED command

Command:

```powershell
node -e "require('fs').rmSync('.tmp-tests',{recursive:true,force:true})"
npx tsc -p tsconfig.tests.json
node --test .tmp-tests/tests/workflow.test.js .tmp-tests/tests/managed-workflows.test.js .tmp-tests/tests/hive-manager.test.js .tmp-tests/tests/hive-mission-e2e.test.js .tmp-tests/tests/context-builder.test.js .tmp-tests/tests/bridge-security.test.js
```

Observed RED results:

- `npx tsc -p tsconfig.tests.json` failed with:
  - `tests/managed-workflows.test.ts(76,56): error TS2554: Expected 1 arguments, but got 2.`
  - `tests/managed-workflows.test.ts(77,56): error TS2554: Expected 1 arguments, but got 2.`
- Targeted test run failed as expected with `31` pass / `8` fail.

Expected failure reasons observed:

- `requiresHumanApproval("protected_push", "full")` still returned `true`.
- Full-mode workflow still stopped in `plan` instead of advancing without approval gates.
- Full-mode manager scheduler still invoked `requestApproval` and set approval wait behavior.
- Full-mode context/prompt text still used restricted-mode wording.

Representative failing assertions from the RED run:

- `tests/managed-workflows.test.ts`
  - `true !== false` for full-mode approval bypass.
- `tests/workflow.test.ts`
  - full-mode run stayed at `plan` instead of reaching `design` / `completed`.
- `tests/hive-manager.test.ts`
  - approval callback count was `1` instead of `0` in full mode.
- `tests/hive-mission-e2e.test.ts`
  - approval callback count was `1` instead of `0` in full mode.
- `tests/context-builder.test.ts`
  - full-mode context still showed `task-scoped only`.
- `tests/bridge-security.test.ts`
  - full-mode operator-scope prompt text was missing.

## GREEN

### 3. Implemented minimal wiring

Files changed for implementation:

- `lib/workflow.ts`
- `lib/managed-workflows.ts`
- `lib/manager-scheduler.ts`
- `lib/context-builder.ts`
- `lib/hive-services.ts`
- `scripts/codex-bridge.mjs`
- `README.md`
- `.env.example`

Summary:

- Added permission-mode-aware workflow advancement.
- Added permission-mode-aware managed approval policy.
- Added permission-mode-aware manager scheduler behavior.
- Added permission-mode-aware worker context wording.
- Added permission-mode-aware manager/operator prompt wording.
- Updated docs/env wording for completed full-mode workflow wiring.

### 4. First GREEN targeted rerun

Command:

```powershell
node -e "require('fs').rmSync('.tmp-tests',{recursive:true,force:true})"
npx tsc -p tsconfig.tests.json
node --test .tmp-tests/tests/workflow.test.js .tmp-tests/tests/managed-workflows.test.js .tmp-tests/tests/hive-manager.test.js .tmp-tests/tests/hive-mission-e2e.test.js .tmp-tests/tests/context-builder.test.js .tmp-tests/tests/bridge-security.test.js
```

Observed result:

- Targeted run improved to `37` pass / `2` fail.

Remaining failures were test-fix follow-ups, not production regressions:

- Existing managed-workflows expectation needed explicit restricted mode.
- Full verification completion test needed one additional `advanceRun(..., "full")` step.

### 5. Final targeted GREEN rerun

Command:

```powershell
node -e "require('fs').rmSync('.tmp-tests',{recursive:true,force:true})"
npx tsc -p tsconfig.tests.json
node --test .tmp-tests/tests/workflow.test.js .tmp-tests/tests/managed-workflows.test.js .tmp-tests/tests/hive-manager.test.js .tmp-tests/tests/hive-mission-e2e.test.js .tmp-tests/tests/context-builder.test.js .tmp-tests/tests/bridge-security.test.js
```

Observed result:

- Targeted Task 3 suite passed: `39` pass / `0` fail.

## Required Verification

### 6. Standalone tests TypeScript compile

Command:

```powershell
npx tsc -p tsconfig.tests.json
```

Observed result:

- Exit code `0`

### 7. Full test suite

Command:

```powershell
npm test
```

Observed result:

- Exit code `0`
- Full suite passed: `185` pass / `0` fail

### 8. App typecheck

Command:

```powershell
npm run typecheck
```

Observed result:

- Exit code `0`

## Final Status

Task 3 implementation is complete and verified:

- Full mode bypasses workflow approvals and manager approval waits.
- Restricted mode keeps the existing approval-gated behavior.
- Audit/checkpoint recording for `request_approval` remains intact.
- Documentation now reflects that workflow full-mode wiring is complete.
