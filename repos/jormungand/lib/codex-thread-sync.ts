export type NativeTurnStatus = "inProgress" | "completed" | "failed" | "interrupted"

export interface NativeUserMessageItem {
  id: string
  type: "userMessage"
  content: Array<{ type?: string; text?: string }>
}

export interface NativeAgentMessageItem {
  id: string
  type: "agentMessage"
  text?: string
  phase?: string
}

export interface NativeActivityItem {
  id: string
  type: string
  text?: string
  command?: string
}

export type NativeTurnItem =
  | NativeUserMessageItem
  | NativeAgentMessageItem
  | NativeActivityItem

export interface NativeTurn {
  id: string
  status: NativeTurnStatus
  items: NativeTurnItem[]
}

export interface NativeProjectionEntry {
  nativeThreadId: string
  nativeTurnId: string
  nativeItemId: string
  role: "user" | "agent"
  source: "harness" | "codex"
  content: string
  status: "running" | "completed" | "failed" | "interrupted"
  idempotencyKey: string
  replyToNativeTurnId?: string
}

export interface NativeThreadProjection {
  entries: NativeProjectionEntry[]
  terminalStatus?: "completed" | "failed" | "interrupted"
}

export function projectNativeThread(input: {
  conversationId: string
  nativeThreadId: string
  turns: NativeTurn[]
  harnessTurnIds: Set<string>
  ledgerKeys: Set<string>
}): NativeThreadProjection {
  const entries: NativeProjectionEntry[] = []
  let terminalStatus: NativeThreadProjection["terminalStatus"]

  for (const turn of input.turns) {
    if (turn.status !== "inProgress") terminalStatus = toTerminalStatus(turn.status)
    const source = input.harnessTurnIds.has(turn.id) ? "harness" : "codex"

    for (const item of turn.items) {
      const ledgerKey = `${input.nativeThreadId}:${turn.id}:${item.id}`
      if (input.ledgerKeys.has(ledgerKey)) continue

      if (item.type === "userMessage") {
        if (source === "harness") continue
        const content = extractUserText(item as NativeUserMessageItem)
        if (!content) continue
        entries.push({
          nativeThreadId: input.nativeThreadId,
          nativeTurnId: turn.id,
          nativeItemId: item.id,
          role: "user",
          source,
          content,
          status: toEntryStatus(turn.status),
          idempotencyKey: `codex:${ledgerKey}`
        })
        continue
      }

      if (item.type !== "agentMessage" || !item.text?.trim()) continue
      entries.push({
        nativeThreadId: input.nativeThreadId,
        nativeTurnId: turn.id,
        nativeItemId: item.id,
        role: "agent",
        source,
        content: item.text.trim(),
        status: toEntryStatus(turn.status),
        idempotencyKey: `codex:${ledgerKey}`,
        replyToNativeTurnId: turn.id
      })
    }
  }

  return { entries, terminalStatus }
}

function extractUserText(item: NativeUserMessageItem) {
  return item.content
    .filter((part) => part.type === undefined || part.type === "text")
    .map((part) => part.text ?? "")
    .join("")
    .trim()
}

function toEntryStatus(status: NativeTurnStatus): NativeProjectionEntry["status"] {
  if (status === "inProgress") return "running"
  return status
}

function toTerminalStatus(status: Exclude<NativeTurnStatus, "inProgress">) {
  return status
}
