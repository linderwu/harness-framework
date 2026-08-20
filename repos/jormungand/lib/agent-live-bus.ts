import type { AgentLiveEvent } from "./agent-live-events"
import { MAX_AGENT_LIVE_EVENTS } from "./agent-live-events"

const DEFAULT_IDLE_TTL_MS = 30_000

type AgentLiveListener = (event: AgentLiveEvent) => void
type TimerHandle = ReturnType<typeof setTimeout>

interface ConversationState {
  events: AgentLiveEvent[]
  listeners: Set<AgentLiveListener>
  terminal: boolean
  lastSequence: number
  cleanupTimer?: TimerHandle
}

export interface AgentLiveSnapshot {
  conversationId: string
  events: AgentLiveEvent[]
  terminal: boolean
  lastSequence: number
}

export interface AgentLiveSubscription {
  unsubscribe(): void
}

export interface AgentLiveBus {
  publish(event: AgentLiveEvent): boolean
  subscribe(conversationId: string, listener: AgentLiveListener): AgentLiveSubscription
  getSnapshot(conversationId: string): AgentLiveSnapshot
}

export interface AgentLiveBusOptions {
  maxEvents?: number
  idleTtlMs?: number
}

function isTerminalEvent(event: AgentLiveEvent) {
  return event.type === "completed" || event.type === "failed"
}

function maybeUnrefTimer(timer: TimerHandle) {
  if (
    typeof timer === "object" &&
    timer !== null &&
    "unref" in timer &&
    typeof timer.unref === "function"
  ) {
    timer.unref()
  }
}

export function createAgentLiveBus(options: AgentLiveBusOptions = {}): AgentLiveBus {
  const maxEvents = Math.max(1, options.maxEvents ?? MAX_AGENT_LIVE_EVENTS)
  const idleTtlMs = Math.max(1, options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS)
  const conversations = new Map<string, ConversationState>()

  function getOrCreateConversation(conversationId: string) {
    let state = conversations.get(conversationId)
    if (!state) {
      state = {
        events: [],
        listeners: new Set(),
        terminal: false,
        lastSequence: -1
      }
      conversations.set(conversationId, state)
    }
    clearCleanup(state)
    return state
  }

  function clearCleanup(state: ConversationState) {
    if (!state.cleanupTimer) {
      return
    }
    clearTimeout(state.cleanupTimer)
    state.cleanupTimer = undefined
  }

  function scheduleCleanup(conversationId: string, state: ConversationState) {
    clearCleanup(state)
    state.cleanupTimer = setTimeout(() => {
      const current = conversations.get(conversationId)
      if (!current || current.listeners.size > 0) {
        return
      }
      conversations.delete(conversationId)
    }, idleTtlMs)
    maybeUnrefTimer(state.cleanupTimer)
  }

  function getSnapshot(conversationId: string): AgentLiveSnapshot {
    const state = conversations.get(conversationId)
    return {
      conversationId,
      events: state ? [...state.events] : [],
      terminal: state?.terminal ?? false,
      lastSequence: state?.lastSequence ?? -1
    }
  }

  return {
    publish(event) {
      const state = getOrCreateConversation(event.conversationId)
      if (event.sequence <= state.lastSequence) {
        return false
      }

      state.lastSequence = event.sequence
      state.terminal = state.terminal || isTerminalEvent(event)
      state.events = [...state.events, event].slice(-maxEvents)

      for (const listener of [...state.listeners]) {
        listener(event)
      }

      if (state.listeners.size === 0) {
        scheduleCleanup(event.conversationId, state)
      }

      return true
    },
    subscribe(conversationId, listener) {
      const state = getOrCreateConversation(conversationId)
      state.listeners.add(listener)

      return {
        unsubscribe() {
          const current = conversations.get(conversationId)
          if (!current) {
            return
          }
          current.listeners.delete(listener)
          if (current.listeners.size === 0) {
            scheduleCleanup(conversationId, current)
          }
        }
      }
    },
    getSnapshot
  }
}

const agentLiveBusGlobal = globalThis as typeof globalThis & {
  __jormungandAgentLiveBus__?: AgentLiveBus
}

export const agentLiveBus = agentLiveBusGlobal.__jormungandAgentLiveBus__
  ?? (agentLiveBusGlobal.__jormungandAgentLiveBus__ = createAgentLiveBus())

export function publishAgentLiveEvent(
  event: AgentLiveEvent,
  bus: AgentLiveBus = agentLiveBus
) {
  return bus.publish(event)
}

export function subscribeAgentLiveEvents(
  conversationId: string,
  listener: AgentLiveListener,
  bus: AgentLiveBus = agentLiveBus
) {
  return bus.subscribe(conversationId, listener)
}

export function getAgentLiveSnapshot(
  conversationId: string,
  bus: AgentLiveBus = agentLiveBus
) {
  return bus.getSnapshot(conversationId)
}
