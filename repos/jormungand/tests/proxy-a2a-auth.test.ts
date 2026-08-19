import assert from "node:assert/strict"
import test from "node:test"

import { NextRequest } from "next/server"

import { proxy } from "../proxy"

function restoreEnv(key: string) {
  const previous = process.env[key]
  return () => {
    if (previous === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = previous
    }
  }
}

function nextRequest(pathname: string) {
  return new NextRequest(`https://jormungand.test${pathname}`)
}

function assertBypassesSiteAuth(response: Response) {
  assert.equal(response.status, 200)
  assert.equal(response.headers.get("x-middleware-next"), "1")
}

test("proxy leaves the public Agent Card unchallenged even when site auth and JORMUNGAND_A2A_TOKEN are configured", (t) => {
  const restoreMode = restoreEnv("SITE_AUTH_MODE")
  const restoreUser = restoreEnv("SITE_AUTH_USERNAME")
  const restorePassword = restoreEnv("SITE_AUTH_PASSWORD")
  const restoreA2AToken = restoreEnv("JORMUNGAND_A2A_TOKEN")
  t.after(() => {
    restoreMode()
    restoreUser()
    restorePassword()
    restoreA2AToken()
  })

  process.env.SITE_AUTH_MODE = "all"
  process.env.SITE_AUTH_USERNAME = "site-user"
  process.env.SITE_AUTH_PASSWORD = "site-password"
  process.env.JORMUNGAND_A2A_TOKEN = "a2a-token"

  const response = proxy(nextRequest("/.well-known/agent-card.json"))

  assertBypassesSiteAuth(response)
})

test("proxy bypasses site Basic Auth for the A2A API surface when JORMUNGAND_A2A_TOKEN is configured", (t) => {
  const restoreMode = restoreEnv("SITE_AUTH_MODE")
  const restoreUser = restoreEnv("SITE_AUTH_USERNAME")
  const restorePassword = restoreEnv("SITE_AUTH_PASSWORD")
  const restoreA2AToken = restoreEnv("JORMUNGAND_A2A_TOKEN")
  t.after(() => {
    restoreMode()
    restoreUser()
    restorePassword()
    restoreA2AToken()
  })

  process.env.SITE_AUTH_MODE = "all"
  process.env.SITE_AUTH_USERNAME = "site-user"
  process.env.SITE_AUTH_PASSWORD = "site-password"
  process.env.JORMUNGAND_A2A_TOKEN = "a2a-token"

  assertBypassesSiteAuth(proxy(nextRequest("/api/a2a")))
  assertBypassesSiteAuth(proxy(nextRequest("/api/a2a/tasks/task-1")))
  assertBypassesSiteAuth(proxy(nextRequest("/api/a2a/audit/task-1")))
  assert.equal(proxy(nextRequest("/")).status, 401)
})

test("proxy still requires site auth for the A2A API surface when JORMUNGAND_A2A_TOKEN is unset", (t) => {
  const restoreMode = restoreEnv("SITE_AUTH_MODE")
  const restoreUser = restoreEnv("SITE_AUTH_USERNAME")
  const restorePassword = restoreEnv("SITE_AUTH_PASSWORD")
  const restoreA2AToken = restoreEnv("JORMUNGAND_A2A_TOKEN")
  t.after(() => {
    restoreMode()
    restoreUser()
    restorePassword()
    restoreA2AToken()
  })

  process.env.SITE_AUTH_MODE = "all"
  process.env.SITE_AUTH_USERNAME = "site-user"
  process.env.SITE_AUTH_PASSWORD = "site-password"
  delete process.env.JORMUNGAND_A2A_TOKEN

  assert.equal(proxy(nextRequest("/api/a2a")).status, 401)
  assert.equal(proxy(nextRequest("/api/a2a/tasks/task-1")).status, 401)
  assert.equal(proxy(nextRequest("/api/a2a/audit/task-1")).status, 401)
  assertBypassesSiteAuth(proxy(nextRequest("/.well-known/agent-card.json")))
})
