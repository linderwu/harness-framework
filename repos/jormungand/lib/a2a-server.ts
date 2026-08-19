import type { A2AEventRecord, A2ATaskRecord, A2ATaskStatus } from "./a2a-runtime"
import { normalizeA2ATaskStatus } from "./a2a-runtime"
import {
  A2AProtocolError,
  parseA2AMessageRequest,
  PUBLIC_A2A_PROTOCOL_VERSION,
  type A2AJsonRpcMethod,
  type A2ADataPart,
  type A2AMessagePart,
  type A2ATextPart,
  type ParsedA2AMessageRequest
} from "./a2a-protocol"
import type { HiveMemoryRepository } from "./hive-memory/repository"

export interface A2AArtifact {
  artifactId: string
  name?: string
  parts: A2AMessagePart[]
  metadata?: Record<string, unknown>
}

export interface A2AMessage {
  kind: "message"
  messageId: string
  contextId: string
  role: "agent"
  parts: A2AMessagePart[]
  metadata?: Record<string, unknown>
}

export interface A2ATask {
  kind: "task"
  id: string
  contextId: string
  status: {
    state: A2ATaskStatus
    message?: A2AMessage
  }
  artifacts: A2AArtifact[]
  metadata?: Record<string, unknown>
}

export interface A2AStreamFrame {
  event: string
  data: {
    sequence: number
    taskId: string
    contextId: string
    status: {
      state: A2ATaskStatus
      message?: A2AMessage
    }
    artifact?: A2AArtifact
  }
}

export interface A2ADispatchArtifactInput {
  artifactId?: string
  name?: string
  text?: string
  data?: unknown
  metadata?: Record<string, unknown>
}

export interface A2ADispatchResult {
  status: string
  text?: string
  artifacts?: A2ADispatchArtifactInput[]
  metadata?: Record<string, unknown>
  remoteTaskId?: string
  cancel?: () => Promise<void> | void
}

export interface A2AServerDispatchInput {
  request: ParsedA2AMessageRequest
  task: A2ATaskRecord
}

interface A2AServerDependencies {
  repository: HiveMemoryRepository
  dispatch: (input: A2AServerDispatchInput) => Promise<A2ADispatchResult> | A2ADispatchResult
  authorize?: (input: { request: ParsedA2AMessageRequest }) => Promise<void> | void
}

class A2AServer {
  private readonly cancelHandlers = new Map<string, () => Promise<void> | void>()

  constructor(private readonly dependencies: A2AServerDependencies) {}

  async send(request: unknown) {
    return this.handleSend(request, ["message/send"])
  }

  async getTask(taskId: string) {
    return this.buildTask(taskId)
  }

  async cancelTask(taskId: string) {
    const task = this.requireTask(taskId)
    if (task.status === "completed" || task.status === "failed" || task.status === "canceled") {
      return this.buildTask(taskId)
    }

    await this.cancelHandlers.get(taskId)?.()
    const completedAt = new Date().toISOString()
    await this.dependencies.repository.updateA2ATask({
      id: taskId,
      status: "canceled",
      completedAt
    })
    await this.dependencies.repository.appendA2AEvent({
      taskId,
      eventType: "task_canceled",
      actor: "a2a_server",
      payload: { status: "canceled" }
    })

    return this.buildTask(taskId)
  }

  async *stream(taskId: string): AsyncGenerator<A2AStreamFrame> {
    const task = this.requireTask(taskId)
    const message = this.getResponseMessage(taskId)
    let state: A2ATaskStatus = "submitted"

    for (const event of this.dependencies.repository.listA2AEvents(taskId)) {
      state = nextStateForEvent(state, event.eventType)
      const artifact = parseArtifact(event.payload.artifact)

      yield {
        event: event.eventType,
        data: {
          sequence: event.sequence,
          taskId,
          contextId: task.contextId,
          status: {
            state,
            message: isTerminalState(state) ? message : undefined
          },
          artifact
        }
      }
    }
  }

  async *sendStream(request: unknown): AsyncGenerator<A2AStreamFrame> {
    const task = await this.handleSend(request, ["message/send", "message/stream"])
    for await (const frame of this.stream(task.id)) {
      yield frame
    }
  }

  private async handleSend(
    rawRequest: unknown,
    allowedMethods: readonly A2AJsonRpcMethod[]
  ) {
    const request = parseA2AMessageRequest(rawRequest, { allowedMethods })
    await this.dependencies.authorize?.({ request })

    const existing = this.dependencies.repository.getA2ATaskByIdempotencyKey(
      request.idempotencyKey
    )
    if (existing) {
      return this.buildTask(existing.id)
    }

    const created = await this.dependencies.repository.createA2ATask({
      contextId: request.message.contextId,
      fromAgent: request.fromAgent,
      toAgent: request.toAgent,
      status: "submitted",
      requestMessageId: request.message.messageId,
      idempotencyKey: request.idempotencyKey
    })
    if (!created.inserted) {
      return this.buildTask(created.task.id)
    }

    const persistedMessage = await this.dependencies.repository.insertA2AMessage({
      taskId: created.task.id,
      contextId: created.task.contextId,
      direction: "inbound",
      fromAgent: created.task.fromAgent,
      toAgent: created.task.toAgent,
      protocolVersion: PUBLIC_A2A_PROTOCOL_VERSION,
      method: request.method,
      transport: "jsonrpc",
      idempotencyKey: request.idempotencyKey,
      requestFrame: rawRequest
    })

    await this.dependencies.repository.appendA2AEvent({
      taskId: created.task.id,
      messageId: persistedMessage.id,
      eventType: "message_queued",
      actor: "a2a_server",
      payload: {
        idempotencyKey: request.idempotencyKey,
        messageId: request.message.messageId
      }
    })
    await this.dependencies.repository.appendA2AEvent({
      taskId: created.task.id,
      messageId: persistedMessage.id,
      eventType: "message_accepted",
      actor: "a2a_server",
      payload: {
        rpcId: request.id,
        method: request.method
      }
    })
    await this.dependencies.repository.updateA2ATask({
      id: created.task.id,
      status: "working"
    })
    await this.dependencies.repository.appendA2AEvent({
      taskId: created.task.id,
      messageId: persistedMessage.id,
      eventType: "task_working",
      actor: request.toAgent,
      payload: { status: "working" }
    })

    try {
      const dispatchResult = await this.dependencies.dispatch({
        request,
        task: this.requireTask(created.task.id)
      })
      if (dispatchResult.cancel) {
        this.cancelHandlers.set(created.task.id, dispatchResult.cancel)
      }

      const status = normalizeA2ATaskStatus(dispatchResult.status)
      const artifacts = normalizeArtifacts(dispatchResult.artifacts)
      const responseMessage = createResponseMessage(created.task, dispatchResult.text)
      const terminal = isTerminalState(status)
      const completedAt = terminal ? new Date().toISOString() : undefined

      await this.dependencies.repository.updateA2AMessageResponse({
        id: persistedMessage.id,
        responseFrame: {
          result: createTaskPayload({
            task: created.task,
            status,
            artifacts,
            message: responseMessage,
            metadata: dispatchResult.metadata,
            remoteTaskId: dispatchResult.remoteTaskId
          })
        }
      })

      for (const artifact of artifacts) {
        await this.dependencies.repository.appendA2AEvent({
          taskId: created.task.id,
          messageId: persistedMessage.id,
          eventType: "task_artifact_updated",
          actor: request.toAgent,
          payload: { artifact }
        })
      }

      if (status === "input-required") {
        await this.dependencies.repository.updateA2ATask({
          id: created.task.id,
          status
        })
        await this.dependencies.repository.appendA2AEvent({
          taskId: created.task.id,
          messageId: persistedMessage.id,
          eventType: "task_input_required",
          actor: request.toAgent,
          payload: { status }
        })
      } else {
        await this.dependencies.repository.updateA2ATask({
          id: created.task.id,
          remoteTaskId: dispatchResult.remoteTaskId,
          status,
          errorMessage: status === "failed" ? dispatchResult.text : undefined,
          completedAt
        })

        if (terminal) {
          await this.dependencies.repository.appendA2AEvent({
            taskId: created.task.id,
            messageId: persistedMessage.id,
            eventType: eventTypeForStatus(status),
            actor: request.toAgent,
            payload: {
              status,
              artifactCount: artifacts.length
            }
          })
        }
      }

      return this.buildTask(created.task.id)
    } catch (error) {
      const message = error instanceof Error ? error.message : "Dispatch failed"
      await this.dependencies.repository.updateA2AMessageResponse({
        id: persistedMessage.id,
        responseFrame: {
          error: {
            message
          }
        }
      })
      await this.dependencies.repository.updateA2ATask({
        id: created.task.id,
        status: "failed",
        errorCode: "dispatch_failed",
        errorMessage: message,
        completedAt: new Date().toISOString()
      })
      await this.dependencies.repository.appendA2AEvent({
        taskId: created.task.id,
        messageId: persistedMessage.id,
        eventType: "task_failed",
        actor: "a2a_server",
        payload: { message }
      })
      throw error
    }
  }

  private buildTask(taskId: string) {
    const task = this.requireTask(taskId)
    const messages = this.dependencies.repository.listA2AMessages(taskId)
    const artifacts = this.collectArtifacts(taskId, messages)
    const responseMessage = this.getResponseMessage(taskId, messages)

    return createTaskPayload({
      task,
      status: task.status,
      artifacts,
      message: responseMessage,
      remoteTaskId: task.remoteTaskId
    })
  }

  private collectArtifacts(taskId: string, messages?: ReturnType<HiveMemoryRepository["listA2AMessages"]>) {
    const fromEvents = this.dependencies.repository
      .listA2AEvents(taskId)
      .map((event) => parseArtifact(event.payload.artifact))
      .filter((artifact): artifact is A2AArtifact => Boolean(artifact))

    if (fromEvents.length > 0) {
      return fromEvents
    }

    const parsed = parseStoredTaskResult((messages ?? this.dependencies.repository.listA2AMessages(taskId)).at(-1)?.responseJson)
    return parsed?.artifacts ?? []
  }

  private getResponseMessage(
    taskId: string,
    messages?: ReturnType<HiveMemoryRepository["listA2AMessages"]>
  ) {
    const parsed = parseStoredTaskResult((messages ?? this.dependencies.repository.listA2AMessages(taskId)).at(-1)?.responseJson)
    return parsed?.message ?? createResponseMessage(this.requireTask(taskId))
  }

  private requireTask(taskId: string) {
    const task = this.dependencies.repository.getA2ATask(taskId)
    if (!task) {
      throw new A2AProtocolError(`Task ${taskId} was not found`, -32004, 404)
    }
    return task
  }
}

export function createA2AServer(dependencies: A2AServerDependencies) {
  return new A2AServer(dependencies)
}

function createTaskPayload(input: {
  task: Pick<A2ATaskRecord, "id" | "contextId">
  status: A2ATaskStatus
  artifacts: A2AArtifact[]
  message?: A2AMessage
  metadata?: Record<string, unknown>
  remoteTaskId?: string
}): A2ATask {
  const metadata = input.remoteTaskId || input.metadata
    ? {
        ...(input.remoteTaskId ? { remoteTaskId: input.remoteTaskId } : {}),
        ...(input.metadata ?? {})
      }
    : undefined

  return {
    kind: "task",
    id: input.task.id,
    contextId: input.task.contextId,
    status: {
      state: input.status,
      message: input.message
    },
    artifacts: input.artifacts,
    metadata
  }
}

function createResponseMessage(
  task: Pick<A2ATaskRecord, "contextId" | "requestMessageId">,
  text?: string
) {
  if (!text?.trim()) {
    return undefined
  }

  return {
    kind: "message",
    messageId: `${task.requestMessageId}:response`,
    contextId: task.contextId,
    role: "agent",
    parts: [createTextPart(text.trim())]
  } satisfies A2AMessage
}

function normalizeArtifacts(artifacts: A2ADispatchArtifactInput[] | undefined) {
  if (!artifacts?.length) {
    return []
  }

  const normalized: A2AArtifact[] = []

  artifacts.forEach((artifact, index) => {
    const parts = [
      artifact.text ? createTextPart(artifact.text) : undefined,
      artifact.data !== undefined ? createDataPart(artifact.data) : undefined
    ].filter((part): part is A2AMessagePart => Boolean(part))

    if (parts.length === 0) {
      return
    }

    normalized.push({
      artifactId: artifact.artifactId ?? `artifact-${index + 1}`,
      parts,
      ...(artifact.name ? { name: artifact.name } : {}),
      ...(artifact.metadata ? { metadata: artifact.metadata } : {})
    })
  })

  return normalized
}

function parseStoredTaskResult(responseJson: string | undefined) {
  if (!responseJson) {
    return undefined
  }

  try {
    const parsed = JSON.parse(responseJson) as {
      result?: {
        status?: { message?: unknown }
        artifacts?: unknown[]
      }
    }
    const message = parseMessage(parsed.result?.status?.message)
    const artifacts: A2AArtifact[] = []
    if (Array.isArray(parsed.result?.artifacts)) {
      for (const artifact of parsed.result.artifacts) {
        const parsedArtifact = parseArtifact(artifact)
        if (parsedArtifact) {
          artifacts.push(parsedArtifact)
        }
      }
    }

    return { message, artifacts }
  } catch {
    return undefined
  }
}

function parseMessage(value: unknown) {
  const record = asRecord(value)
  if (!record || record.kind !== "message" || record.role !== "agent") {
    return undefined
  }

  const messageId = getString(record.messageId).trim()
  const contextId = getString(record.contextId).trim()
  const parts = Array.isArray(record.parts)
    ? record.parts
      .map((part) => parsePart(part))
      .filter((part): part is A2AMessagePart => Boolean(part))
    : []

  if (!messageId || !contextId || parts.length === 0) {
    return undefined
  }

  return {
    kind: "message",
    messageId,
    contextId,
    role: "agent",
    parts
  } satisfies A2AMessage
}

function parseArtifact(value: unknown) {
  const record = asRecord(value)
  if (!record) {
    return undefined
  }

  const artifactId = getString(record.artifactId).trim()
  const parts = Array.isArray(record.parts)
    ? record.parts
      .map((part) => parsePart(part))
      .filter((part): part is A2AMessagePart => Boolean(part))
    : []

  if (!artifactId || parts.length === 0) {
    return undefined
  }

  const name = getString(record.name).trim() || undefined
  const metadata = asRecord(record.metadata)

  return {
    artifactId,
    parts,
    ...(name ? { name } : {}),
    ...(metadata ? { metadata } : {})
  }
}

function parsePart(value: unknown) {
  const record = asRecord(value)
  if (!record) {
    return undefined
  }
  if (record.kind === "text" && typeof record.text === "string" && record.text.trim()) {
    return createTextPart(record.text)
  }
  if (record.kind === "data" && "data" in record) {
    return createDataPart(record.data)
  }
  return undefined
}

function createTextPart(text: string): A2ATextPart {
  return { kind: "text", text }
}

function createDataPart(data: unknown): A2ADataPart {
  return { kind: "data", data }
}

function eventTypeForStatus(status: A2ATaskStatus) {
  switch (status) {
    case "completed":
      return "task_completed"
    case "failed":
      return "task_failed"
    case "canceled":
      return "task_canceled"
    default:
      return "task_completed"
  }
}

function nextStateForEvent(
  current: A2ATaskStatus,
  eventType: A2AEventRecord["eventType"]
): A2ATaskStatus {
  switch (eventType) {
    case "message_queued":
      return "submitted"
    case "message_accepted":
    case "task_working":
    case "task_artifact_updated":
      return "working"
    case "task_input_required":
      return "input-required"
    case "task_completed":
      return "completed"
    case "task_failed":
      return "failed"
    case "task_canceled":
      return "canceled"
    default:
      return current
  }
}

function isTerminalState(status: A2ATaskStatus) {
  return status === "completed" || status === "failed" || status === "canceled"
}

function asRecord(value: unknown) {
  return value && typeof value === "object"
    ? value as Record<string, unknown>
    : undefined
}

function getString(value: unknown) {
  return typeof value === "string" ? value : ""
}
