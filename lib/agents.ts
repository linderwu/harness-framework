import type { AgentKind, OpenClawMainAgent } from "@/lib/types"

export type AgentFamily = "codex" | "openclaw" | "manual"

export interface AgentProfile {
  id: AgentKind
  label: string
  family: AgentFamily
  mainAgent?: OpenClawMainAgent
}

export const defaultAgentKind: AgentKind = "codex"
export const defaultOpenClawAgentKind: AgentKind = "openclaw.rowlet"

export const agentProfiles = [
  {
    id: "codex",
    label: "Codex",
    family: "codex"
  },
  {
    id: "openclaw.rowlet",
    label: "Rowlet",
    family: "openclaw",
    mainAgent: "rowlet"
  },
  {
    id: "openclaw.roaringmoon",
    label: "Roaring Moon",
    family: "openclaw",
    mainAgent: "roaringmoon"
  },
  {
    id: "openclaw.charizard",
    label: "Charizard",
    family: "openclaw",
    mainAgent: "charizard"
  },
  {
    id: "manual",
    label: "Manual",
    family: "manual"
  }
] as const satisfies readonly AgentProfile[]

export const openClawAgentKinds = agentProfiles
  .filter((agent) => agent.family === "openclaw")
  .map((agent) => agent.id)

export function normalizeAgentKind(value: string | undefined): AgentKind {
  if (value === "openclaw") {
    return defaultOpenClawAgentKind
  }

  const profile = agentProfiles.find((agent) => agent.id === value)
  return profile?.id ?? defaultAgentKind
}

export function getAgentProfile(value: AgentKind | string): AgentProfile {
  const agent = normalizeAgentKind(value)
  return agentProfiles.find((profile) => profile.id === agent) ?? agentProfiles[0]
}

export function getAgentLabel(value: AgentKind | string) {
  return getAgentProfile(value).label
}

export function getOpenClawMainAgent(value: AgentKind | string) {
  const profile = getAgentProfile(value)
  return profile.family === "openclaw" ? profile.mainAgent : undefined
}

export function isOpenClawAgent(value: AgentKind | string) {
  return getAgentProfile(value).family === "openclaw"
}
