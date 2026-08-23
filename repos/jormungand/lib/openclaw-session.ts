import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

export interface OpenClawSessionIdentityInput {
  mainAgent?: string
  conversationId?: unknown
  workflowRunId?: unknown
  fallbackId?: unknown
  sessionKey?: unknown
}

export interface OpenClawSessionIdentity {
  sessionKey: string
  sessionKeyFingerprint: string
}

type OpenClawSessionHelper = {
  deriveOpenClawSessionKey(input?: OpenClawSessionIdentityInput): string
  deriveOpenClawSessionIdentity(
    input?: OpenClawSessionIdentityInput
  ): OpenClawSessionIdentity
}

let openClawSessionHelperPromise: Promise<OpenClawSessionHelper> | undefined

export async function deriveOpenClawSessionKey(
  input: OpenClawSessionIdentityInput = {}
) {
  const helper = await loadOpenClawSessionHelper()
  return helper.deriveOpenClawSessionKey(input)
}

export async function deriveOpenClawSessionIdentity(
  input: OpenClawSessionIdentityInput = {}
) {
  const helper = await loadOpenClawSessionHelper()
  return helper.deriveOpenClawSessionIdentity(input)
}

async function loadOpenClawSessionHelper() {
  if (!openClawSessionHelperPromise) {
    // Native import keeps the CommonJS test build able to execute the ESM helper.
    const loadModule = new Function(
      "modulePath",
      "return import(modulePath)"
    ) as (modulePath: string) => Promise<OpenClawSessionHelper>
    const helperPath = pathToFileURL(
      resolve(process.cwd(), "scripts/openclaw-session.mjs")
    ).href
    openClawSessionHelperPromise = loadModule(helperPath)
  }

  return openClawSessionHelperPromise
}
