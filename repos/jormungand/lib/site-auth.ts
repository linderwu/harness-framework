const unsafeHttpMethods = new Set(["POST", "PUT", "PATCH", "DELETE"])
const publicA2AAgentCardPath = "/.well-known/agent-card.json"
const a2aApiBasePath = "/api/a2a"

export type SiteAuthMode = "all" | "mutations" | "off"

export function normalizeSiteAuthMode(value: string | undefined): SiteAuthMode {
  switch (value?.toLowerCase()) {
    case "all":
      return "all"
    case "off":
    case "public":
      return "off"
    case "mutations":
      return "mutations"
    default:
      return "all"
  }
}

export function shouldRequireSiteAuthentication(
  method: string,
  modeValue?: string
) {
  const mode = normalizeSiteAuthMode(modeValue)

  if (mode === "off") {
    return false
  }

  if (mode === "all") {
    return true
  }

  return unsafeHttpMethods.has(method.toUpperCase())
}

export function shouldBypassSiteAuthentication(
  pathname: string,
  a2aTokenValue?: string
) {
  if (pathname === publicA2AAgentCardPath) {
    return true
  }

  if (!a2aTokenValue?.trim()) {
    return false
  }

  return pathname === a2aApiBasePath || pathname.startsWith(`${a2aApiBasePath}/`)
}
