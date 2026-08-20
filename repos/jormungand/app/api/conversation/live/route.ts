import { NextResponse } from "next/server"
import {
  ConversationIdentityError,
  resolveConversationId,
  setConversationCookie
} from "@/lib/conversation-identity"
import {
  agentLiveBus,
  getAgentLiveSnapshot,
  subscribeAgentLiveEvents,
  type AgentLiveBus
} from "@/lib/agent-live-bus"
import type { AgentLiveEvent } from "@/lib/agent-live-events"

interface ConversationLiveRouteDependencies {
  bus?: AgentLiveBus
}

export function formatAgentLiveSse(eventName: string, payload: unknown) {
  return `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`
}

function isTerminalEvent(event: AgentLiveEvent) {
  return event.type === "completed" || event.type === "failed"
}

function startsNewLifecycle(
  event: AgentLiveEvent,
  terminalSnapshotEvent?: AgentLiveEvent
) {
  if (event.type !== "started") {
    return false
  }

  const nextRunId = event.metadata?.runId?.trim()
  if (!nextRunId) {
    return true
  }

  const priorRunId = terminalSnapshotEvent?.metadata?.runId?.trim()
  return nextRunId !== priorRunId
}

function createConversationLiveStream(request: Request, conversationId: string, bus: AgentLiveBus) {
  const encoder = new TextEncoder()
  let closeStream: (shouldCloseController?: boolean) => void = () => undefined

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false
      let replayComplete = false
      let lastDeliveredSequence = -1
      const pendingEvents: AgentLiveEvent[] = []
      let replayObservedNewLifecycle = false
      let unsubscribe: () => void = () => undefined

      closeStream = (shouldCloseController = true) => {
        if (closed) {
          return
        }
        closed = true
        request.signal.removeEventListener("abort", handleAbort)
        unsubscribe()
        if (shouldCloseController) {
          controller.close()
        }
      }

      const enqueue = (eventName: string, payload: unknown) => {
        if (closed) {
          return
        }
        controller.enqueue(encoder.encode(formatAgentLiveSse(eventName, payload)))
      }

      const deliver = (event: AgentLiveEvent, closeOnTerminal = true) => {
        if (event.sequence <= lastDeliveredSequence) {
          return
        }
        lastDeliveredSequence = event.sequence
        enqueue("agent-live", event)
        if (closeOnTerminal && isTerminalEvent(event)) {
          closeStream()
        }
      }

      const subscription = subscribeAgentLiveEvents(conversationId, (event) => {
        if (!replayComplete) {
          pendingEvents.push(event)
          return
        }
        deliver(event)
      }, bus)
      unsubscribe = () => subscription.unsubscribe()

      const handleAbort = () => {
        closeStream()
      }

      if (request.signal.aborted) {
        closeStream()
        return
      }

      request.signal.addEventListener("abort", handleAbort, { once: true })

      const snapshot = getAgentLiveSnapshot(conversationId, bus)
      const terminalSnapshotEvent = [...snapshot.events]
        .reverse()
        .find(isTerminalEvent)

      enqueue("ready", {
        conversationId,
        terminal: snapshot.terminal
      })

      for (const event of snapshot.events) {
        deliver(event, false)
      }

      replayComplete = true

      for (const event of pendingEvents) {
        replayObservedNewLifecycle ||= startsNewLifecycle(event, terminalSnapshotEvent)
        deliver(event)
      }

      if (snapshot.terminal && !replayObservedNewLifecycle) {
        closeStream()
      }
    },
    cancel() {
      closeStream(false)
    }
  })
}

export function createConversationLiveRouteHandlers(
  dependencies: ConversationLiveRouteDependencies = {}
) {
  const bus = dependencies.bus ?? agentLiveBus

  return {
    async GET(request: Request) {
      const requestedConversationId = new URL(request.url).searchParams.get("conversationId")

      try {
        const identity = resolveConversationId({
          request: requestedConversationId === null ? undefined : request,
          bodyConversationId: requestedConversationId ?? undefined,
          legacyMode: "reject",
          requireExplicit: true
        })

        const response = new NextResponse(
          createConversationLiveStream(request, identity.conversationId, bus),
          {
            status: 200,
            headers: {
              "cache-control": "no-cache, no-transform",
              connection: "keep-alive",
              "content-type": "text/event-stream; charset=utf-8"
            }
          }
        )

        return identity.shouldSetCookie
          ? setConversationCookie(response, identity.conversationId, request)
          : response
      } catch (error) {
        if (error instanceof ConversationIdentityError) {
          return NextResponse.json({ error: error.message }, { status: error.status })
        }

        return NextResponse.json(
          { error: error instanceof Error ? error.message : String(error) },
          { status: 500 }
        )
      }
    }
  }
}

export const { GET } = createConversationLiveRouteHandlers()
