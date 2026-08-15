import { existsSync, readFileSync } from "fs"
import path from "path"
import test from "node:test"
import assert from "node:assert/strict"

test("app project is rooted under repos/jormungand", () => {
  const appRoot = process.cwd()
  const workspaceRoot = path.resolve(appRoot, "..", "..")

  assert.equal(path.basename(appRoot), "jormungand")
  assert.equal(path.basename(path.dirname(appRoot)), "repos")
  assert.equal(existsSync(path.join(appRoot, "package.json")), true)

  for (const rootLocalPath of ["components", "lib", "tests"]) {
    assert.equal(
      existsSync(path.join(workspaceRoot, rootLocalPath)),
      false,
      `${rootLocalPath} should live under repos/jormungand`
    )
  }
  for (const compatibilityScript of ["openclaw-bridge.mjs", "openclaw-a2a.ps1", "start-openclaw-bridge.ps1"]) {
    assert.equal(existsSync(path.join(workspaceRoot, "scripts", compatibilityScript)), true)
  }
  for (const compatibilityRoute of ["agent-health", "agent-quotas"]) {
    assert.equal(
      existsSync(path.join(workspaceRoot, "app", "api", compatibilityRoute, "route.ts")),
      true,
      `${compatibilityRoute} remains an intentional workspace compatibility proxy`
    )
  }
})

test("Zeabur deploys the nested app project", () => {
  const workspaceRoot = path.resolve(process.cwd(), "..", "..")
  const zbpack = JSON.parse(
    readFileSync(path.join(workspaceRoot, "zbpack.json"), "utf8")
  )
  const dockerfile = readFileSync(path.join(workspaceRoot, "Dockerfile"), "utf8")

  assert.equal(zbpack.app_dir, "repos/jormungand")
  assert.match(dockerfile, /WORKDIR \/app\/repos\/jormungand/)
  assert.match(dockerfile, /\$\{PORT:-3000\}/)
})

test("Ouroboros production C4 sources and exports stay aligned", () => {
  const workspaceRoot = path.resolve(process.cwd(), "..", "..")
  const dsl = readFileSync(
    path.join(workspaceRoot, "wiki", "c4", "workspace.dsl"),
    "utf8"
  )
  const deploymentWiki = readFileSync(
    path.join(workspaceRoot, "wiki", "c4", "deployment.md"),
    "utf8"
  )
  const generator = readFileSync(
    path.join(process.cwd(), "scripts", "generate-c4-diagrams.mjs"),
    "utf8"
  )
  const manifest = JSON.parse(
    readFileSync(
      path.join(workspaceRoot, "wiki", "c4", "diagrams", "manifest.json"),
      "utf8"
    )
  ) as { outputs: Array<{ key: string; files: string[] }> }

  for (const token of [
    "/health",
    "/api/agent-health",
    "OpenClaw Bridge",
    "4178",
    "skill.lock.json"
  ]) {
    assert.match(dsl, new RegExp(token.replaceAll("/", "\\/")))
    assert.match(deploymentWiki, new RegExp(token.replaceAll("/", "\\/")))
    assert.match(generator, new RegExp(token.replaceAll("/", "\\/")))
  }

  assert.match(dsl, /deploymentProduction/)
  assert.match(generator, /key: "deployment-production"/)
  assert.equal(manifest.outputs.length, 12)
  assert.deepEqual(
    manifest.outputs.find((output) => output.key === "deployment-production")?.files,
    [
      "wiki/c4/diagrams/deployment-production.mmd",
      "wiki/c4/diagrams/deployment-production.svg"
    ]
  )
})
