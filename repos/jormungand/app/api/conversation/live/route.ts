import { NextResponse } from "next/server"
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

function createConversationLiveStream(request: Request, conversationId: string, bus: AgentLiveBus) {
  const encoder = new TextEncoder()

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false
      let replayComplete = false
      let lastDeliveredSequence = -1
      const pendingEvents: AgentLiveEvent[] = []

      const closeStream = () => {
        if (closed) {
          return
        }
        closed = true
        request.signal.removeEventListener("abort", handleAbort)
        subscription.unsubscribe()
        controller.close()
      }

      const enqueue = (eventName: string, payload: unknown) => {
        if (closed) {
          return
        }
        controller.enqueue(encoder.encode(formatAgentLiveSse(eventName, payload)))
      }

      const deliver = (event: AgentLiveEvent) => {
        if (event.sequence <= lastDeliveredSequence) {
          return
        }
        lastDeliveredSequence = event.sequence
        enqueue("agent-live", event)
        if (isTerminalEvent(event)) {
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

      const handleAbort = () => {
        closeStream()
      }

      if (request.signal.aborted) {
        closeStream()
        return
      }

      request.signal.addEventListener("abort", handleAbort, { once: true })

      const snapshot = getAgentLiveSnapshot(conversationId, bus)

      enqueue("ready", {
        conversationId,
        terminal: snapshot.terminal
      })

      for (const event of snapshot.events) {
        deliver(event)
      }

      replayComplete = true

      for (const event of pendingEvents) {
        deliver(event)
      }

      if (snapshot.terminal) {
        closeStream()
      }
    }
  })
}

export function createConversationLiveRouteHandlers(
  dependencies: ConversationLiveRouteDependencies = {}
) {
  const bus = dependencies.bus ?? agentLiveBus

  return {
    async GET(request: Request) {
      const conversationId = new URL(request.url).searchParams.get("conversationId")?.trim()

      if (!conversationId) {
        return NextResponse.json({ error: "conversationId is required" }, { status: 400 })
      }

      return new Response(createConversationLiveStream(request, conversationId, bus), {
        status: 200,
        headers: {
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "content-type": "text/event-stream; charset=utf-8"
        }
      })
    }
  }
}

export const { GET } = createConversationLiveRouteHandlers()
