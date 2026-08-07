import { readFileSync } from "node:fs"
import { test } from "node:test"
import { strict as assert } from "node:assert"

const dashboard = readFileSync("components/harness-dashboard.tsx", "utf8")

function functionBody(functionName: string) {
  const start = dashboard.indexOf(`function ${functionName}(`)

  assert.notEqual(start, -1, `Expected ${functionName} to exist`)

  const nextFunction = dashboard.indexOf("\nfunction ", start + 1)

  return dashboard.slice(start, nextFunction === -1 ? undefined : nextFunction)
}

test("run detail does not repeat the project hero summary", () => {
  const runDetail = functionBody("RunDetail")

  assert.doesNotMatch(runDetail, /className="panel heroPanel"/)
})

test("run detail does not repeat the project progress timeline", () => {
  const runDetail = functionBody("RunDetail")

  assert.doesNotMatch(runDetail, /className="panel timelinePanel"/)
})
