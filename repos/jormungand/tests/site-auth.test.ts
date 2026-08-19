import assert from "node:assert/strict"
import test from "node:test"
import {
  normalizeSiteAuthMode,
  shouldBypassSiteAuthentication,
  shouldRequireSiteAuthentication
} from "../lib/site-auth"

test("site auth protects the whole site by default", () => {
  assert.equal(shouldRequireSiteAuthentication("GET"), true)
  assert.equal(shouldRequireSiteAuthentication("HEAD"), true)
  assert.equal(shouldRequireSiteAuthentication("OPTIONS"), true)
  assert.equal(shouldRequireSiteAuthentication("POST"), true)
  assert.equal(shouldRequireSiteAuthentication("PUT"), true)
  assert.equal(shouldRequireSiteAuthentication("PATCH"), true)
  assert.equal(shouldRequireSiteAuthentication("DELETE"), true)
})

test("site auth can be limited to mutating requests", () => {
  assert.equal(shouldRequireSiteAuthentication("GET", "mutations"), false)
  assert.equal(shouldRequireSiteAuthentication("POST", "mutations"), true)
})

test("site auth can be forced across the whole site", () => {
  assert.equal(shouldRequireSiteAuthentication("GET", "all"), true)
  assert.equal(shouldRequireSiteAuthentication("POST", "all"), true)
})

test("site auth can be disabled explicitly", () => {
  assert.equal(normalizeSiteAuthMode("public"), "off")
  assert.equal(shouldRequireSiteAuthentication("POST", "off"), false)
  assert.equal(shouldRequireSiteAuthentication("POST", "public"), false)
})

test("the Agent Card stays public regardless of JORMUNGAND_A2A_TOKEN", () => {
  assert.equal(
    shouldBypassSiteAuthentication("/.well-known/agent-card.json"),
    true
  )
  assert.equal(
    shouldBypassSiteAuthentication("/.well-known/agent-card.json", "a2a-token"),
    true
  )
})

test("the A2A API surface bypasses site auth only when JORMUNGAND_A2A_TOKEN is configured", () => {
  assert.equal(shouldBypassSiteAuthentication("/api/a2a"), false)
  assert.equal(shouldBypassSiteAuthentication("/api/a2a/tasks/task-1"), false)
  assert.equal(shouldBypassSiteAuthentication("/api/a2a/audit/task-1"), false)

  assert.equal(shouldBypassSiteAuthentication("/api/a2a", "a2a-token"), true)
  assert.equal(
    shouldBypassSiteAuthentication("/api/a2a/tasks/task-1", "a2a-token"),
    true
  )
  assert.equal(
    shouldBypassSiteAuthentication("/api/a2a/audit/task-1", "a2a-token"),
    true
  )
  assert.equal(shouldBypassSiteAuthentication("/", "a2a-token"), false)
})
