export type AgentPermissionMode = "full" | "restricted"

export function getAgentPermissionMode(
  value = process.env.JORMUNGAND_AGENT_PERMISSION_MODE
): AgentPermissionMode {
  return value?.trim().toLowerCase() === "restricted" ? "restricted" : "full"
}

export function isFullAgentPermissionMode(
  value = process.env.JORMUNGAND_AGENT_PERMISSION_MODE
) {
  return getAgentPermissionMode(value) === "full"
}
