import { buildSharedConversationHistory } from "./conversation-history"
import type { ConversationEntry } from "./hive-memory/types"

export interface ConversationHistorySyncResult {
  history: Array<{ role: "user" | "assistant"; content: string }>
  cursorEntryId?: string
}

type SharedConversationSourceEntry = Pick<ConversationEntry, "id" | "role" | "agentId" | "content">

export class ConversationHistorySync {
  private readonly cursors = new Map<string, { cursorEntryId?: string }>()

  getDelta(input: {
    key: string
    sessionIdentity: string
    targetAgent: string
    entries: SharedConversationSourceEntry[]
  }): ConversationHistorySyncResult {
    const shareableEntries = input.entries.filter(isShareableConversationEntry)
    const cursorState = this.cursors.get(buildCursorKey(input.key, input.sessionIdentity))

    if (!cursorState?.cursorEntryId) {
      return buildSeedResult(shareableEntries)
    }

    const cursorIndex = shareableEntries.findIndex((entry) => entry.id === cursorState.cursorEntryId)

    if (cursorIndex === -1) {
      return buildSeedResult(shareableEntries)
    }

    const entriesAfterCursor = shareableEntries.slice(cursorIndex + 1)

    return {
      history: buildSharedConversationHistory(
        entriesAfterCursor.filter((entry) => !isSelfResponseEntry(entry, input.targetAgent))
      ),
      cursorEntryId: entriesAfterCursor.at(-1)?.id ?? cursorState.cursorEntryId
    }
  }

  markDelivered(input: {
    key: string
    sessionIdentity: string
    cursorEntryId?: string
  }): void {
    this.cursors.set(buildCursorKey(input.key, input.sessionIdentity), {
      cursorEntryId: input.cursorEntryId
    })
  }
}

function buildSeedResult(entries: SharedConversationSourceEntry[]): ConversationHistorySyncResult {
  return {
    history: buildSharedConversationHistory(entries),
    cursorEntryId: entries.at(-1)?.id
  }
}

function buildCursorKey(key: string, sessionIdentity: string) {
  return JSON.stringify([key, sessionIdentity])
}

function isShareableConversationEntry(entry: SharedConversationSourceEntry) {
  return entry.role === "user" || entry.role === "agent" || entry.role === "manager"
}

function isSelfResponseEntry(entry: SharedConversationSourceEntry, targetAgent: string) {
  return entry.agentId === targetAgent && (entry.role === "agent" || entry.role === "manager")
}
