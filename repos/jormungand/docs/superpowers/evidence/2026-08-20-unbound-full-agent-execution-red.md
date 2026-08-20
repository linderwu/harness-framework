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

Observed output:

```text
▶ conversation route contracts
  ✔ conversation GET returns a conversation id for durable client continuity (84.0754ms)
  ✔ conversation GET persists metadata when it creates a fresh unbound conversation (15.3077ms)
  ✔ conversation control route requires a conversation id for Codex session controls (15.925ms)
  ✔ conversation GET includes permission mode and current conversation metadata when available (13.7149ms)
  ✔ conversation new route persists active metadata as well as the cookie (16.5856ms)
  ✔ conversation new route returns the same 4xx JSON contract as the conversations create route (16.2757ms)
  ✔ conversations collection route creates managed conversations and filters archived items by default (14.5749ms)
  ✔ conversation detail route renames, archives, and requires delete confirmation (16.1455ms)
✔ conversation route contracts (193.8581ms)
✔ conversation service exposes an explicit new-conversation command (13.2155ms)
✔ posting a Codex message stores entries under the requested conversation id (16.4424ms)
✔ reading Codex conversation state uses the requested conversation id session (12.6023ms)
✔ Codex cursor updates stay monotonic and state exposes the persisted effective cursor (12.2867ms)
✖ unbound Codex routing dispatches directly to Codex with unrestricted conversation skill context
  Error: listProjects should not be called for unbound Codex conversations
✔ OpenClaw bridge session identity is derived from stable conversation input instead of only workflow ids (0.752ms)
✖ unbound OpenClaw routing preserves conversation and agent identity at the bridge boundary
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + actual - expected
  + 'conversation.unbound_limited'
  - 'conversation.unbound'
✖ unbound route helper advances conversation history cursor only after successful delivery
  TypeError: (0 , hive_services_1.routeUnboundConversation) is not a function
✔ OpenClaw A2A uses the bounded shared session identity for long conversations (248.1387ms)
ℹ tests 17
ℹ suites 1
ℹ pass 14
ℹ fail 3
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 627.7095

✖ failing tests:

test at .tmp-tests\tests\conversation-lifecycle-structure.test.js:484:25
✖ unbound Codex routing dispatches directly to Codex with unrestricted conversation skill context (12.9138ms)
  Error: listProjects should not be called for unbound Codex conversations
      at listProjects (C:\Users\Linder.Wu\Documents\jormungand\.worktrees\unbound-full-agent-execution\repos\jormungand\.tmp-tests\tests\conversation-lifecycle-structure.test.js:491:19)
      at Object.routeUnbound (C:\Users\Linder.Wu\Documents\jormungand\.worktrees\unbound-full-agent-execution\repos\jormungand\.tmp-tests\lib\hive-services.js:178:61)
      at ConversationService.postUnboundMessage (C:\Users\Linder.Wu\Documents\jormungand\.worktrees\unbound-full-agent-execution\repos\jormungand\.tmp-tests\lib\conversation.js:86:54)
      at async TestContext.<anonymous> (C:\Users\Linder.Wu\Documents\jormungand\.worktrees\unbound-full-agent-execution\repos\jormungand\.tmp-tests\tests\conversation-lifecycle-structure.test.js:507:5)
      at async Test.run (node:internal/test_runner/test:1125:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:787:7)

test at .tmp-tests\tests\conversation-lifecycle-structure.test.js:525:25
✖ unbound OpenClaw routing preserves conversation and agent identity at the bridge boundary (18.7757ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + actual - expected
  
  + 'conversation.unbound_limited'
  - 'conversation.unbound'
                         ^
  
      at assertUnrestrictedUnboundSkill (C:\Users\Linder.Wu\Documents\jormungand\.worktrees\unbound-full-agent-execution\repos\jormungand\.tmp-tests\tests\conversation-lifecycle-structure.test.js:107:22)
      at TestContext.<anonymous> (C:\Users\Linder.Wu\Documents\jormungand\.worktrees\unbound-full-agent-execution\repos\jormungand\.tmp-tests\tests\conversation-lifecycle-structure.test.js:565:9)
      at async Test.run (node:internal/test_runner/test:1125:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:787:7) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: 'conversation.unbound_limited',
    expected: 'conversation.unbound',
    operator: 'strictEqual',
    diff: 'simple'
  }

test at .tmp-tests\tests\conversation-lifecycle-structure.test.js:586:25
✖ unbound route helper advances conversation history cursor only after successful delivery (0.4013ms)
  TypeError: (0 , hive_services_1.routeUnboundConversation) is not a function
      at TestContext.<anonymous> (C:\Users\Linder.Wu\Documents\jormungand\.worktrees\unbound-full-agent-execution\repos\jormungand\.tmp-tests\tests\conversation-lifecycle-structure.test.js:598:56)
      at Test.runInAsyncScope (node:async_hooks:228:14)
      at Test.run (node:internal/test_runner/test:1118:25)
      at Test.processPendingSubtests (node:internal/test_runner/test:787:18)
      at Test.postRun (node:internal/test_runner/test:1247:19)
      at Test.run (node:internal/test_runner/test:1175:12)
      at async Test.processPendingSubtests (node:internal/test_runner/test:787:7)
```

Observed regression set:

- Codex unbound routing still calls `listProjects`, proving it is not yet dispatching directly to Codex with the requested unbound skill.
- The live OpenClaw unbound route still emits `conversation.unbound_limited` instead of `conversation.unbound`.
- The cursor-delivery helper test is also blocked by the missing `routeUnboundConversation` export.

No production code changes were made while collecting this evidence.
