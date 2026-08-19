import assert from "node:assert/strict"
import test from "node:test"

import {
  canonicalizeJson,
  normalizeA2ATaskStatus,
  redactA2AFrame,
  sha256Json
} from "../lib/a2a-runtime"

test("A2A frame redaction redacts secret-bearing keys recursively without mutating the input", () => {
  const original = {
    authorization: "Bearer secret",
    nested: {
      token: "top-secret",
      content: "keep",
      list: [
        { password: "hidden" },
        { safe: true }
      ]
    },
    site_auth_header: "cookie-ish"
  }

  const redacted = redactA2AFrame(original) as typeof original

  assert.notStrictEqual(redacted, original)
  assert.equal(redacted.authorization, "[REDACTED]")
  assert.equal(redacted.nested.token, "[REDACTED]")
  assert.equal(redacted.nested.content, "keep")
  assert.equal(redacted.nested.list[0]?.password, "[REDACTED]")
  assert.equal(redacted.nested.list[1]?.safe, true)
  assert.equal(redacted.site_auth_header, "[REDACTED]")
  assert.equal(original.authorization, "Bearer secret")
  assert.equal(original.nested.token, "top-secret")
  assert.equal(original.nested.list[0]?.password, "hidden")
  assert.equal(original.site_auth_header, "cookie-ish")
})

test("A2A frame redaction redacts embedded bearer and key-value secrets inside ordinary strings", () => {
  const original = {
    note: "Authorization: Bearer upstream-secret",
    transcript: "cookie=sessionid123 token=abc123 keep this context.",
    nested: {
      summary: "password=hunter2 and secret: super-secret",
      normal: "Discuss token rotation conceptually without sharing any credential."
    }
  }

  const redacted = redactA2AFrame(original) as typeof original

  assert.equal(redacted.note, "Authorization: Bearer [REDACTED]")
  assert.equal(
    redacted.transcript,
    "cookie=[REDACTED] token=[REDACTED] keep this context."
  )
  assert.equal(
    redacted.nested.summary,
    "password=[REDACTED] and secret: [REDACTED]"
  )
  assert.equal(
    redacted.nested.normal,
    "Discuss token rotation conceptually without sharing any credential."
  )
  assert.equal(original.note, "Authorization: Bearer upstream-secret")
  assert.equal(original.transcript, "cookie=sessionid123 token=abc123 keep this context.")
  assert.equal(original.nested.summary, "password=hunter2 and secret: super-secret")
})

test("A2A frame hashing uses canonical JSON order", () => {
  assert.equal(
    canonicalizeJson({ b: 2, a: 1, nested: { z: 1, a: [3, { d: 4, c: 5 }] } }),
    "{\"a\":1,\"b\":2,\"nested\":{\"a\":[3,{\"c\":5,\"d\":4}],\"z\":1}}"
  )
  assert.equal(
    sha256Json({ b: 2, a: 1, nested: { z: 1, a: [3, { d: 4, c: 5 }] } }),
    sha256Json({ nested: { a: [3, { c: 5, d: 4 }], z: 1 }, a: 1, b: 2 })
  )
})

test("A2A task status normalization keeps known values and falls back to unknown", () => {
  assert.equal(normalizeA2ATaskStatus("working"), "working")
  assert.equal(normalizeA2ATaskStatus("input-required"), "input-required")
  assert.equal(normalizeA2ATaskStatus("unknown-value"), "unknown")
})
