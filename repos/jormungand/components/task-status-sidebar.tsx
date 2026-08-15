import { Activity, Archive, Bot, CircleDollarSign, ShieldCheck } from "lucide-react"
import type { ConversationEntry } from "@/lib/hive-memory/types"
import type { WorkflowRun } from "@/lib/types"

export function TaskStatusSidebar({ run, entries }: { run: WorkflowRun; entries: ConversationEntry[] }) {
  const activeAgents = Array.from(new Set(run.agentRuns.filter((item) => item.status === "running").map((item) => item.agent)))
  const memoryIds = Array.from(new Set(entries.flatMap((entry) => entry.memoryIds))).slice(-8)
  const budget = run.managed?.budget
  const managedTaskTotal = run.managed ? Object.values(run.managed.taskCounts).reduce((total, count) => total + count, 0) : run.events.length
  return (
    <aside className="panel taskStatusSidebar">
      <details open><summary><Activity size={16} />Task status</summary><dl><div><dt>Stage</dt><dd>{run.currentStage}</dd></div><div><dt>Status</dt><dd>{run.status.replaceAll("_", " ")}</dd></div><div><dt>Progress</dt><dd>{run.managed?.taskCounts.completed ?? 0} done / {managedTaskTotal} total</dd></div></dl></details>
      <details><summary><Bot size={16} />Active agents</summary><p>{activeAgents.length ? activeAgents.join(", ") : "No agent currently running."}</p></details>
      {budget ? <details><summary><CircleDollarSign size={16} />Budget</summary><p>{budget.callsUsed}/{budget.callLimit} calls · ${budget.costUsedUsd.toFixed(2)}/${budget.costLimitUsd.toFixed(2)}</p></details> : null}
      <details><summary><Archive size={16} />Evidence</summary><p>{run.artifacts.length} artifacts</p>{memoryIds.length ? memoryIds.map((id) => <a id={`memory-${id}`} href={`#memory-${id}`} key={id}>Memory {id.slice(0, 8)}</a>) : <p>No memory referenced yet.</p>}</details>
      <details open><summary><ShieldCheck size={16} />Approvals</summary><p>{run.approvalGates.filter((gate) => gate.status === "pending").length} pending</p></details>
    </aside>
  )
}
