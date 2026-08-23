import type { HiveMemoryRepository } from "./hive-memory/repository"

type SyncWorkerRepository = Pick<
  HiveMemoryRepository,
  "listCodexSessions" | "updateCodexSession"
>

export function createCodexSyncWorker(input: {
  repository: SyncWorkerRepository
  syncConversation: (conversationId: string) => Promise<unknown>
  intervalMs?: number
  setIntervalFn?: typeof setInterval
  clearIntervalFn?: typeof clearInterval
}) {
  const intervalMs = Math.max(1_000, input.intervalMs ?? Number(process.env.CODEX_SYNC_INTERVAL_MS ?? 10_000))
  const setIntervalFn = input.setIntervalFn ?? setInterval
  const clearIntervalFn = input.clearIntervalFn ?? clearInterval
  let timer: ReturnType<typeof setInterval> | undefined
  let ticking = false

  async function tick() {
    if (ticking) return
    ticking = true
    try {
      for (const session of input.repository.listCodexSessions()) {
        if (session.mappingState === "deleted" || session.mappingState === "archived") continue
        try {
          await input.syncConversation(session.conversationId)
        } catch {
          await input.repository.updateCodexSession({
            conversationId: session.conversationId,
            status: "offline",
            mappingState: "offline"
          })
        }
      }
    } finally {
      ticking = false
    }
  }

  function start() {
    if (timer) return
    timer = setIntervalFn(() => {
      void tick()
    }, intervalMs)
    timer.unref?.()
  }

  function stop() {
    if (!timer) return
    clearIntervalFn(timer)
    timer = undefined
  }

  return { tick, start, stop, intervalMs }
}
