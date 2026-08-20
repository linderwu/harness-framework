# Unbound Full Agent Execution RED Evidence

Date: 2026-08-20

This note records the TDD RED evidence for the unbound conversation test contract added in commit `7a32bb45c7c6ad66871828699f7e82d8e0cd0266`.

For the red tests themselves, only `tests/conversation-lifecycle-structure.test.ts` was changed. No production files were modified for that RED step.

## Command 1

```powershell
npx tsc -p tsconfig.tests.json
```

Observed output:

```text
tests/conversation-lifecycle-structure.test.ts(24,3): error TS2724: '"../lib/hive-services"' has no exported member named 'routeUnboundConversation'. Did you mean 'routeOpenClawUnboundConversation'?
```

Interpretation: test compilation is intentionally RED because `lib/hive-services` does not export `routeUnboundConversation`.

## Command 2

```powershell
node --test .tmp-tests/tests/conversation-lifecycle-structure.test.js
```

Observed output summary:

```text
✖ unbound Codex routing dispatches directly to Codex with unrestricted conversation skill context
  Error: listProjects should not be called for unbound Codex conversations

✖ unbound OpenClaw routing preserves conversation and agent identity at the bridge boundary
  TypeError: (0 , hive_services_1.routeUnboundConversation) is not a function

✖ unbound route helper advances conversation history cursor only after successful delivery
  TypeError: (0 , hive_services_1.routeUnboundConversation) is not a function
```

Observed regression set:

- Codex unbound routing still calls `listProjects`, proving it is not yet dispatching directly to Codex with the requested unbound skill.
- The shared OpenClaw helper path is still missing because `routeUnboundConversation` is not exported.
- The cursor-delivery helper test is also blocked by the missing `routeUnboundConversation` export.

No production code changes were made while collecting this evidence.
