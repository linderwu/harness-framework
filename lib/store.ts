import { promises as fs } from "fs"
import path from "path"
import type { HarnessState, WorkflowRun } from "@/lib/types"
import { createDefaultEventSkills } from "@/lib/workflow"

const statePath = path.join(process.cwd(), "data", "harness-state.json")

async function ensureStateFile() {
  await fs.mkdir(path.dirname(statePath), { recursive: true })

  try {
    await fs.access(statePath)
  } catch {
    await fs.writeFile(
      statePath,
      JSON.stringify({ workflowRuns: [] } satisfies HarnessState, null, 2)
    )
  }
}

export async function readState(): Promise<HarnessState> {
  await ensureStateFile()
  const raw = await fs.readFile(statePath, "utf8")
  const state = JSON.parse(raw) as HarnessState
  return {
    workflowRuns: state.workflowRuns.map(normalizeWorkflowRun)
  }
}

export async function writeState(state: HarnessState) {
  await ensureStateFile()
  await fs.writeFile(statePath, JSON.stringify(state, null, 2))
}

export async function listWorkflowRuns() {
  const state = await readState()
  return state.workflowRuns.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function getWorkflowRun(id: string) {
  const state = await readState()
  return state.workflowRuns.find((run) => run.id === id)
}

export async function upsertWorkflowRun(nextRun: WorkflowRun) {
  const state = await readState()
  const index = state.workflowRuns.findIndex((run) => run.id === nextRun.id)

  if (index >= 0) {
    state.workflowRuns[index] = nextRun
  } else {
    state.workflowRuns.push(nextRun)
  }

  await writeState(state)
  return nextRun
}

function normalizeWorkflowRun(run: WorkflowRun): WorkflowRun {
  const eventSkills = run.eventSkills ?? createDefaultEventSkills()

  return {
    ...run,
    eventSkills,
    skillAssignments:
      run.skillAssignments ??
      Object.fromEntries(
        eventSkills.map((skill) => [skill.id, run.selectedAgent])
      ),
    events: run.events ?? []
  }
}
