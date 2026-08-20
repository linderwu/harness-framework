import assert from "node:assert/strict"
import { mkdtemp, rm, lstat, mkdir, realpath, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import type { TestContext } from "node:test"

import { openHiveDatabase } from "../lib/hive-memory/database"
import { createHiveMemoryRepository } from "../lib/hive-memory/repository"
import { runNextExecutionJob } from "../lib/execution-job-runner"
import { createProject } from "../lib/workspace"
import { createWorkflowRun } from "../lib/workflow"
import type { ManagedProjectConfig, Project, WorkflowRun } from "../lib/types"

type RouteHandler<TContext = { params: Promise<{ id: string }> }> = {
  POST: (request: Request, context: TContext) => Promise<Response>
}

type ProjectWorkflowRunsRouteModule = RouteHandler & {
  createProjectWorkflowRunsRouteHandlers?: (
    dependencies?: ProjectWorkflowRunsRouteDependencies
  ) => RouteHandler
}

type WorkflowRunManagerWakeRouteModule = RouteHandler & {
  createWorkflowRunManagerWakeRouteHandlers?: (
    dependencies?: WorkflowRunManagerRouteDependencies
  ) => RouteHandler
}

type WorkflowRunManagerMessageRouteModule = RouteHandler & {
  createWorkflowRunManagerMessageRouteHandlers?: (
    dependencies?: WorkflowRunManagerRouteDependencies
  ) => RouteHandler
}

type ProjectWorkflowRunsRouteDependencies = {
  getProject?: (id: string) => Promise<Project | undefined>
  repository: ReturnType<typeof createHiveMemoryRepository>
  upsertWorkflowRun?: (run: WorkflowRun) => Promise<WorkflowRun>
  scheduleExecutionJobDrain?: (jobId: string) => Promise<void> | void
}

type WorkflowRunManagerRouteDependencies = {
  getWorkflowRun?: (id: string) => Promise<WorkflowRun | undefined>
  repository: ReturnType<typeof createHiveMemoryRepository>
  scheduler?: {
    enqueue: (input: { workflowRunId: string; reason: string; idempotencyKey: string }) => Promise<void> | void
    runNext: (workflowRunId: string) => Promise<unknown>
  }
  scheduleExecutionJobDrain?: (jobId: string) => Promise<void> | void
}

function ensureCompiledAlias() {
  const tmpRoot = join(process.cwd(), ".tmp-tests")
  const scopedRoot = join(tmpRoot, "node_modules", "@")
  const libLink = join(scopedRoot, "lib")
  const expectedTarget = join(tmpRoot, "lib")

  return mkdir(scopedRoot, { recursive: true }).then(async () => {
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
  })
}

async function importProjectWorkflowRunsRoute() {
  await ensureCompiledAlias()
  return await import("../app/api/projects/[id]/workflow-runs/route") as ProjectWorkflowRunsRouteModule
}

async function importWorkflowRunManagerWakeRoute() {
  await ensureCompiledAlias()
  return await import("../app/api/workflow-runs/[id]/manager/wake/route") as WorkflowRunManagerWakeRouteModule
}

async function importWorkflowRunManagerMessageRoute() {
  await ensureCompiledAlias()
  return await import("../app/api/workflow-runs/[id]/manager/message/route") as WorkflowRunManagerMessageRouteModule
}

async function openRepository(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-execution-routes-"))
  const database = openHiveDatabase({ dataDir })
  const repository = createHiveMemoryRepository(database)

  t.after(async () => {
    database.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  return { repository }
}

test("execution job drain claims the requested job when same-run jobs are queued", async (t) => {
  const { repository } = await openRepository(t)
  const first = await repository.createExecutionJob({
    kind: "manager_wake",
    workflowRunId: "same-run",
    payload: { label: "first" },
    idempotencyKey: "runner-first"
  })
  const second = await repository.createExecutionJob({
    kind: "manager_wake",
    workflowRunId: "same-run",
    payload: { label: "second" },
    idempotencyKey: "runner-second"
  })
  const handledJobIds: string[] = []

  const completed = await runNextExecutionJob({
    repository,
    jobId: second.job.id,
    leaseOwner: "runner-test",
    leaseDurationMs: 30_000,
    handlers: {
      manager_wake: async (job) => {
        handledJobIds.push(job.id)
        return { handled: job.id }
      }
    }
  })

  assert.deepEqual(handledJobIds, [second.job.id])
  assert.equal(completed?.id, second.job.id)
  assert.equal(completed?.status, "completed")
  assert.equal(repository.getExecutionJob(first.job.id)?.status, "queued")
  assert.equal(repository.getExecutionJob(second.job.id)?.status, "completed")
})

test("execution job drain recovers an expired running job before claiming it", async (t) => {
  const { repository } = await openRepository(t)
  const created = await repository.createExecutionJob({
    kind: "manager_wake",
    workflowRunId: "expired-run",
    payload: { reason: "health_check" },
    idempotencyKey: "expired-runner-job",
    availableAt: "2020-01-01T00:00:00.000Z"
  })
  const claimed = await repository.claimExecutionJob({
    id: created.job.id,
    leaseOwner: "expired-worker",
    leaseDurationMs: 1,
    now: "2020-01-01T00:00:00.000Z"
  })
  assert.equal(claimed?.status, "running")

  const completed = await runNextExecutionJob({
    repository,
    jobId: created.job.id,
    leaseOwner: "replacement-worker",
    leaseDurationMs: 30_000,
    handlers: {
      manager_wake: async () => ({ status: "recovered" })
    }
  })

  assert.equal(completed?.id, created.job.id)
  assert.equal(completed?.status, "completed")
  assert.equal(repository.getExecutionJob(created.job.id)?.status, "completed")
})

function makeExecutionJobCreationFail(repository: ReturnType<typeof createHiveMemoryRepository>) {
  repository.createExecutionJob = async () => {
    throw new Error("execution job insert failed")
  }
}

function createManagedRun(overrides: { managed?: WorkflowRun["managed"] } = {}) {
  return createWorkflowRun({
    projectId: "project-managed-1",
    projectName: "Managed project",
    projectType: "hive_mission",
    repository: "github.com/acme/managed-project",
    requirement: "Keep the manager responsive",
    selectedAgent: "codex",
    managedConfig: {
      kind: "hive_mission",
      manager: "codex",
      successCriteria: ["Keep the workflow alive"],
      repositoryScope: "github.com/acme/managed-project",
      constraints: [],
      nonGoals: [],
      budget: {
        callLimit: 4,
        callsUsed: 0,
        timeLimitMs: 60_000,
        startedAt: "2026-08-20T00:00:00.000Z",
        costLimitUsd: 1,
        costUsedUsd: 0
      },
      approvalPolicy: "external_and_irreversible"
    } as WorkflowRun["managedConfig"],
    ...overrides
  })
}

function createManagedProjectConfig(): ManagedProjectConfig {
  return {
    kind: "hive_mission",
    manager: "codex",
    successCriteria: ["Keep the workflow alive"],
    repositoryScope: "github.com/acme/queued-launch",
    constraints: [],
    nonGoals: [],
    budget: {
      callLimit: 4,
      timeLimitMs: 60_000,
      costLimitUsd: 1
    },
    approvalPolicy: "external_and_irreversible"
  }
}

test("managed workflow run creation enqueues a durable execution job and returns 202 queued", async (t) => {
  const { repository } = await openRepository(t)
  const project = createProject({
    name: "Queued launch",
    type: "hive_mission",
    goal: "Validate the durable execution job route.",
    repository: "github.com/acme/queued-launch",
    source: "dashboard",
    managedConfig: createManagedProjectConfig()
  })
  const drainCalls: string[] = []
  const routeModule = await importProjectWorkflowRunsRoute()
  const handlers =
    routeModule.createProjectWorkflowRunsRouteHandlers?.({
      getProject: async (id) => (id === project.id ? project : undefined),
      repository,
      scheduleExecutionJobDrain: async (jobId) => {
        drainCalls.push(jobId)
      }
    }) ?? routeModule

  const response = await handlers.POST(
    new Request(`https://jormungand.test/api/projects/${project.id}/workflow-runs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "project-run-request-1"
      },
      body: JSON.stringify({
        selectedAgent: "codex"
      })
    }),
    { params: Promise.resolve({ id: project.id }) }
  )
  const body = await response.json() as { status?: string; jobId?: string }
  const job = body.jobId ? repository.getExecutionJob(body.jobId) : undefined

  assert.equal(response.status, 202)
  assert.deepEqual(body.status, "queued")
  assert.ok(body.jobId)
  assert.equal(job?.kind, "workflow_run_start")
  assert.ok(job?.workflowRunId)
  assert.notEqual(job?.workflowRunId, project.id)
  assert.equal(job?.idempotencyKey, `mission-created:${job?.workflowRunId}`)
  assert.equal(repository.listManagerTasks(job?.workflowRunId ?? "").length, 1)
  assert.deepEqual(drainCalls, [body.jobId])

  const duplicateResponse = await handlers.POST(
    new Request(`https://jormungand.test/api/projects/${project.id}/workflow-runs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "project-run-request-1"
      },
      body: JSON.stringify({
        selectedAgent: "codex"
      })
    }),
    { params: Promise.resolve({ id: project.id }) }
  )
  const duplicateBody = await duplicateResponse.json() as { status?: string; jobId?: string }

  assert.equal(duplicateResponse.status, 202)
  assert.equal(duplicateBody.jobId, body.jobId)
  assert.equal(repository.getExecutionJob(body.jobId ?? "")?.id, body.jobId)
  assert.deepEqual(drainCalls, [body.jobId])
})

test("managed duplicate does not drain while the original request persists prerequisites", async (t) => {
  const { repository } = await openRepository(t)
  const project = createProject({
    name: "Initialization fence",
    type: "hive_mission",
    goal: "Do not drain before manager prerequisites finish.",
    repository: "github.com/acme/initialization-fence",
    source: "dashboard",
    managedConfig: createManagedProjectConfig()
  })
  const drainCalls: string[] = []
  let releasePersistence!: () => void
  let resolvePersistenceStarted!: () => void
  const persistenceStarted = new Promise<void>((resolve) => {
    resolvePersistenceStarted = resolve
  })
  const persistenceGate = new Promise<void>((resolve) => {
    releasePersistence = resolve
  })
  const routeModule = await importProjectWorkflowRunsRoute()
  const handlers = routeModule.createProjectWorkflowRunsRouteHandlers?.({
    getProject: async (id) => (id === project.id ? project : undefined),
    repository,
    upsertWorkflowRun: async (workflowRun) => {
      if (workflowRun.status === "running") {
        resolvePersistenceStarted()
        await persistenceGate
      }
      return workflowRun
    },
    scheduleExecutionJobDrain: async (jobId) => {
      drainCalls.push(jobId)
    }
  }) ?? routeModule

  const request = () => handlers.POST(
    new Request(`https://jormungand.test/api/projects/${project.id}/workflow-runs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "initialization-fence-request"
      },
      body: JSON.stringify({ selectedAgent: "codex" })
    }),
    { params: Promise.resolve({ id: project.id }) }
  )

  const originalResponsePromise = request()
  await persistenceStarted
  const duplicateResponse = await request()
  const duplicateBody = await duplicateResponse.json() as { status?: string; jobId?: string }

  assert.equal(duplicateResponse.status, 202)
  assert.equal(duplicateBody.status, "queued")
  assert.ok(duplicateBody.jobId)
  assert.deepEqual(drainCalls, [])

  releasePersistence()
  const originalResponse = await originalResponsePromise
  const originalBody = await originalResponse.json() as { status?: string; jobId?: string }
  assert.equal(originalResponse.status, 202)
  assert.equal(originalBody.jobId, duplicateBody.jobId)
  assert.deepEqual(drainCalls, [duplicateBody.jobId])
})

test("managed workflow duplicate reports a completed execution job", async (t) => {
  const { repository } = await openRepository(t)
  const project = createProject({
    name: "Completed launch",
    type: "hive_mission",
    goal: "Return truthful idempotent completion status.",
    repository: "github.com/acme/completed-launch",
    source: "dashboard",
    managedConfig: createManagedProjectConfig()
  })
  const routeModule = await importProjectWorkflowRunsRoute()
  const handlers = routeModule.createProjectWorkflowRunsRouteHandlers?.({
    getProject: async (id) => (id === project.id ? project : undefined),
    repository,
    scheduleExecutionJobDrain: async () => undefined
  }) ?? routeModule

  const request = () => handlers.POST(
    new Request(`https://jormungand.test/api/projects/${project.id}/workflow-runs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "completed-run-request"
      },
      body: JSON.stringify({ selectedAgent: "codex" })
    }),
    { params: Promise.resolve({ id: project.id }) }
  )

  const initialResponse = await request()
  const initialBody = await initialResponse.json() as { jobId?: string }
  assert.ok(initialBody.jobId)
  const claimed = await repository.claimNextExecutionJob({
    leaseOwner: "completion-test",
    leaseDurationMs: 30_000
  })
  assert.equal(claimed?.id, initialBody.jobId)
  await repository.completeExecutionJob({
    id: initialBody.jobId,
    leaseOwner: "completion-test",
    result: { status: "done" }
  })

  const duplicateResponse = await request()
  const duplicateBody = await duplicateResponse.json() as { status?: string; jobId?: string }

  assert.equal(duplicateResponse.status, 200)
  assert.equal(duplicateBody.status, "completed")
  assert.equal(duplicateBody.jobId, initialBody.jobId)
})

test("managed workflow creation does not enqueue manager work when execution job creation fails", async (t) => {
  const { repository } = await openRepository(t)
  const project = createProject({
    name: "Job-first launch",
    type: "hive_mission",
    goal: "Do not orphan manager work.",
    repository: "github.com/acme/job-first-launch",
    source: "dashboard",
    managedConfig: createManagedProjectConfig()
  })
  makeExecutionJobCreationFail(repository)
  const routeModule = await importProjectWorkflowRunsRoute()
  const handlers =
    routeModule.createProjectWorkflowRunsRouteHandlers?.({
      getProject: async (id) => (id === project.id ? project : undefined),
      repository,
      scheduleExecutionJobDrain: async () => undefined
    }) ?? routeModule

  const response = await handlers.POST(
    new Request(`https://jormungand.test/api/projects/${project.id}/workflow-runs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "managed-job-first-failure"
      },
      body: JSON.stringify({ selectedAgent: "codex" })
    }),
    { params: Promise.resolve({ id: project.id }) }
  )
  const body = await response.json() as { latestRun?: WorkflowRun; error?: string }

  assert.equal(response.status, 503)
  assert.match(body.error ?? "", /execution job insert failed/)
  assert.ok(body.latestRun?.id)
  assert.equal(repository.listManagerTasks(body.latestRun.id).length, 0)
  assert.equal(repository.listManagerWakes(body.latestRun.id).length, 0)
})

test("manager wake and message mutations queue durable execution jobs without dropping validation errors", async (t) => {
  const { repository } = await openRepository(t)
  const managedRun = createManagedRun()
  const unmanagedRun = { ...createManagedRun(), managed: undefined }
  const drainCalls: string[] = []
  const wakeRouteModule = await importWorkflowRunManagerWakeRoute()
  const messageRouteModule = await importWorkflowRunManagerMessageRoute()
  const wakeHandlers =
    wakeRouteModule.createWorkflowRunManagerWakeRouteHandlers?.({
      getWorkflowRun: async (id) => {
        if (id === managedRun.id) return managedRun
        if (id === unmanagedRun.id) return unmanagedRun
        return undefined
      },
      repository,
      scheduleExecutionJobDrain: async (jobId) => {
        drainCalls.push(jobId)
      }
    }) ?? wakeRouteModule
  const messageHandlers =
    messageRouteModule.createWorkflowRunManagerMessageRouteHandlers?.({
      getWorkflowRun: async (id) => (id === managedRun.id ? managedRun : undefined),
      repository,
      scheduleExecutionJobDrain: async (jobId) => {
        drainCalls.push(jobId)
      }
    }) ?? messageRouteModule

  const wakeResponse = await wakeHandlers.POST(
    new Request(`https://jormungand.test/api/workflow-runs/${managedRun.id}/manager/wake`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reason: "operator_message",
        idempotencyKey: "wake-request-1"
      })
    }),
    { params: Promise.resolve({ id: managedRun.id }) }
  )
  const wakeBody = await wakeResponse.json() as { status?: string; jobId?: string }
  const wakeJob = wakeBody.jobId ? repository.getExecutionJob(wakeBody.jobId) : undefined

  assert.equal(wakeResponse.status, 202)
  assert.deepEqual(wakeBody.status, "queued")
  assert.ok(wakeBody.jobId)
  assert.equal(wakeJob?.kind, "manager_wake")
  assert.equal(wakeJob?.workflowRunId, managedRun.id)
  assert.equal(wakeJob?.idempotencyKey, `workflow-run-manager-wake:${managedRun.id}:wake-request-1`)

  const messageResponse = await messageHandlers.POST(
    new Request(`https://jormungand.test/api/workflow-runs/${managedRun.id}/manager/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "Please continue.",
        idempotencyKey: "message-request-1"
      })
    }),
    { params: Promise.resolve({ id: managedRun.id }) }
  )
  const messageBody = await messageResponse.json() as { status?: string; jobId?: string }
  const messageJob = messageBody.jobId ? repository.getExecutionJob(messageBody.jobId) : undefined

  assert.equal(messageResponse.status, 202)
  assert.deepEqual(messageBody.status, "queued")
  assert.ok(messageBody.jobId)
  assert.equal(messageJob?.kind, "manager_message")
  assert.equal(messageJob?.workflowRunId, managedRun.id)
  assert.equal(messageJob?.idempotencyKey, `workflow-run-manager-message:${managedRun.id}:message-request-1`)
  assert.equal(drainCalls.length, 2)

  const duplicateWakeResponse = await wakeHandlers.POST(
    new Request(`https://jormungand.test/api/workflow-runs/${managedRun.id}/manager/wake`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reason: "operator_message",
        idempotencyKey: "wake-request-1"
      })
    }),
    { params: Promise.resolve({ id: managedRun.id }) }
  )
  const duplicateWakeBody = await duplicateWakeResponse.json() as { status?: string; jobId?: string }

  assert.equal(duplicateWakeResponse.status, 202)
  assert.equal(duplicateWakeBody.jobId, wakeBody.jobId)
  assert.equal(drainCalls.length, 2)

  const duplicateMessageResponse = await messageHandlers.POST(
    new Request(`https://jormungand.test/api/workflow-runs/${managedRun.id}/manager/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "Please continue.",
        idempotencyKey: "message-request-1"
      })
    }),
    { params: Promise.resolve({ id: managedRun.id }) }
  )
  const duplicateMessageBody = await duplicateMessageResponse.json() as { status?: string; jobId?: string }

  assert.equal(duplicateMessageResponse.status, 202)
  assert.equal(duplicateMessageBody.jobId, messageBody.jobId)
  assert.equal(drainCalls.length, 2)

  const missingRunResponse = await wakeHandlers.POST(
    new Request("https://jormungand.test/api/workflow-runs/missing/manager/wake", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "operator_message", idempotencyKey: "wake-request-2" })
    }),
    { params: Promise.resolve({ id: "missing" }) }
  )
  const missingRunBody = await missingRunResponse.json() as { error?: string }

  assert.equal(missingRunResponse.status, 404)
  assert.equal(missingRunBody.error, "Workflow run not found")

  const unmanagedResponse = await wakeHandlers.POST(
    new Request(`https://jormungand.test/api/workflow-runs/${unmanagedRun.id}/manager/wake`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "operator_message", idempotencyKey: "wake-request-3" })
    }),
    { params: Promise.resolve({ id: unmanagedRun.id }) }
  )
  const unmanagedBody = await unmanagedResponse.json() as { error?: string }

  assert.equal(unmanagedResponse.status, 409)
  assert.equal(unmanagedBody.error, "Workflow run is not manager-controlled")
})

test("manager wake and message do not append side effects when execution job creation fails", async (t) => {
  const { repository } = await openRepository(t)
  const wakeRun = createManagedRun()
  const messageRun = createManagedRun()
  makeExecutionJobCreationFail(repository)
  const wakeRouteModule = await importWorkflowRunManagerWakeRoute()
  const messageRouteModule = await importWorkflowRunManagerMessageRoute()
  const wakeHandlers =
    wakeRouteModule.createWorkflowRunManagerWakeRouteHandlers?.({
      getWorkflowRun: async (id) => (id === wakeRun.id ? wakeRun : undefined),
      repository,
      scheduleExecutionJobDrain: async () => undefined
    }) ?? wakeRouteModule
  const messageHandlers =
    messageRouteModule.createWorkflowRunManagerMessageRouteHandlers?.({
      getWorkflowRun: async (id) => (id === messageRun.id ? messageRun : undefined),
      repository,
      scheduleExecutionJobDrain: async () => undefined
    }) ?? messageRouteModule

  await assert.rejects(
    wakeHandlers.POST(
      new Request(`https://jormungand.test/api/workflow-runs/${wakeRun.id}/manager/wake`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reason: "operator_message",
          idempotencyKey: "wake-job-first-failure"
        })
      }),
      { params: Promise.resolve({ id: wakeRun.id }) }
    ),
    /execution job insert failed/
  )

  assert.equal(repository.listManagerWakes(wakeRun.id).length, 0)

  await assert.rejects(
    messageHandlers.POST(
      new Request(`https://jormungand.test/api/workflow-runs/${messageRun.id}/manager/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: "Please continue.",
          idempotencyKey: "message-job-first-failure"
        })
      }),
      { params: Promise.resolve({ id: messageRun.id }) }
    ),
    /execution job insert failed/
  )

  assert.equal(repository.listEvents({ workflowRunId: messageRun.id }).length, 0)
  assert.equal(repository.listManagerWakes(messageRun.id).length, 0)
})

test("manager duplicate reports running or queued without draining existing jobs", async (t) => {
  const { repository } = await openRepository(t)
  const managedRun = createManagedRun()
  const drainCalls: string[] = []
  let drainExpiredJob = false
  const routeModule = await importWorkflowRunManagerWakeRoute()
  const handlers = routeModule.createWorkflowRunManagerWakeRouteHandlers?.({
    getWorkflowRun: async (id) => (id === managedRun.id ? managedRun : undefined),
    repository,
    scheduleExecutionJobDrain: async (jobId) => {
      drainCalls.push(jobId)
      if (drainExpiredJob) {
        await runNextExecutionJob({
          repository,
          jobId,
          leaseOwner: "replacement-route-worker",
          leaseDurationMs: 30_000,
          handlers: {
            manager_wake: async () => ({ status: "recovered" })
          }
        })
      }
    }
  }) ?? routeModule

  const activeRequest = () => handlers.POST(
    new Request(`https://jormungand.test/api/workflow-runs/${managedRun.id}/manager/wake`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "health_check", idempotencyKey: "active-wake" })
    }),
    { params: Promise.resolve({ id: managedRun.id }) }
  )

  const activeResponse = await activeRequest()
  const activeBody = await activeResponse.json() as { status?: string; jobId?: string }
  assert.ok(activeBody.jobId)
  const activeClaim = await repository.claimExecutionJob({
    id: activeBody.jobId,
    leaseOwner: "active-worker",
    leaseDurationMs: 30_000
  })
  assert.equal(activeClaim?.status, "running")

  const activeDuplicateResponse = await activeRequest()
  const activeDuplicateBody = await activeDuplicateResponse.json() as { status?: string; jobId?: string }
  assert.equal(activeDuplicateResponse.status, 202)
  assert.equal(activeDuplicateBody.status, "running")
  assert.equal(activeDuplicateBody.jobId, activeBody.jobId)
  assert.equal(drainCalls.length, 1)

  const expiredJob = await repository.createExecutionJob({
    kind: "manager_wake",
    workflowRunId: managedRun.id,
    payload: { reason: "operator_resume" },
    idempotencyKey: `workflow-run-manager-wake:${managedRun.id}:expired-wake`,
    availableAt: "2020-01-01T00:00:00.000Z"
  })
  await repository.claimExecutionJob({
    id: expiredJob.job.id,
    leaseOwner: "expired-worker",
    leaseDurationMs: 1,
    now: "2020-01-01T00:00:00.000Z"
  })
  drainExpiredJob = true

  const expiredResponse = await handlers.POST(
    new Request(`https://jormungand.test/api/workflow-runs/${managedRun.id}/manager/wake`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "operator_resume", idempotencyKey: "expired-wake" })
    }),
    { params: Promise.resolve({ id: managedRun.id }) }
  )
  const expiredBody = await expiredResponse.json() as { status?: string; jobId?: string }

  assert.equal(expiredResponse.status, 202)
  assert.equal(expiredBody.status, "queued")
  assert.equal(expiredBody.jobId, expiredJob.job.id)
  assert.equal(repository.getExecutionJob(expiredJob.job.id)?.status, "completed")
  assert.equal(drainCalls.length, 2)
})

test("agent task workflow runs enqueue a durable advance job before returning", async (t) => {
  const { repository } = await openRepository(t)
  const project = createProject({
    name: "Agent task",
    type: "agent_task",
    goal: "Advance the agent task with durable execution.",
    repository: "github.com/acme/agent-task",
    source: "dashboard"
  })
  const drainCalls: string[] = []
  const routeModule = await importProjectWorkflowRunsRoute()
  const handlers =
    routeModule.createProjectWorkflowRunsRouteHandlers?.({
      getProject: async (id) => (id === project.id ? project : undefined),
      repository,
      scheduleExecutionJobDrain: async (jobId) => {
        drainCalls.push(jobId)
      }
    }) ?? routeModule

  const response = await handlers.POST(
    new Request(`https://jormungand.test/api/projects/${project.id}/workflow-runs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "agent-task-request-1"
      },
      body: JSON.stringify({
        selectedAgent: "codex"
      })
    }),
    { params: Promise.resolve({ id: project.id }) }
  )
  const body = await response.json() as { status?: string; jobId?: string }
  const job = body.jobId ? repository.getExecutionJob(body.jobId) : undefined

  assert.equal(response.status, 202)
  assert.equal(body.status, "queued")
  assert.ok(body.jobId)
  assert.equal(job?.kind, "agent_task_advance")
  assert.ok(job?.workflowRunId)
  assert.equal(job?.idempotencyKey, `agent-task-advance:${job?.workflowRunId}`)
  assert.deepEqual(drainCalls, [job?.id])

  const duplicateResponse = await handlers.POST(
    new Request(`https://jormungand.test/api/projects/${project.id}/workflow-runs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "agent-task-request-1"
      },
      body: JSON.stringify({
        selectedAgent: "codex"
      })
    }),
    { params: Promise.resolve({ id: project.id }) }
  )
  const duplicateBody = await duplicateResponse.json() as { status?: string; jobId?: string }

  assert.equal(duplicateResponse.status, 202)
  assert.equal(duplicateBody.jobId, body.jobId)
  assert.deepEqual(drainCalls, [job?.id])
})

test("agent task job insertion failure does not persist a running workflow", async (t) => {
  const { repository } = await openRepository(t)
  const project = createProject({
    name: "Agent task insert boundary",
    type: "agent_task",
    goal: "Do not persist a run before its durable job.",
    repository: "github.com/acme/agent-task-insert-boundary",
    source: "dashboard"
  })
  let upsertCalls = 0
  makeExecutionJobCreationFail(repository)
  const routeModule = await importProjectWorkflowRunsRoute()
  const handlers = routeModule.createProjectWorkflowRunsRouteHandlers?.({
    getProject: async (id) => (id === project.id ? project : undefined),
    repository,
    upsertWorkflowRun: async () => {
      upsertCalls += 1
      throw new Error("workflow run should not be persisted")
    },
    scheduleExecutionJobDrain: async () => undefined
  }) ?? routeModule

  await assert.rejects(
    handlers.POST(
      new Request(`https://jormungand.test/api/projects/${project.id}/workflow-runs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "agent-task-insert-boundary"
        },
        body: JSON.stringify({ selectedAgent: "codex" })
      }),
      { params: Promise.resolve({ id: project.id }) }
    ),
    /execution job insert failed/
  )

  assert.equal(upsertCalls, 0)
})

test("agent task run persistence failure cancels its queued execution job", async (t) => {
  const { repository } = await openRepository(t)
  const project = createProject({
    name: "Agent task persistence boundary",
    type: "agent_task",
    goal: "Cancel the job if run persistence fails.",
    repository: "github.com/acme/agent-task-persistence-boundary",
    source: "dashboard"
  })
  let createdJobId: string | undefined
  const originalCreateExecutionJob = repository.createExecutionJob.bind(repository)
  repository.createExecutionJob = async (input) => {
    const created = await originalCreateExecutionJob(input)
    createdJobId = created.job.id
    return created
  }
  const routeModule = await importProjectWorkflowRunsRoute()
  const handlers = routeModule.createProjectWorkflowRunsRouteHandlers?.({
    getProject: async (id) => (id === project.id ? project : undefined),
    repository,
    upsertWorkflowRun: async () => {
      throw new Error("workflow run persistence failed")
    },
    scheduleExecutionJobDrain: async () => undefined
  }) ?? routeModule

  await assert.rejects(
    handlers.POST(
      new Request(`https://jormungand.test/api/projects/${project.id}/workflow-runs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "agent-task-persistence-boundary"
        },
        body: JSON.stringify({ selectedAgent: "codex" })
      }),
      { params: Promise.resolve({ id: project.id }) }
    ),
    /workflow run persistence failed/
  )

  assert.ok(createdJobId)
  assert.equal(repository.getExecutionJob(createdJobId)?.status, "canceled")
})

test("manager side-effect failures cancel queued wake and message jobs", async (t) => {
  const { repository } = await openRepository(t)
  const wakeRun = createManagedRun()
  const messageRun = createManagedRun()
  const wakeRouteModule = await importWorkflowRunManagerWakeRoute()
  const messageRouteModule = await importWorkflowRunManagerMessageRoute()
  const failingScheduler = {
    enqueue: async () => {
      throw new Error("wake scheduler failed")
    },
    runNext: async () => {
      throw new Error("manager scheduler should not run")
    }
  }
  const wakeHandlers = wakeRouteModule.createWorkflowRunManagerWakeRouteHandlers?.({
    getWorkflowRun: async (id) => (id === wakeRun.id ? wakeRun : undefined),
    repository,
    scheduler: failingScheduler,
    scheduleExecutionJobDrain: async () => undefined
  }) ?? wakeRouteModule
  repository.appendEvent = async () => {
    throw new Error("message event append failed")
  }
  const messageHandlers = messageRouteModule.createWorkflowRunManagerMessageRouteHandlers?.({
    getWorkflowRun: async (id) => (id === messageRun.id ? messageRun : undefined),
    repository,
    scheduler: {
      enqueue: async () => undefined,
      runNext: async () => {
        throw new Error("manager scheduler should not run")
      }
    },
    scheduleExecutionJobDrain: async () => undefined
  }) ?? messageRouteModule

  await assert.rejects(
    wakeHandlers.POST(
      new Request(`https://jormungand.test/api/workflow-runs/${wakeRun.id}/manager/wake`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "health_check", idempotencyKey: "wake-side-effect-failure" })
      }),
      { params: Promise.resolve({ id: wakeRun.id }) }
    ),
    /wake scheduler failed/
  )

  await assert.rejects(
    messageHandlers.POST(
      new Request(`https://jormungand.test/api/workflow-runs/${messageRun.id}/manager/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "Continue.", idempotencyKey: "message-side-effect-failure" })
      }),
      { params: Promise.resolve({ id: messageRun.id }) }
    ),
    /message event append failed/
  )

  assert.equal(repository.getExecutionJobByIdempotencyKey(`workflow-run-manager-wake:${wakeRun.id}:wake-side-effect-failure`)?.status, "canceled")
  assert.equal(repository.getExecutionJobByIdempotencyKey(`workflow-run-manager-message:${messageRun.id}:message-side-effect-failure`)?.status, "canceled")
})

test("manager message duplicate reports a failed execution job", async (t) => {
  const { repository } = await openRepository(t)
  const managedRun = createManagedRun()
  const routeModule = await importWorkflowRunManagerMessageRoute()
  const handlers = routeModule.createWorkflowRunManagerMessageRouteHandlers?.({
    getWorkflowRun: async (id) => (id === managedRun.id ? managedRun : undefined),
    repository,
    scheduleExecutionJobDrain: async () => undefined
  }) ?? routeModule

  const request = () => handlers.POST(
    new Request(`https://jormungand.test/api/workflow-runs/${managedRun.id}/manager/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "Please retry the manager action.",
        idempotencyKey: "failed-message-request"
      })
    }),
    { params: Promise.resolve({ id: managedRun.id }) }
  )

  const initialResponse = await request()
  const initialBody = await initialResponse.json() as { jobId?: string }
  assert.ok(initialBody.jobId)
  const claimed = await repository.claimNextExecutionJob({
    leaseOwner: "failure-test",
    leaseDurationMs: 30_000
  })
  assert.equal(claimed?.id, initialBody.jobId)
  await repository.failExecutionJob({
    id: initialBody.jobId,
    leaseOwner: "failure-test",
    error: "manager execution failed"
  })

  const duplicateResponse = await request()
  const duplicateBody = await duplicateResponse.json() as { status?: string; jobId?: string; error?: string }

  assert.equal(duplicateResponse.status, 500)
  assert.equal(duplicateBody.status, "failed")
  assert.equal(duplicateBody.jobId, initialBody.jobId)
  assert.equal(duplicateBody.error, "manager execution failed")
})
