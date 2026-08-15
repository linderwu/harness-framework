"use client"

import {
  Activity,
  Archive,
  Bot,
  ChevronDown,
  ChevronLeft,
  CircleDollarSign,
  Network,
  ShieldCheck,
  Users
} from "lucide-react"
import { useState, type ReactNode } from "react"
import { getAgentLabel } from "@/lib/agents"
import type { ConversationEntry } from "@/lib/hive-memory/types"
import type { AgentKind, AgentRun, WorkflowRun } from "@/lib/types"

export function TaskStatusSidebar({
  run,
  entries,
  bridgeConnections,
  isExpanded,
  isMobileOpen,
  onMobileClose,
  onExpandedChange
}: {
  run: WorkflowRun
  entries: ConversationEntry[]
  bridgeConnections: ReactNode
  isExpanded: boolean
  isMobileOpen?: boolean
  onMobileClose?: () => void
  onExpandedChange: (expanded: boolean) => void
}) {
  const memoryIds = Array.from(new Set(entries.flatMap((entry) => entry.memoryIds))).slice(-8)
  const budget = run.managed?.budget
  const managedTaskTotal = run.managed
    ? Object.values(run.managed.taskCounts).reduce((total, count) => total + count, 0)
    : run.events.length
  const agentStatuses = getAgentStatuses(run)

  return (
    <aside
      className={`panel taskStatusSidebar${isExpanded ? "" : " collapsed"}${isMobileOpen ? " mobilePanelOpen" : ""}`}
      data-right-collapsed={!isExpanded}
    >
      <div className="mobileDrawerHeader">
        <strong>Task monitoring</strong>
        <button aria-label="Close task monitoring" className="iconButton" onClick={onMobileClose} type="button">×</button>
      </div>
      <button
        aria-expanded={isExpanded}
        aria-label={isExpanded ? "Collapse task monitoring" : "Expand task monitoring"}
        className="railToggle monitoringRailToggle"
        onClick={() => onExpandedChange(!isExpanded)}
        type="button"
      >
        {isExpanded ? <><span>Task monitoring</span><ChevronDown size={16} /></> : <ChevronLeft size={18} />}
      </button>

      {isExpanded ? (
        <div className="monitoringSections">
          <MonitoringSection icon={<Activity size={16} />} title="Current Task">
            <dl>
              <div><dt>Stage</dt><dd>{run.currentStage}</dd></div>
              <div><dt>Status</dt><dd>{run.status.replaceAll("_", " ")}</dd></div>
              <div><dt>Progress</dt><dd>{run.managed?.taskCounts.completed ?? 0} / {managedTaskTotal}</dd></div>
              {budget ? <div><dt>Calls</dt><dd>{budget.callsUsed} / {budget.callLimit}</dd></div> : null}
            </dl>
          </MonitoringSection>

          <MonitoringSection icon={<Users size={16} />} title="Agent Role Status">
            <div className="agentRoleStatusList">
              {agentStatuses.map(({ agent, assignment, role, status }) => (
                <article className="agentRoleStatusCard" key={agent}>
                  <div className="agentRoleStatusHeader">
                    <span className="agentRoleIcon"><Bot aria-hidden="true" size={15} /></span>
                    <span><strong>{getAgentLabel(agent)}</strong><small>{role}</small></span>
                  </div>
                  <span className={`agentRoleRunStatus ${status.replaceAll("_", "-")}`}>{status.replaceAll("_", " ")}</span>
                  <p>{assignment}</p>
                </article>
              ))}
            </div>
          </MonitoringSection>

          <MonitoringSection icon={<ShieldCheck size={16} />} title="Governance">
            <dl>
              <div><dt>Memories used</dt><dd>{memoryIds.length}</dd></div>
              <div><dt>Artifacts</dt><dd>{run.artifacts.length}</dd></div>
              <div><dt>Pending approval</dt><dd>{run.approvalGates.filter((gate) => gate.status === "pending").length}</dd></div>
            </dl>
            {budget ? <p className="monitoringBudget"><CircleDollarSign size={14} />${budget.costUsedUsd.toFixed(2)} / ${budget.costLimitUsd.toFixed(2)}</p> : null}
            {memoryIds.length ? <div className="monitoringMemoryLinks"><Archive size={14} />{memoryIds.map((id) => <a id={`memory-${id}`} href={`#memory-${id}`} key={id}>Memory {id.slice(0, 8)}</a>)}</div> : null}
          </MonitoringSection>

          <MonitoringSection icon={<Network size={16} />} title="Bridge Connections">
            {bridgeConnections}
          </MonitoringSection>
        </div>
      ) : null}
    </aside>
  )
}

function MonitoringSection({
  children,
  defaultOpen = true,
  icon,
  title
}: {
  children: ReactNode
  defaultOpen?: boolean
  icon: ReactNode
  title: string
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen)

  return (
    <section className="monitoringSection">
      <button
        aria-expanded={isOpen}
        className="monitoringSectionToggle"
        onClick={() => setIsOpen((current) => !current)}
        type="button"
      >
        <span>{icon}<strong>{title}</strong></span>
        {isOpen ? <ChevronDown size={16} /> : <ChevronLeft size={16} />}
      </button>
      {isOpen ? <div className="monitoringSectionBody">{children}</div> : null}
    </section>
  )
}

function getAgentStatuses(run: WorkflowRun) {
  const latestRuns = new Map<AgentKind, AgentRun>()
  for (const agentRun of run.agentRuns) latestRuns.set(agentRun.agent, agentRun)

  const agents = Array.from(latestRuns.keys())
  if ((run.projectType === "hive_mission" || run.projectType === "arceus_maintenance") && !agents.includes("codex")) {
    agents.unshift("codex")
  }
  if (agents.length === 0) agents.push("codex")

  return agents.map((agent) => {
    const agentRun = latestRuns.get(agent)
    return {
      agent,
      role: getAgentRole(agent, run),
      status: agentRun?.status ?? "idle",
      assignment: agentRun?.statusMessage ?? (agentRun ? `${agentRun.stage} stage` : "Available")
    }
  })
}

function getAgentRole(agent: AgentKind, run: WorkflowRun) {
  if (agent === "codex") {
    if (run.projectType === "hive_mission") return "Hive Manager"
    if (run.projectType === "llm_wiki_maintenance") return "Wiki Steward"
    if (run.projectType === "arceus_maintenance") return "Arceus Maintainer"
    return "Orchestrator"
  }
  if (agent === "openclaw.rowlet") return "Researcher"
  if (agent === "openclaw.mrmime") return "Reviewer"
  if (agent === "openclaw.gengar") return "Tester"
  return "Builder"
}
