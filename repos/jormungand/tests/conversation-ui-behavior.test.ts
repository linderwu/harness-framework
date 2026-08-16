import assert from "node:assert/strict"
import { lstat, mkdir, realpath, rm, symlink } from "node:fs/promises"
import { join } from "node:path"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import test from "node:test"
import type { AgentKind } from "../lib/types"
import { createWorkflowRun } from "../lib/workflow"

async function ensureCompiledAlias() {
  const tmpRoot = join(process.cwd(), ".tmp-tests")
  const scopedRoot = join(tmpRoot, "node_modules", "@")
  const libLink = join(scopedRoot, "lib")
  const expectedTarget = join(tmpRoot, "lib")

  await mkdir(scopedRoot, { recursive: true })
  const existingLink = await lstat(libLink).catch(() => undefined)
  const existingTarget = existingLink?.isSymbolicLink()
    ? await realpath(libLink).catch(() => undefined)
    : undefined
  const expectedRealTarget = await realpath(expectedTarget).catch(() => undefined)
  if (existingTarget && expectedRealTarget && existingTarget === expectedRealTarget) {
    return
  }
  if (existingLink) {
    await rm(libLink, { recursive: true, force: true })
  }
  await symlink(expectedTarget, libLink, "junction").catch(async (error) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  })
}

async function loadTaskConversation() {
  await ensureCompiledAlias()
  const taskConversationModule = await import("../components/task-conversation") as typeof import("../components/task-conversation")
  return taskConversationModule.TaskConversation
}

function createRun() {
  return createWorkflowRun({
    projectId: "project-1",
    projectName: "Mission",
    projectType: "hive_mission",
    repository: "owner/repo",
    requirement: "Verify initial conversation hydration",
    selectedAgent: "codex",
    designApprovalActor: "human",
    verificationApprovalActor: "human"
  })
}

function renderInitialConversation(
  TaskConversation: ReturnType<typeof loadTaskConversation> extends Promise<infer T> ? T : never,
  run?: ReturnType<typeof createRun>
) {
  return renderToStaticMarkup(createElement(TaskConversation, {
    run,
    initialEntries: [],
    allowedAgents: ["codex"] satisfies AgentKind[],
    onEntriesChanged: () => undefined
  }))
}

function assertInitialHydrationGate(markup: string, label: string) {
  const buttons = markup.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? []
  const newConversationButton = buttons.find((button) => button.includes('aria-label="New conversation"'))
  assert.ok(newConversationButton, `${label} must keep the new conversation action identifiable while loading`)
  assert.match(newConversationButton, /disabled=""/)
  assert.match(newConversationButton, /Loading\.\.\./)

  const sendButton = buttons.find((button) => button.includes('class="primaryButton"'))
  assert.ok(sendButton, `${label} must render the Send button`)
  assert.match(sendButton, /disabled=""/)
}

test("actual TaskConversation render keeps Send disabled before an unbound conversation id hydrates", async () => {
  const TaskConversation = await loadTaskConversation()

  // SSR intentionally does not run GET effects or click handlers; this test observes the actual pre-hydration markup.
  const boundMarkup = renderInitialConversation(TaskConversation, createRun())
  const remountedUnboundMarkup = renderInitialConversation(TaskConversation)

  assertInitialHydrationGate(boundMarkup, "bound initial mount")
  assertInitialHydrationGate(remountedUnboundMarkup, "bound-to-unbound remount")
})
