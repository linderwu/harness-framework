import assert from "node:assert/strict"
import test from "node:test"
import {
  ConversationLifecycleCommandError,
  ConversationLifecycleService
} from "../lib/conversation-lifecycle/service"
import { ConversationTurnRepositoryError } from "../lib/hive-memory/repository"
import type { ConversationEntry, ExecutionJobStatus } from "../lib/hive-memory/types"

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
