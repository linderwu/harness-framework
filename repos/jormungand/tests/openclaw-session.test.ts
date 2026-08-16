import assert from "node:assert/strict"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import test from "node:test"

async function loadOpenClawSessionHelper() {
  const loadModule = new Function(
    "modulePath",
    "return import(modulePath)"
  ) as (modulePath: string) => Promise<unknown>
  return await loadModule(
    pathToFileURL(resolve("scripts/openclaw-session.mjs")).href
  ) as {
    deriveOpenClawSessionKey: (input: {
      mainAgent?: string
      conversationId?: unknown
      workflowRunId?: unknown
      fallbackId?: unknown
      sessionKey?: unknown
    }) => string
    sanitizeConversationHistory: (value: unknown) => Array<{
      role: "user" | "assistant"
      content: string
    }>
  }
}

test("OpenClaw session derivation ignores caller-supplied session keys", async () => {
  const helper = await loadOpenClawSessionHelper()

  assert.equal(
    helper.deriveOpenClawSessionKey({
      mainAgent: "gengar",
      conversationId: "conversation:11111111-1111-4111-8111-111111111111",
      sessionKey: "attacker-controlled"
    }),
    "agent:gengar:harness-conversation-conversation-11111111-1111-4111-8111-111111111111"
  )

  assert.equal(
    helper.deriveOpenClawSessionKey({
      mainAgent: "rowlet",
      workflowRunId: "workflow/1",
      fallbackId: "ignored",
      sessionKey: "attacker-controlled"
    }),
    "agent:rowlet:harness-workflow-1"
  )
})

test("OpenClaw session keys stay bounded and isolate long identities", async () => {
  const helper = await loadOpenClawSessionHelper()
  const maxSessionKeyLength = 160
  const longIdentity = `conversation:${"x".repeat(2400)}`
  const longWorkflowRunId = `workflow:${"y".repeat(2400)}`
  const longFallbackId = `fallback:${"z".repeat(2400)}`

  const conversationKey = helper.deriveOpenClawSessionKey({
    mainAgent: "gengar",
    conversationId: longIdentity
  })
  const repeatedConversationKey = helper.deriveOpenClawSessionKey({
    mainAgent: "gengar",
    conversationId: longIdentity
  })
  const otherAgentConversationKey = helper.deriveOpenClawSessionKey({
    mainAgent: "rowlet",
    conversationId: longIdentity
  })
  const workflowKey = helper.deriveOpenClawSessionKey({
    mainAgent: "gengar",
    workflowRunId: longWorkflowRunId
  })
  const fallbackKey = helper.deriveOpenClawSessionKey({
    mainAgent: "gengar",
    fallbackId: longFallbackId
  })

  assert.equal(conversationKey, repeatedConversationKey)
  assert.notEqual(conversationKey, otherAgentConversationKey)
  for (const key of [
    conversationKey,
    otherAgentConversationKey,
    workflowKey,
    fallbackKey
  ]) {
    assert.ok(key.length <= maxSessionKeyLength)
  }
})

test("OpenClaw conversation history is shape-checked and capped at the bridge boundary", async () => {
  const helper = await loadOpenClawSessionHelper()
  const longContent = `${"x".repeat(1500)}\n${"y".repeat(1500)}`
  const history = helper.sanitizeConversationHistory([
    { role: "assistant", content: "drop-me-oldest" },
    ...Array.from({ length: 12 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: index === 11 ? longContent : `message-${index}`
    })),
    { role: "tool", content: "invalid-role" },
    { role: "user", content: 42 }
  ])

  assert.equal(history.length, 12)
  assert.equal(history[0]?.content, "message-0")
  assert.equal(history.at(-1)?.role, "assistant")
  assert.equal(history.at(-1)?.content.length, 1200)
  assert.equal(history.some((entry) => entry.content === "invalid-role"), false)
})
