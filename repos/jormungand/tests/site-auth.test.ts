import assert from "node:assert/strict"
import test from "node:test"
import {
  normalizeSiteAuthMode,
  shouldRequireSiteAuthentication
} from "../lib/site-auth"

test("site auth defaults to protecting mutating requests only", () => {
  assert.equal(shouldRequireSiteAuthentication("GET"), false)
  assert.equal(shouldRequireSiteAuthentication("HEAD"), false)
  assert.equal(shouldRequireSiteAuthentication("OPTIONS"), false)
  assert.equal(shouldRequireSiteAuthentication("POST"), true)
  assert.equal(shouldRequireSiteAuthentication("PUT"), true)
  assert.equal(shouldRequireSiteAuthentication("PATCH"), true)
  assert.equal(shouldRequireSiteAuthentication("DELETE"), true)
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
