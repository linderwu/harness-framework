const unsafeHttpMethods = new Set(["POST", "PUT", "PATCH", "DELETE"])

export type SiteAuthMode = "all" | "mutations" | "off"

export function normalizeSiteAuthMode(value: string | undefined): SiteAuthMode {
  switch (value?.toLowerCase()) {
    case "all":
      return "all"
    case "off":
    case "public":
      return "off"
    case "mutations":
    default:
      return "mutations"
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
