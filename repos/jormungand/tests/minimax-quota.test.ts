import { strict as assert } from "node:assert"
import { test } from "node:test"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

type QuotaModule = {
  parseMiniMaxQuotaResponse: (
    payload: unknown,
    options?: Record<string, unknown>
  ) => {
    remainingPercent: number
    unit: string
    status: string
  }
  fetchMiniMaxQuota: (options: {
    baseUrl: string
    token: string
    fetchImpl: typeof fetch
  }) => Promise<{
    remainingPercent: number
    status: string
  }>
}

async function loadQuotaModule() {
  const importModule = new Function(
    "specifier",
    "return import(specifier)"
  ) as (specifier: string) => Promise<QuotaModule>
  return importModule(
    pathToFileURL(resolve(process.cwd(), "scripts/minimax-quota.mjs")).href
  )
}

test("MiniMax quota maps the chat row interval remaining percentage", async () => {
  const { parseMiniMaxQuotaResponse } = await loadQuotaModule()
  const quota = parseMiniMaxQuotaResponse({
    model_remains: [
      {
        model_name: "general",
        current_interval_remaining_percent: 42,
        end_time: 1_800_000_000_000
      }
    ]
  })

  assert.equal(quota.remainingPercent, 42)
  assert.equal(quota.unit, "percent")
  assert.equal(quota.status, "warning")
})

test("MiniMax quota is unavailable without an interval remaining percentage", async () => {
  const { parseMiniMaxQuotaResponse } = await loadQuotaModule()
  const quota = parseMiniMaxQuotaResponse({
    model_remains: [{ model_name: "general" }]
  })

  assert.equal(quota.status, "unavailable")
})

test("MiniMax quota fetch uses the token plan remains endpoint", async () => {
  const { fetchMiniMaxQuota } = await loadQuotaModule()
  let requestUrl = ""
  let authorization = ""

  const quota = await fetchMiniMaxQuota({
    baseUrl: "https://api.minimax.io/v1/chat/completions",
    token: "test-token",
    fetchImpl: async (input, init) => {
      requestUrl = String(input)
      authorization = new Headers(init?.headers).get("Authorization") ?? ""
      return new Response(
        JSON.stringify({
          base_resp: { status_code: 0 },
          model_remains: [
            {
              model_name: "general",
              current_interval_remaining_percent: 73
            }
          ]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    }
  })

  assert.equal(requestUrl, "https://api.minimax.io/v1/token_plan/remains")
  assert.equal(authorization, "Bearer test-token")
  assert.equal(quota.remainingPercent, 73)
  assert.equal(quota.status, "healthy")
})
