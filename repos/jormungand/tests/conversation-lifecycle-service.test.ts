import assert from "node:assert/strict"
import test from "node:test"
import {
  ConversationLifecycleCommandError,
  ConversationLifecycleService
} from "../lib/conversation-lifecycle/service"
import { ConversationTurnRepositoryError } from "../lib/hive-memory/repository"
import type { ConversationEntry, ExecutionJob, ExecutionJobStatus } from "../lib/hive-memory/types"
import type { ProviderOutcome } from "../lib/conversation-lifecycle/types"

function entry(id: string): ConversationEntry {
  return {
    id,
    workflowRunId: "conversation:tx1",
    role: "user",
    agentId: "codex",
    content: "content",
    importance: "normal",
    status: "queued",
    artifactIds: [],
    memoryIds: [],
    idempotencyKey: id,
    createdAt: "2026-01-01T00:00:00.000Z"
  }
}

function submittedTurn() {
  return {
    conversationId: "conversation:tx1",
    userEntryId: "user-1",
    responseEntryId: "response-1",
    jobId: "job-1",
    idempotencyKey: "canonical-key",
    userEntry: entry("user-1"),
    responseEntry: { ...entry("response-1"), role: "agent" as const, replyToId: "user-1" },
    jobStatus: "queued" as ExecutionJobStatus,
    duplicate: false
  }
}

function settledTurn() {
  const submitted = submittedTurn()
  const job: ExecutionJob = {
    id: submitted.jobId,
    kind: "conversation_dispatch",
    workflowRunId: submitted.conversationId,
    payloadJson: "{}",
    idempotencyKey: `${submitted.idempotencyKey}:dispatch`,
    status: "completed",
    attemptCount: 1,
    availableAt: "2026-01-01T00:00:00.000Z",
    resultJson: "{}",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:00.000Z"
  }
  return {
    applied: true,
    conversationId: submitted.conversationId,
    userEntryId: submitted.userEntryId,
    responseEntryId: submitted.responseEntryId,
    jobId: submitted.jobId,
    idempotencyKey: submitted.idempotencyKey,
    userEntry: { ...submitted.userEntry, status: "completed" as const },
    responseEntry: { ...submitted.responseEntry, status: "completed" as const },
    job
  }
}

test("SubmitTurn validates inputs, canonicalizes the idempotency key, and preserves accepted content", async () => {
  const calls: unknown[] = []
  const service = new ConversationLifecycleService({
    submitConversationTurn: async (input) => {
      calls.push(input)
      return submittedTurn()
    }
  })

  const result = await service.submitTurn({
    conversationId: "conversation:tx1",
    targetAgent: "codex",
    content: "  preserve me  ",
    idempotencyKey: "  canonical-key  ",
    responseRole: "agent"
  })

  assert.equal(result.userEntryId, "user-1")
  assert.deepEqual(calls, [{
    conversationId: "conversation:tx1",
    targetAgent: "codex",
    content: "  preserve me  ",
    idempotencyKey: "canonical-key",
    responseRole: "agent"
  }])
})

test("SubmitTurn maps validation errors to stable command codes and statuses", async () => {
  const service = new ConversationLifecycleService({
    submitConversationTurn: async () => submittedTurn()
  })
  const cases = [
    [{ content: "   " }, "content_required", 400],
    [{ idempotencyKey: "   " }, "idempotency_key_required", 400],
    [{ responseRole: "system" }, "invalid_response_role", 400]
  ] as const

  for (const [partial, code, status] of cases) {
    await assert.rejects(
      () => service.submitTurn({
        conversationId: "conversation:tx1",
        targetAgent: "codex",
        content: "content",
        idempotencyKey: "key",
        ...partial
      }),
      (error: unknown) =>
        error instanceof ConversationLifecycleCommandError &&
        error.code === code &&
        error.status === status
    )
  }
})

test("SubmitTurn rejects malformed UTF-16 idempotency keys before calling the repository", async () => {
  const calls: unknown[] = []
  const service = new ConversationLifecycleService({
    submitConversationTurn: async (input) => {
      calls.push(input)
      return submittedTurn()
    }
  })

  for (const idempotencyKey of ["\uD800", "\uDC00"]) {
    await assert.rejects(
      () => service.submitTurn({
        conversationId: "conversation:tx1",
        targetAgent: "codex",
        content: "content",
        idempotencyKey
      }),
      (error: unknown) =>
        error instanceof ConversationLifecycleCommandError &&
        error.code === "invalid_idempotency_key" &&
        error.status === 400
    )
  }

  assert.deepEqual(calls, [])
})

test("SubmitTurn maps repository lifecycle errors without coupling to a broader repository", async () => {
  const mappings = [
    ["conversation_not_found", "conversation_not_found", 404],
    ["conversation_not_active", "conversation_not_active", 409],
    ["incomplete_turn_record", "incomplete_turn_record", 409],
    ["invalid_idempotency_key", "invalid_idempotency_key", 400]
  ] as const

  for (const [repositoryCode, commandCode, status] of mappings) {
    const service = new ConversationLifecycleService({
      submitConversationTurn: async () => {
        throw new ConversationTurnRepositoryError(repositoryCode)
      }
    })
    await assert.rejects(
      () => service.submitTurn({
        conversationId: "conversation:tx1",
        targetAgent: "codex",
        content: "content",
        idempotencyKey: "key"
      }),
      (error: unknown) =>
        error instanceof ConversationLifecycleCommandError &&
        error.code === commandCode &&
        error.status === status
    )
  }
})

test("ClaimNextTurn delegates its atomic claim and owner-checked renewal without accepting Runtime work", async () => {
  const calls: unknown[] = []
  const envelope = Object.freeze({
    conversationId: "conversation:tx2",
    userEntryId: "user-1",
    responseEntryId: "response-1",
    jobId: "job-1",
    idempotencyKey: "turn-1",
    leaseOwner: "worker-1",
    leaseExpiresAt: "2026-01-01T00:01:00.000Z",
    attemptCount: 1,
    targetAgent: "codex" as const,
    content: "content",
    userEntry: entry("user-1"),
    responseEntry: { ...entry("response-1"), role: "agent" as const, replyToId: "user-1" }
  })
  const repository = {
    submitConversationTurn: async () => submittedTurn(),
    claimNextConversationTurn: async (input: unknown) => {
      calls.push(["claim", input])
      return envelope
    },
    renewExecutionJobLease: async (input: unknown) => {
      calls.push(["renew", input])
      return { id: "job-1", leaseOwner: "worker-1" }
    }
  }
  const service = new ConversationLifecycleService(repository)

  assert.equal(await service.claimNextTurn({
    conversationId: "conversation:tx2",
    leaseOwner: "worker-1",
    leaseDurationMs: 60_000
  }), envelope)
  await service.renewTurnLease({
    jobId: "job-1",
    leaseOwner: "worker-1",
    leaseDurationMs: 120_000
  })
  assert.deepEqual(calls, [
    ["claim", { conversationId: "conversation:tx2", leaseOwner: "worker-1", leaseDurationMs: 60_000 }],
    ["renew", { id: "job-1", leaseOwner: "worker-1", leaseDurationMs: 120_000 }]
  ])
})

test("SettleTurn delegates one ProviderOutcome to TX3 without accepting Runtime work", async () => {
  const calls: unknown[] = []
  const outcome: ProviderOutcome = {
    kind: "completed",
    body: "  exact response whitespace  ",
    deliveryState: "confirmed"
  }
  const service = new ConversationLifecycleService({
    submitConversationTurn: async () => submittedTurn(),
    settleConversationTurn: async (input: unknown) => {
      calls.push(input)
      return settledTurn()
    }
  })

  const result = await service.settleTurn({
    conversationId: "conversation:tx3",
    userEntryId: "user-1",
    responseEntryId: "response-1",
    jobId: "job-1",
    idempotencyKey: "turn-1",
    leaseOwner: "worker-1",
    outcome
  })

  assert.equal(result.applied, true)
  assert.deepEqual(calls, [{
    conversationId: "conversation:tx3",
    userEntryId: "user-1",
    responseEntryId: "response-1",
    jobId: "job-1",
    idempotencyKey: "turn-1",
    leaseOwner: "worker-1",
    outcome
  }])
})

test("cancel pending delegates aggregate cancellation to the lifecycle repository", async () => {
  const calls: unknown[] = []
  const service = new ConversationLifecycleService({
    submitConversationTurn: async () => submittedTurn(),
    cancelQueuedConversationDispatches: async (conversationId: string) => {
      calls.push(conversationId)
      return 2
    }
  })

  assert.equal(await service.cancelPendingTurns("conversation:pending"), 2)
  assert.deepEqual(calls, ["conversation:pending"])
})

test("StopTurn delegates the current running aggregate without accepting provider state", async () => {
  const calls: unknown[] = []
  const result = settledTurn()
  const service = new ConversationLifecycleService({
    submitConversationTurn: async () => submittedTurn(),
    stopConversationTurn: async (conversationId: string) => {
      calls.push(conversationId)
      return result
    }
  })

  assert.equal(await service.stopTurn("conversation:running"), result)
  assert.deepEqual(calls, ["conversation:running"])
})
