import assert from "node:assert/strict"
import test from "node:test"
import { getGitAuthEnvironment } from "../lib/superpowers-catalog"

test("private skill repository auth is passed to git through an authorization header", () => {
  const environment = getGitAuthEnvironment("test-token")

  assert.equal(environment.GIT_CONFIG_COUNT, "1")
  assert.equal(environment.GIT_CONFIG_KEY_0, "http.extraheader")
  assert.match(environment.GIT_CONFIG_VALUE_0 ?? "", /^AUTHORIZATION: Basic /)
  assert.ok(!environment.GIT_CONFIG_VALUE_0?.includes("test-token"))
})
