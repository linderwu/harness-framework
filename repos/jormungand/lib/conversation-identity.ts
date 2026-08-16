import type { ResponseCookie } from "next/dist/compiled/@edge-runtime/cookies"
import { NextResponse } from "next/server"

export const legacyConversationId = "global:unbound-conversation"
export const conversationCookieName = "jormungand-conversation-id"
const legacyConversationCookieName = "jormungand_conversation_id"
const conversationCookieMaxAgeSeconds = 60 * 60 * 24 * 180
const conversationIdPattern =
  /^conversation:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export class ConversationIdentityError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
  }
}

export function createConversationId() {
  return `conversation:${crypto.randomUUID()}`
}

export function isValidConversationId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (value === legacyConversationId || conversationIdPattern.test(value))
  )
}

export function resolveConversationId(input: {
  request?: Request
  bodyConversationId?: unknown
  fallbackToLegacy?: boolean
  requireExplicit?: boolean
}) {
  const cookieConversationId = readConversationIdCookie(input.request)

  if (input.bodyConversationId !== undefined) {
    if (!isValidConversationId(input.bodyConversationId)) {
      throw new ConversationIdentityError("conversationId is invalid")
    }
    return {
      conversationId: input.bodyConversationId,
      shouldSetCookie: cookieConversationId !== input.bodyConversationId
    }
  }

  if (cookieConversationId) {
    return { conversationId: cookieConversationId, shouldSetCookie: false }
  }

  if (input.requireExplicit) {
    throw new ConversationIdentityError("conversationId is required")
  }

  if (input.fallbackToLegacy) {
    return {
      conversationId: legacyConversationId,
      shouldSetCookie: true
    }
  }

  throw new ConversationIdentityError("conversationId is required")
}

export function setConversationCookie(
  response: NextResponse,
  conversationId: string,
  request?: Request
) {
  const expires = new Date(Date.now() + conversationCookieMaxAgeSeconds * 1000)
  const options: ResponseCookie = {
    name: conversationCookieName,
    value: conversationId,
    httpOnly: true,
    sameSite: "lax",
    secure: shouldUseSecureCookie(request),
    path: "/",
    maxAge: conversationCookieMaxAgeSeconds,
    expires
  }
  response.cookies.set(options)
  return response
}

function readConversationIdCookie(request?: Request) {
  const cookieHeader = request?.headers.get("cookie")
  if (!cookieHeader) return undefined

  const parsed = parseCookieHeader(cookieHeader)
  const value =
    parsed[conversationCookieName] ??
    parsed[legacyConversationCookieName]

  return isValidConversationId(value) ? value : undefined
}

function parseCookieHeader(value: string) {
  const cookies: Record<string, string> = {}

  for (const pair of value.split(";")) {
    const separatorIndex = pair.indexOf("=")
    if (separatorIndex <= 0) continue

    const key = safeDecodeCookieComponent(pair.slice(0, separatorIndex).trim())
    const cookieValue = safeDecodeCookieComponent(pair.slice(separatorIndex + 1).trim())
    if (!key || cookieValue === undefined) continue
    cookies[key] = cookieValue
  }

  return cookies
}

function safeDecodeCookieComponent(value: string) {
  try {
    return decodeURIComponent(value)
  } catch {
    return undefined
  }
}

function shouldUseSecureCookie(request?: Request) {
  return process.env.NODE_ENV === "production" || request?.url.startsWith("https://") === true
}
