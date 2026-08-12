import { existsSync } from "fs"
import path from "path"
import test from "node:test"
import assert from "node:assert/strict"

test("app project is rooted under repos/jormungand", () => {
  const appRoot = process.cwd()
  const workspaceRoot = path.resolve(appRoot, "..", "..")

  assert.equal(path.basename(appRoot), "jormungand")
  assert.equal(path.basename(path.dirname(appRoot)), "repos")
  assert.equal(existsSync(path.join(appRoot, "package.json")), true)

  for (const rootLocalPath of ["app", "components", "lib", "scripts", "tests"]) {
    assert.equal(
      existsSync(path.join(workspaceRoot, rootLocalPath)),
      false,
      `${rootLocalPath} should live under repos/jormungand`
    )
  }
})
