import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import type { AgentInvocationInput } from "../lib/agent-bridge"
import { getAgentProfile } from "../lib/agents"
import { routeUnboundConversation } from "../lib/hive-services"
import { openHiveDatabase } from "../lib/hive-memory/database"
import { createHiveMemoryRepository } from "../lib/hive-memory/repository"
import type { AgentKind } from "../lib/types"

async function repositoryFixture(t: test.TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-conversation-lifecycle-characterization-"))
  const database = openHiveDatabase({ dataDir })
  const repository = createHiveMemoryRepository(database)
  t.after(async () => {
    database.close()
    await rm(dataDir, { recursive: true, force: true })
  })
  return repository
}

test("Runtime path preserves the selected Agent Profile and submission identity", async (t) => {
  const repository = await repositoryFixture(t)
  const runtimePaths: Array<{ name: string; targetAgent: AgentKind }> = [
    { name: "Codex Runtime path", targetAgent: "codex" },
    { name: "Lucky Runtime path", targetAgent: "mavis" },
    { name: "OpenClaw Runtime path", targetAgent: "openclaw.rowlet" }
  ]

  for (const runtimePath of runtimePaths) {
    const conversationId = `conversation:phase-0-${runtimePath.targetAgent}`
    const idempotencyKey = `phase-0-runtime:${runtimePath.targetAgent}`
    const capturedInputs: AgentInvocationInput[] = []
    const body = `${runtimePath.name} response`
    const result = await routeUnboundConversation({
      repository,
      conversationId,
      targetAgent: runtimePath.targetAgent,
      content: `Characterize ${runtimePath.name}.`,
      idempotencyKey,
      entries: [{
        id: `entry:${runtimePath.targetAgent}`,
        role: "user",
        agentId: runtimePath.targetAgent,
        content: `Characterize ${runtimePath.name}.`
      }],
      invokeAgent: async (input) => {
        capturedInputs.push(input)
        return {
          status: "completed",
          source: "simulated",
          body
        }
      }
    })

    assert.equal(capturedInputs.length, 1, runtimePath.name)
    const invocation = capturedInputs[0]
    assert.deepEqual(
      getAgentProfile(invocation!.executor),
      getAgentProfile(runtimePath.targetAgent),
      runtimePath.name
    )
    assert.equal(invocation?.run.selectedAgent, runtimePath.targetAgent, runtimePath.name)
    assert.equal(invocation?.conversationId, conversationId, runtimePath.name)
    assert.equal(invocation?.idempotencyKey, idempotencyKey, runtimePath.name)
    assert.deepEqual(Object.keys(result).sort(), ["body", "status"])
    assert.deepEqual(result, { status: "completed", body })
  }
})
