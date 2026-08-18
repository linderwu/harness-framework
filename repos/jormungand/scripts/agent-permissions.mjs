export function normalizePermissionMode(value) {
  return String(value ?? "").trim().toLowerCase() === "restricted"
    ? "restricted"
    : "full"
}
