import assert from "node:assert/strict"
import test from "node:test"
import {
  normalizeSiteAuthMode,
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
