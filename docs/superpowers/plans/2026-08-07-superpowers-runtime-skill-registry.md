# Superpowers Runtime Skill Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add curated Superpowers runtime skill bundle resolution to Jormungand and deliver locked bundle descriptors to remote agents for agent-local installation.

**Architecture:** Keep workflow event skills and runtime skill bundles separate. Jormungand resolves `superpowers-full` from committed registry and lockfile data, passes verified descriptors to bridge protocol v0.3 agents, and records agent attestation in the existing workflow audit surfaces.

**Tech Stack:** Next.js 16, TypeScript 5.7, Node built-in test runner, Node filesystem/crypto/fetch APIs, existing harness bridge script.

---

## File Structure

- Create `.harness/skill-registry.json`: committed curated runtime skill catalog.
- Create `.harness/skill.lock.json`: committed strict lockfile for executable bundle versions.
- Modify `.gitignore`: ignore `.harness/cache/` and `.harness/runtime-skills/`.
- Modify `lib/types.ts`: add runtime skill bundle types and `WorkflowEventSkill.runtimeSkillBundles`.
- Create `lib/runtime-skills.ts`: pure resolver for registry plus lockfile bundle descriptors and attestation helpers.
- Modify `lib/workflow.ts`: declare `superpowers-full` on selected event skills, resolve bundle descriptors before agent invocation, and record audit status in event notes and agent run status messages.
- Modify `lib/agent-bridge.ts`: send bridge v0.3 payloads when runtime bundles are present, gate unsupported bridge protocol versions, and accept runtime bundle attestation in bridge responses.
- Modify `scripts/codex-bridge.mjs`: advertise v0.3 when runtime skills are enabled, install runtime bundles locally, add installed paths to the agent prompt, and return attestation.
- Modify `tests/workspace-model.test.ts`: cover default event declarations and workflow audit behavior.
- Create `tests/runtime-skills.test.ts`: cover registry/lockfile resolver success and failure modes.
- Modify `package.json`: compile and run the new test file in `npm run test`.
- Update `docs/workflow-event-skills.md`: document runtime bundle declarations and remote-agent install flow.

## Task 1: Runtime Skill Types And Event Declarations

**Files:**
- Modify: `lib/types.ts`
- Modify: `lib/workflow.ts`
- Modify: `tests/workspace-model.test.ts`

- [ ] **Step 1: Write failing tests for default runtime bundle declarations**

Append these tests to `tests/workspace-model.test.ts`:

```ts
test("default workflow event skills declare Superpowers for agent-executed development events", () => {
  const run = createWorkflowRun({
    projectId: "project-1",
    projectName: "Runtime Skills",
    repository: "linderwu/harness-framework",
    requirement: "Use Superpowers during agent execution.",
    selectedAgent: "codex",
    designApprovalActor: "human",
    verificationApprovalActor: "human"
  })

  const bundleBySkill = Object.fromEntries(
    run.eventSkills.map((skill) => [skill.id, skill.runtimeSkillBundles ?? []])
  )

  assert.deepEqual(bundleBySkill["plan.interview"], ["superpowers-full"])
  assert.deepEqual(bundleBySkill["plan.review"], ["superpowers-full"])
  assert.deepEqual(bundleBySkill["design.openspec"], ["superpowers-full"])
  assert.deepEqual(bundleBySkill["implementation.dispatch"], ["superpowers-full"])
  assert.deepEqual(bundleBySkill["implementation.code_review"], ["superpowers-full"])
  assert.deepEqual(bundleBySkill["verification.implementation_review"], ["superpowers-full"])
  assert.deepEqual(bundleBySkill["verification.generate"], ["superpowers-full"])
  assert.deepEqual(bundleBySkill["closeout.archive"], ["superpowers-full"])
})

test("default workflow event skills do not declare runtime bundles for intake or approval gates", () => {
  const run = createWorkflowRun({
    projectId: "project-1",
    projectName: "Runtime Skills",
    repository: "linderwu/harness-framework",
    requirement: "Use Superpowers during agent execution.",
    selectedAgent: "codex",
    designApprovalActor: "human",
    verificationApprovalActor: "human"
  })

  const bundleBySkill = Object.fromEntries(
    run.eventSkills.map((skill) => [skill.id, skill.runtimeSkillBundles ?? []])
  )

  assert.deepEqual(bundleBySkill["intake.requirement"], [])
  assert.deepEqual(bundleBySkill["plan.approval"], [])
  assert.deepEqual(bundleBySkill["design.approval"], [])
  assert.deepEqual(bundleBySkill["verification.approval"], [])
})
```

- [ ] **Step 2: Run tests to verify the type failure**

Run:

```bash
npm run test
```

Expected: TypeScript compilation fails because `WorkflowEventSkill` does not define `runtimeSkillBundles`.

- [ ] **Step 3: Add runtime skill types**

In `lib/types.ts`, add these types after `EventLogStatus`:

```ts
export type RuntimeSkillChecksumAlgorithm = "sha256"

export interface RuntimeSkillChecksum {
  algorithm: RuntimeSkillChecksumAlgorithm
  value: string
}

export interface RuntimeSkillBundleDescriptor {
  id: string
  version: string
  sourceUrl: string
  checksum: RuntimeSkillChecksum
  required: boolean
}

export type RuntimeSkillCacheStatus = "hit" | "miss" | "refreshed"

export interface RuntimeSkillBundleResult {
  id: string
  version: string
  checksum: RuntimeSkillChecksum
  downloadSource: "github-release" | "cache" | "unknown"
  cacheStatus: RuntimeSkillCacheStatus
  verified: boolean
  installedPath?: string
  errorCode?: string
  errorMessage?: string
}

export type RuntimeSkillResolutionErrorCode =
  | "resolution_failed"
  | "registry_not_found"
  | "lockfile_not_found"
  | "bundle_not_in_registry"
  | "bundle_not_locked"
  | "lockfile_registry_mismatch"
  | "runtime_skill_protocol_unsupported"

export interface RuntimeSkillResolutionSuccess {
  status: "completed"
  bundles: RuntimeSkillBundleDescriptor[]
}

export interface RuntimeSkillResolutionFailure {
  status: "failed"
  errorCode: RuntimeSkillResolutionErrorCode
  errorMessage: string
}

export type RuntimeSkillResolution =
  | RuntimeSkillResolutionSuccess
  | RuntimeSkillResolutionFailure
```

Then add the optional field to `WorkflowEventSkill`:

```ts
  runtimeSkillBundles?: string[]
```

- [ ] **Step 4: Declare Superpowers on selected default skills**

In `lib/workflow.ts`, add this helper near `eventTypeLabels`:

```ts
const superpowersRuntimeBundles = ["superpowers-full"]
```

Add `runtimeSkillBundles: superpowersRuntimeBundles` to these `createDefaultEventSkills()` entries:

```ts
// plan.interview
runtimeSkillBundles: superpowersRuntimeBundles,

// plan.review
runtimeSkillBundles: superpowersRuntimeBundles,

// design.openspec
runtimeSkillBundles: superpowersRuntimeBundles,

// implementation.dispatch
runtimeSkillBundles: superpowersRuntimeBundles,

// implementation.code_review
runtimeSkillBundles: superpowersRuntimeBundles,

// verification.implementation_review
runtimeSkillBundles: superpowersRuntimeBundles,

// verification.generate
runtimeSkillBundles: superpowersRuntimeBundles,

// closeout.archive
runtimeSkillBundles: superpowersRuntimeBundles,
```

Do not add the field to `intake.requirement`, `plan.approval`, `design.approval`, or `verification.approval`.

- [ ] **Step 5: Run tests to verify declarations pass**

Run:

```bash
npm run test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/types.ts lib/workflow.ts tests/workspace-model.test.ts
git commit -m "Declare runtime skill bundle requirements"
```

## Task 2: Registry And Lockfile Resolver

**Files:**
- Create: `.harness/skill-registry.json`
- Create: `.harness/skill.lock.json`
- Modify: `.gitignore`
- Create: `lib/runtime-skills.ts`
- Create: `tests/runtime-skills.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write resolver tests**

Create `tests/runtime-skills.test.ts`:

```ts
import assert from "node:assert/strict"
import test from "node:test"
import {
  resolveRuntimeSkillBundles,
  type RuntimeSkillLockfile,
  type RuntimeSkillRegistry
} from "../lib/runtime-skills"

const checksum = {
  algorithm: "sha256" as const,
  value: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
}

const registry: RuntimeSkillRegistry = {
  schemaVersion: "runtime-skills/v1",
  bundles: [
    {
      id: "superpowers-full",
      versions: [
        {
          version: "1.0.0",
          sourceUrl: "https://github.com/linderwu/harness-framework/releases/download/skills-v1.0.0/superpowers-full-1.0.0.tgz",
          checksum,
          skills: ["brainstorming", "tdd", "verification-before-completion"]
        }
      ]
    }
  ]
}

const lockfile: RuntimeSkillLockfile = {
  schemaVersion: "runtime-skills-lock/v1",
  lockedBundles: [
    {
      id: "superpowers-full",
      version: "1.0.0",
      sourceUrl: "https://github.com/linderwu/harness-framework/releases/download/skills-v1.0.0/superpowers-full-1.0.0.tgz",
      checksum
    }
  ]
}

test("runtime skill resolver returns required descriptors from the strict lockfile", () => {
  const result = resolveRuntimeSkillBundles({
    requestedBundleIds: ["superpowers-full"],
    registry,
    lockfile
  })

  assert.equal(result.status, "completed")
  assert.deepEqual(result.status === "completed" ? result.bundles : [], [
    {
      id: "superpowers-full",
      version: "1.0.0",
      sourceUrl: "https://github.com/linderwu/harness-framework/releases/download/skills-v1.0.0/superpowers-full-1.0.0.tgz",
      checksum,
      required: true
    }
  ])
})

test("runtime skill resolver fails when a requested bundle is not locked", () => {
  const result = resolveRuntimeSkillBundles({
    requestedBundleIds: ["missing-bundle"],
    registry,
    lockfile
  })

  assert.equal(result.status, "failed")
  assert.equal(result.status === "failed" ? result.errorCode : "", "bundle_not_locked")
})

test("runtime skill resolver fails when a locked bundle is not in the curated registry", () => {
  const result = resolveRuntimeSkillBundles({
    requestedBundleIds: ["superpowers-full"],
    registry: { ...registry, bundles: [] },
    lockfile
  })

  assert.equal(result.status, "failed")
  assert.equal(result.status === "failed" ? result.errorCode : "", "bundle_not_in_registry")
})

test("runtime skill resolver fails when lockfile and registry checksum differ", () => {
  const result = resolveRuntimeSkillBundles({
    requestedBundleIds: ["superpowers-full"],
    registry,
    lockfile: {
      ...lockfile,
      lockedBundles: [
        {
          ...lockfile.lockedBundles[0],
          checksum: {
            algorithm: "sha256",
            value: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
          }
        }
      ]
    }
  })

  assert.equal(result.status, "failed")
  assert.equal(
    result.status === "failed" ? result.errorCode : "",
    "lockfile_registry_mismatch"
  )
})
```

- [ ] **Step 2: Update the test script**

In `package.json`, replace the `test` script with:

```json
"test": "node -e \"require('fs').rmSync('.tmp-tests',{recursive:true,force:true})\" && tsc tests/workspace-model.test.ts tests/runtime-skills.test.ts lib/project-templates.ts lib/workspace.ts lib/workflow.ts lib/runtime-skills.ts --outDir .tmp-tests --module commonjs --target es2022 --moduleResolution node --baseUrl . --esModuleInterop --skipLibCheck && node --test .tmp-tests/tests/*.test.js"
```

- [ ] **Step 3: Run tests to verify missing module failure**

Run:

```bash
npm run test
```

Expected: FAIL because `../lib/runtime-skills` does not exist.

- [ ] **Step 4: Create the resolver**

Create `lib/runtime-skills.ts`:

```ts
import type {
  RuntimeSkillBundleDescriptor,
  RuntimeSkillChecksum,
  RuntimeSkillResolution
} from "./types"

export interface RuntimeSkillRegistryVersion {
  version: string
  sourceUrl: string
  checksum: RuntimeSkillChecksum
  skills: string[]
}

export interface RuntimeSkillRegistryBundle {
  id: string
  versions: RuntimeSkillRegistryVersion[]
}

export interface RuntimeSkillRegistry {
  schemaVersion: "runtime-skills/v1"
  bundles: RuntimeSkillRegistryBundle[]
}

export interface RuntimeSkillLockedBundle {
  id: string
  version: string
  sourceUrl: string
  checksum: RuntimeSkillChecksum
}

export interface RuntimeSkillLockfile {
  schemaVersion: "runtime-skills-lock/v1"
  lockedBundles: RuntimeSkillLockedBundle[]
}

export function resolveRuntimeSkillBundles(input: {
  requestedBundleIds: string[]
  registry: RuntimeSkillRegistry
  lockfile: RuntimeSkillLockfile
}): RuntimeSkillResolution {
  const descriptors: RuntimeSkillBundleDescriptor[] = []

  for (const requestedBundleId of input.requestedBundleIds) {
    const lockedBundle = input.lockfile.lockedBundles.find(
      (bundle) => bundle.id === requestedBundleId
    )

    if (!lockedBundle) {
      return failure(
        "bundle_not_locked",
        `Runtime skill bundle "${requestedBundleId}" is not present in skill.lock.json.`
      )
    }

    const registryBundle = input.registry.bundles.find(
      (bundle) => bundle.id === requestedBundleId
    )
    const registryVersion = registryBundle?.versions.find(
      (version) => version.version === lockedBundle.version
    )

    if (!registryVersion) {
      return failure(
        "bundle_not_in_registry",
        `Runtime skill bundle "${requestedBundleId}" version "${lockedBundle.version}" is not approved in skill-registry.json.`
      )
    }

    if (!matchesRegistryVersion(lockedBundle, registryVersion)) {
      return failure(
        "lockfile_registry_mismatch",
        `Runtime skill bundle "${requestedBundleId}" lockfile entry does not match the curated registry entry.`
      )
    }

    descriptors.push({
      id: lockedBundle.id,
      version: lockedBundle.version,
      sourceUrl: lockedBundle.sourceUrl,
      checksum: lockedBundle.checksum,
      required: true
    })
  }

  return {
    status: "completed",
    bundles: descriptors
  }
}

function matchesRegistryVersion(
  lockedBundle: RuntimeSkillLockedBundle,
  registryVersion: RuntimeSkillRegistryVersion
) {
  return (
    lockedBundle.sourceUrl === registryVersion.sourceUrl &&
    lockedBundle.checksum.algorithm === registryVersion.checksum.algorithm &&
    lockedBundle.checksum.value === registryVersion.checksum.value
  )
}

function failure(
  errorCode:
    | "bundle_not_in_registry"
    | "bundle_not_locked"
    | "lockfile_registry_mismatch",
  errorMessage: string
): RuntimeSkillResolution {
  return {
    status: "failed",
    errorCode,
    errorMessage
  }
}
```

- [ ] **Step 5: Add committed registry and lockfile**

Create `.harness/skill-registry.json`:

```json
{
  "schemaVersion": "runtime-skills/v1",
  "bundles": [
    {
      "id": "superpowers-full",
      "versions": [
        {
          "version": "1.0.0",
          "sourceUrl": "https://github.com/linderwu/harness-framework/releases/download/skills-v1.0.0/superpowers-full-1.0.0.tgz",
          "checksum": {
            "algorithm": "sha256",
            "value": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
          },
          "skills": [
            "brainstorming",
            "tdd",
            "verification-before-completion"
          ]
        }
      ]
    }
  ]
}
```

Create `.harness/skill.lock.json`:

```json
{
  "schemaVersion": "runtime-skills-lock/v1",
  "lockedBundles": [
    {
      "id": "superpowers-full",
      "version": "1.0.0",
      "sourceUrl": "https://github.com/linderwu/harness-framework/releases/download/skills-v1.0.0/superpowers-full-1.0.0.tgz",
      "checksum": {
        "algorithm": "sha256",
        "value": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
      }
    }
  ]
}
```

- [ ] **Step 6: Ignore local runtime caches**

Append these entries to `.gitignore`:

```gitignore
.harness/cache/
.harness/runtime-skills/
```

- [ ] **Step 7: Run tests**

Run:

```bash
npm run test
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add .gitignore .harness/skill-registry.json .harness/skill.lock.json lib/runtime-skills.ts tests/runtime-skills.test.ts package.json
git commit -m "Resolve locked runtime skill bundles"
```

## Task 3: Workflow Runtime Skill Resolution And Audit

**Files:**
- Modify: `lib/workflow.ts`
- Modify: `tests/workspace-model.test.ts`

- [ ] **Step 1: Write failing workflow audit tests**

Append this test to `tests/workspace-model.test.ts`:

```ts
test("agent invocation receives resolved runtime skill bundle descriptors", async () => {
  const run = createWorkflowRun({
    projectId: "project-1",
    projectName: "Runtime Skills",
    repository: "linderwu/harness-framework",
    requirement: "Use Superpowers during planning.",
    selectedAgent: "codex",
    designApprovalActor: "human",
    verificationApprovalActor: "human"
  })
  run.currentStage = "plan"

  const nextRun = await advanceWorkflow(run, {
    resolveRuntimeSkillBundles: () => ({
      status: "completed",
      bundles: [
        {
          id: "superpowers-full",
          version: "1.0.0",
          sourceUrl: "https://github.com/linderwu/harness-framework/releases/download/skills-v1.0.0/superpowers-full-1.0.0.tgz",
          checksum: {
            algorithm: "sha256",
            value: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
          },
          required: true
        }
      ]
    }),
    invokeAgent: async (input) => ({
      status: "completed",
      source: "codex-bridge",
      body: "Plan with Superpowers.",
      runtimeSkillBundleResults: [
        {
          id: "superpowers-full",
          version: "1.0.0",
          checksum: {
            algorithm: "sha256",
            value: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
          },
          downloadSource: "github-release",
          cacheStatus: "hit",
          verified: true,
          installedPath: "/agent/.harness/runtime-skills/superpowers-full/1.0.0"
        }
      ],
      statusMessage: `received ${input.runtimeSkillBundles?.length ?? 0} runtime bundle`
    })
  })

  assert.equal(nextRun.agentRuns[0].statusMessage?.includes("runtimeSkillBundleResults"), true)
  assert.equal(nextRun.events[0].note?.includes("runtimeSkillResolution"), true)
})

test("workflow fails before agent invocation when runtime skill resolution fails", async () => {
  const run = createWorkflowRun({
    projectId: "project-1",
    projectName: "Runtime Skills",
    repository: "linderwu/harness-framework",
    requirement: "Use Superpowers during planning.",
    selectedAgent: "codex",
    designApprovalActor: "human",
    verificationApprovalActor: "human"
  })
  run.currentStage = "plan"
  let invoked = false

  const nextRun = await advanceWorkflow(run, {
    resolveRuntimeSkillBundles: () => ({
      status: "failed",
      errorCode: "bundle_not_locked",
      errorMessage: "Runtime skill bundle is not locked."
    }),
    invokeAgent: async () => {
      invoked = true
      return {
        status: "completed",
        source: "codex-bridge",
        body: "Should not run."
      }
    }
  })

  assert.equal(invoked, false)
  assert.equal(nextRun.status, "failed")
  assert.equal(nextRun.events[0].note?.includes("bundle_not_locked"), true)
})
```

- [ ] **Step 2: Run tests to verify the missing option fields**

Run:

```bash
npm run test
```

Expected: FAIL because `advanceWorkflow` does not accept `resolveRuntimeSkillBundles`, `AgentInvocationInput` has no `runtimeSkillBundles`, and `AgentArtifactResult` has no `runtimeSkillBundleResults`.

- [ ] **Step 3: Extend workflow interfaces**

In `lib/workflow.ts`, import the new types:

```ts
  RuntimeSkillBundleDescriptor,
  RuntimeSkillBundleResult,
  RuntimeSkillResolution,
```

Add fields to `AgentArtifactResult`:

```ts
  runtimeSkillBundleResults?: RuntimeSkillBundleResult[]
```

Add fields to `AgentInvocationInput`:

```ts
  runtimeSkillBundles?: RuntimeSkillBundleDescriptor[]
```

Add this type near `AgentInvoker`:

```ts
export type RuntimeSkillResolver = (
  skill: WorkflowEventSkill
) => RuntimeSkillResolution
```

Change `advanceWorkflow` options to:

```ts
export async function advanceWorkflow(
  run: WorkflowRun,
  options: {
    invokeAgent?: AgentInvoker
    resolveRuntimeSkillBundles?: RuntimeSkillResolver
  } = {}
): Promise<WorkflowRun> {
```

- [ ] **Step 4: Resolve bundles before invoking an agent**

In `addAgentArtifact`, change the signature:

```ts
async function addAgentArtifact(
  run: WorkflowRun,
  skillId: string,
  stage: WorkflowStage,
  type: Artifact["type"],
  title: string,
  body: string,
  invokeAgent?: AgentInvoker,
  resolveRuntimeSkillBundles?: RuntimeSkillResolver
) {
```

At the top of `addAgentArtifact`, after `skill` and `revision` are resolved, add:

```ts
  const runtimeSkillResolution =
    skill && skill.runtimeSkillBundles?.length
      ? resolveRuntimeSkillBundles?.(skill) ?? {
          status: "failed" as const,
          errorCode: "resolution_failed" as const,
          errorMessage: "No runtime skill resolver was configured."
        }
      : undefined

  if (runtimeSkillResolution?.status === "failed") {
    const failedResult: AgentArtifactResult = {
      status: "failed",
      source: "simulated",
      body: runtimeSkillResolution.errorMessage,
      statusMessage: createRuntimeSkillAuditMessage({
        runtimeSkillResolution
      })
    }
    recordAgentArtifactResult({
      run,
      skillId,
      stage,
      type,
      title,
      finalResult: failedResult,
      revisionId: revision?.id
    })
    run.status = "failed"
    return failedResult
  }
```

Then pass bundles into `invokeAgent`:

```ts
          runtimeSkillBundles:
            runtimeSkillResolution?.status === "completed"
              ? runtimeSkillResolution.bundles
              : undefined
```

- [ ] **Step 5: Extract result recording helper**

Move the existing artifact/event/agentRun recording block from `addAgentArtifact` into a helper:

```ts
function recordAgentArtifactResult(input: {
  run: WorkflowRun
  skillId: string
  stage: WorkflowStage
  type: Artifact["type"]
  title: string
  finalResult: AgentArtifactResult
  revisionId?: string
}) {
  const inputArtifactIds = input.run.artifacts.map((item) => item.id)
  const artifact = createArtifact(
    input.run.id,
    input.stage,
    input.type,
    input.title,
    input.finalResult.body,
    input.revisionId
  )
  const extraArtifacts = (input.finalResult.artifacts ?? []).map((item) =>
    createArtifact(
      input.run.id,
      input.stage,
      normalizeArtifactType(item.type),
      item.title,
      item.body,
      input.revisionId
    )
  )
  const outputArtifactIds = [artifact, ...extraArtifacts].map((item) => item.id)
  input.run.artifacts.push(artifact, ...extraArtifacts)

  if (input.finalResult.repository) {
    input.run.repository = input.finalResult.repository
  }

  addWorkflowEvent(
    input.run,
    input.skillId,
    input.finalResult.status,
    resolveSkillExecutor(input.run, input.skillId),
    outputArtifactIds,
    [
      `${input.title} generated by ${getAgentLabel(resolveSkillExecutor(input.run, input.skillId))}.`,
      `Runner source: ${input.finalResult.source}.`,
      input.finalResult.externalRunId ? `External run: ${input.finalResult.externalRunId}.` : undefined,
      input.finalResult.statusMessage,
      input.revisionId ? `Revision: ${input.revisionId}.` : undefined
    ]
      .filter(Boolean)
      .join(" "),
    input.revisionId
  )

  input.run.agentRuns.push({
    id: crypto.randomUUID(),
    workflowRunId: input.run.id,
    stage: input.stage,
    agent: resolveSkillExecutor(input.run, input.skillId),
    status: input.finalResult.status,
    source: input.finalResult.source,
    externalRunId: input.finalResult.externalRunId,
    idempotencyKey: input.finalResult.idempotencyKey,
    statusMessage: input.finalResult.statusMessage,
    revisionId: input.revisionId,
    inputArtifactIds,
    outputArtifactIds,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString()
  })
}
```

- [ ] **Step 6: Add audit message helper**

Add:

```ts
function createRuntimeSkillAuditMessage(input: {
  runtimeSkillResolution?: RuntimeSkillResolution
  runtimeSkillBundleResults?: RuntimeSkillBundleResult[]
}) {
  if (!input.runtimeSkillResolution && !input.runtimeSkillBundleResults?.length) {
    return undefined
  }

  return JSON.stringify({
    runtimeSkillResolution: input.runtimeSkillResolution,
    runtimeSkillBundleResults: input.runtimeSkillBundleResults
  })
}
```

When final agent result is available, merge audit into statusMessage:

```ts
  const runtimeSkillAuditMessage = createRuntimeSkillAuditMessage({
    runtimeSkillResolution,
    runtimeSkillBundleResults: finalResult.runtimeSkillBundleResults
  })

  const finalResultWithAudit: AgentArtifactResult = {
    ...finalResult,
    statusMessage: [finalResult.statusMessage, runtimeSkillAuditMessage]
      .filter(Boolean)
      .join(" ")
  }
```

Record `finalResultWithAudit` instead of `finalResult`.

- [ ] **Step 7: Thread the resolver through all addAgentArtifact calls**

For every `addAgentArtifact(..., options.invokeAgent)` call in `advanceWorkflow`, pass:

```ts
options.invokeAgent,
options.resolveRuntimeSkillBundles
```

- [ ] **Step 8: Run tests**

Run:

```bash
npm run test
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add lib/workflow.ts tests/workspace-model.test.ts
git commit -m "Audit runtime skill bundle resolution"
```

## Task 4: Bridge v0.3 Descriptor Delivery And Protocol Gate

**Files:**
- Modify: `lib/agent-bridge.ts`

- [ ] **Step 1: Write a small protocol helper inside `lib/agent-bridge.ts`**

Add this near the bridge interfaces:

```ts
const bridgeProtocolV2 = "harness-agent-bridge/v0.2"
const bridgeProtocolV3 = "harness-agent-bridge/v0.3"

function getConfiguredBridgeProtocol(agent: AgentKind) {
  const profile = getAgentProfile(agent)

  if (profile.family === "openclaw") {
    return process.env.OPENCLAW_BRIDGE_PROTOCOL_VERSION ?? bridgeProtocolV2
  }

  if (profile.family === "codex") {
    return process.env.CODEX_BRIDGE_PROTOCOL_VERSION ?? bridgeProtocolV2
  }

  return bridgeProtocolV2
}

function requiredBridgeProtocol(input: AgentInvocationInput) {
  return input.runtimeSkillBundles?.length ? bridgeProtocolV3 : bridgeProtocolV2
}
```

- [ ] **Step 2: Gate unsupported runtime bundle dispatch**

At the start of `invokeConfiguredAgent`, after the profile is loaded and after the intake special case, add:

```ts
  const requiredProtocol = requiredBridgeProtocol(input)
  const configuredProtocol = getConfiguredBridgeProtocol(input.executor)

  if (requiredProtocol === bridgeProtocolV3 && configuredProtocol !== bridgeProtocolV3) {
    return {
      status: "failed",
      source: getBridgeSource(input.executor),
      body: `${profile.label} bridge does not support runtime skill bundles.`,
      statusMessage: JSON.stringify({
        runtimeSkillResolution: {
          status: "failed",
          errorCode: "runtime_skill_protocol_unsupported",
          errorMessage: `${profile.label} bridge must use ${bridgeProtocolV3} for runtime skill bundles.`
        }
      })
    }
  }
```

- [ ] **Step 3: Send v0.3 payload fields**

In the fetch body, replace the fixed protocol version with:

```ts
        protocolVersion: requiredProtocol,
```

Add:

```ts
        runtimeSkillBundles: input.runtimeSkillBundles ?? [],
```

- [ ] **Step 4: Accept runtime bundle attestation from bridge responses**

Extend `BridgeResponse`:

```ts
  runtimeSkillBundleResults?: RuntimeSkillBundleResult[]
```

Import `RuntimeSkillBundleResult` from `@/lib/types`.

When returning a successful bridge result, add:

```ts
      runtimeSkillBundleResults: data.runtimeSkillBundleResults,
```

- [ ] **Step 5: Run verification**

Run:

```bash
npm run typecheck
npm run test
```

Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/agent-bridge.ts
git commit -m "Gate runtime skill bridge protocol"
```

## Task 5: Local Codex Bridge Agent-Local Install

**Files:**
- Modify: `scripts/codex-bridge.mjs`

- [ ] **Step 1: Add bridge protocol and runtime skill install constants**

Add near the existing top-level constants:

```js
const protocolVersion =
  process.env.CODEX_BRIDGE_RUNTIME_SKILLS === "1"
    ? "harness-agent-bridge/v0.3"
    : "harness-agent-bridge/v0.2"
const runtimeSkillRoot = path.resolve(
  process.env.CODEX_BRIDGE_RUNTIME_SKILL_ROOT ??
    path.join(repoRoot, ".harness", "runtime-skills")
)
const runtimeSkillCacheRoot = path.resolve(
  process.env.CODEX_BRIDGE_RUNTIME_SKILL_CACHE ??
    path.join(repoRoot, ".harness", "cache", "skills")
)
```

- [ ] **Step 2: Advertise the selected bridge protocol**

In the `/health` response, replace the hard-coded protocol:

```js
        protocolVersion,
```

Update `bridgeCapabilities()`:

```js
function bridgeCapabilities() {
  const capabilities = [
    "cancel",
    "stop",
    "active-run-status",
    "idempotency-key",
    "text-output"
  ]

  if (protocolVersion === "harness-agent-bridge/v0.3") {
    capabilities.push("runtime-skill-bundles")
  }

  return capabilities
}
```

- [ ] **Step 3: Install runtime bundles before building the prompt**

In the POST `/agent-runs` branch, before `runCodex(...)`, add:

```js
    const runtimeSkillBundleResults = await installRuntimeSkillBundles(
      payload.runtimeSkillBundles
    )
    const failedRuntimeBundle = runtimeSkillBundleResults.find(
      (result) => result.verified === false
    )

    if (failedRuntimeBundle) {
      sendJson(response, 200, {
        id,
        idempotencyKey,
        startedAt,
        finishedAt: new Date().toISOString(),
        status: "failed",
        output: failedRuntimeBundle.errorMessage,
        statusMessage: `Runtime skill installation failed: ${failedRuntimeBundle.errorCode}.`,
        capabilities: bridgeCapabilities(),
        runtimeSkillBundleResults
      })
      return
    }
```

Change the `buildPrompt` call:

```js
      buildPrompt(payload, contextDir, runtimeSkillBundleResults),
```

Add `runtimeSkillBundleResults` to the success response:

```js
      runtimeSkillBundleResults,
```

- [ ] **Step 4: Add checksum and extraction helpers**

Add before `buildPrompt`:

```js
async function installRuntimeSkillBundles(runtimeSkillBundles) {
  if (!Array.isArray(runtimeSkillBundles) || runtimeSkillBundles.length === 0) {
    return []
  }

  const results = []

  for (const bundle of runtimeSkillBundles) {
    results.push(await installRuntimeSkillBundle(bundle))
  }

  return results
}

async function installRuntimeSkillBundle(bundle) {
  const archiveDir = path.join(runtimeSkillCacheRoot, bundle.id, bundle.version)
  const archivePath = path.join(
    archiveDir,
    `${bundle.id}-${bundle.version}.tgz`
  )
  const installPath = path.join(runtimeSkillRoot, bundle.id, bundle.version)

  try {
    await fs.mkdir(archiveDir, { recursive: true })
    await fs.mkdir(installPath, { recursive: true })

    let cacheStatus = "hit"

    if (!(await fileExists(archivePath))) {
      cacheStatus = "miss"
      await downloadFile(bundle.sourceUrl, archivePath)
    }

    const actualChecksum = await sha256File(archivePath)

    if (actualChecksum !== bundle.checksum?.value) {
      return runtimeSkillFailure(
        bundle,
        cacheStatus,
        "checksum_mismatch",
        "Downloaded bundle sha256 did not match descriptor."
      )
    }

    await fs.rm(installPath, { recursive: true, force: true })
    await fs.mkdir(installPath, { recursive: true })
    await extractTgz(archivePath, installPath)

    return {
      id: bundle.id,
      version: bundle.version,
      checksum: bundle.checksum,
      downloadSource: "github-release",
      cacheStatus,
      verified: true,
      installedPath: installPath
    }
  } catch (error) {
    return runtimeSkillFailure(
      bundle,
      "miss",
      isUnauthorizedDownload(error) ? "download_unauthorized" : "installation_failed",
      formatError(error)
    )
  }
}

function runtimeSkillFailure(bundle, cacheStatus, errorCode, errorMessage) {
  return {
    id: bundle.id,
    version: bundle.version,
    checksum: bundle.checksum,
    downloadSource: "github-release",
    cacheStatus,
    verified: false,
    errorCode,
    errorMessage
  }
}

async function downloadFile(sourceUrl, targetPath) {
  const headers = {}
  const token =
    process.env.JORMUNGAND_SKILL_DOWNLOAD_TOKEN ?? process.env.GITHUB_TOKEN

  if (token && new URL(sourceUrl).hostname === "github.com") {
    headers.Authorization = `Bearer ${token}`
    headers.Accept = "application/octet-stream"
  }

  const response = await fetch(sourceUrl, { headers })

  if (response.status === 401 || response.status === 403) {
    throw new Error(`download unauthorized with HTTP ${response.status}`)
  }

  if (!response.ok) {
    throw new Error(`download failed with HTTP ${response.status}`)
  }

  const bytes = Buffer.from(await response.arrayBuffer())
  await fs.writeFile(targetPath, bytes)
}

async function sha256File(filePath) {
  const { createHash } = await import("node:crypto")
  const hash = createHash("sha256")
  const file = await fs.open(filePath, "r")

  try {
    for await (const chunk of file.createReadStream()) {
      hash.update(chunk)
    }
  } finally {
    await file.close()
  }

  return hash.digest("hex")
}

async function extractTgz(archivePath, installPath) {
  await runProcess("tar", ["-xzf", archivePath, "-C", installPath])
}

async function runProcess(command, args) {
  const child = spawn(command, args, {
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"]
  })
  let stderr = ""

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString()
  })

  const exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject)
    child.on("close", (code) => resolve(code ?? 1))
  })

  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `${command} exited with ${exitCode}`)
  }
}

async function fileExists(filePath) {
  return fs.access(filePath).then(
    () => true,
    () => false
  )
}

function isUnauthorizedDownload(error) {
  return formatError(error).includes("401") || formatError(error).includes("403")
}
```

- [ ] **Step 5: Include installed runtime skill paths in the prompt**

Change the function signature:

```js
function buildPrompt(payload, contextDir, runtimeSkillBundleResults = []) {
```

Before the final return array, add:

```js
  const runtimeSkillSummary = runtimeSkillBundleResults
    .filter((result) => result.verified)
    .map(
      (result) =>
        `- ${result.id}@${result.version}: ${result.installedPath}`
    )
    .join("\n")
```

Add these lines to the prompt body after existing artifacts:

```js
    "",
    "Runtime skill bundles:",
    runtimeSkillSummary || "No runtime skill bundles installed.",
```

- [ ] **Step 6: Run syntax and type-adjacent checks**

Run:

```bash
node --check scripts/codex-bridge.mjs
npm run typecheck
```

Expected: both PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/codex-bridge.mjs
git commit -m "Install runtime skill bundles in Codex bridge"
```

## Task 6: Documentation And Final Verification

**Files:**
- Modify: `docs/workflow-event-skills.md`

- [ ] **Step 1: Update workflow event skill documentation**

Add this section after "Executor Assignment Policy" in `docs/workflow-event-skills.md`:

```md
## Runtime Skill Bundle Policy

Workflow event skills may declare runtime skill bundles with `runtimeSkillBundles`.
These bundles are external agent capability packages, not workflow event skills.

MVP runtime bundle behavior:

- The curated registry is stored in `.harness/skill-registry.json`.
- The executable version is pinned in `.harness/skill.lock.json`.
- Agent-executed development events declare `superpowers-full`.
- The harness resolves locked bundle descriptors before dispatch.
- Remote agents download private GitHub Release artifacts with their own local credentials.
- Agents verify sha256 checksums, install locally, execute, and return attestation.
- Required bundle install or verification failure fails the workflow event.

The harness must send bundle descriptors, not server-local mount paths, because remote agents do not share the Zeabur server filesystem.
```

- [ ] **Step 2: Run all verification**

Run:

```bash
npm run typecheck
npm run lint
npm run test
npm run build
```

Expected: all PASS.

- [ ] **Step 3: Inspect git diff**

Run:

```bash
git status --short
git diff --stat
```

Expected: only runtime skill registry implementation files are changed. Existing `.omx/` state files may still appear as unrelated local changes and must not be committed.

- [ ] **Step 4: Commit docs and any final fixes**

```bash
git add docs/workflow-event-skills.md
git commit -m "Document runtime skill bundle execution"
```

If final verification required code fixes, stage only the files changed for those fixes and use a Lore-style commit message that records the verification commands.

## Self-Review Notes

Spec coverage:

- Curated registry: Task 2 creates committed registry and lockfile.
- Same-org private GitHub Release descriptor: Task 2 registry and Task 4 bridge payload use release URLs.
- Full Superpowers bundle: Tasks 1 and 2 use `superpowers-full`.
- Skill catalog over full bundle: Task 2 registry includes `skills`.
- Minimal schema: Task 2 only uses id, version, sourceUrl, checksum, and skills.
- Strict lockfile: Task 2 resolver requires locked bundle entries to match registry entries.
- Bundle-only workflow declarations: Task 1 adds `runtimeSkillBundles?: string[]`.
- Bridge v0.3 gate: Task 4 gates unsupported bridge protocols.
- Agent-local install: Task 5 downloads, verifies, extracts, and reports installed paths from the bridge runtime.
- Checksum only: Task 5 verifies sha256 and does not add signature fields.
- Hard fail required bundles: Tasks 3, 4, and 5 fail resolution, protocol, and install errors.
- Operational diagnostic attestation: Tasks 3 and 5 record `runtimeSkillBundleResults`.
- Per-run audit: Task 3 stores structured JSON in existing event note/status message surfaces.

Known implementation risk:

- The initial committed `.harness/skill.lock.json` digest must match the first private GitHub Release artifact before any remote agent can execute `superpowers-full` successfully. If the release artifact digest differs from the lockfile digest, remote agents will correctly fail with `checksum_mismatch`.
