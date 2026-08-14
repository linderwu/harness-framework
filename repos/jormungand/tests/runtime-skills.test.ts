import assert from "node:assert/strict"
import test from "node:test"
import {
  resolveRuntimeSkillBundles,
  type RuntimeSkillLockfile,
  type RuntimeSkillRegistry
} from "../lib/runtime-skills"

const checksum = {
  algorithm: "sha256" as const,
  value: "c9b1d3ece463869d22d8c560b50a3082e5dede290126b84c07461869b509ee8d"
}

const sourceUrl =
  "https://github.com/linderwu/harness-framework/releases/download/skills-v1.0.0/superpowers-full-1.0.0.tgz"

const registry: RuntimeSkillRegistry = {
  schemaVersion: "runtime-skills/v1",
  bundles: [
    {
      id: "superpowers-full",
      versions: [
        {
          version: "1.0.0",
          sourceUrl,
          checksum,
          skills: ["brainstorming", "tdd", "verification-before-completion"]
        }
      ]
    }
  ]
}

const lockfile: RuntimeSkillLockfile = {
  schemaVersion: "runtime-skills-lock/v1",
  lockedBundles: [
    {
      id: "superpowers-full",
      version: "1.0.0",
      sourceUrl,
      checksum
    }
  ]
}

test("runtime skill resolver returns required descriptors from the strict lockfile", () => {
  const result = resolveRuntimeSkillBundles({
    requestedBundleIds: ["superpowers-full"],
    registry,
    lockfile
  })

  assert.equal(result.status, "completed")
  assert.deepEqual(result.status === "completed" ? result.bundles : [], [
    {
      id: "superpowers-full",
      version: "1.0.0",
      sourceUrl,
      checksum,
      required: true
    }
  ])
})

test("runtime skill resolver fails when a requested bundle is not locked", () => {
  const result = resolveRuntimeSkillBundles({
    requestedBundleIds: ["missing-bundle"],
    registry,
    lockfile
  })

  assert.equal(result.status, "failed")
  assert.equal(result.status === "failed" ? result.errorCode : "", "bundle_not_locked")
})

test("runtime skill resolver fails when a locked bundle is not in the curated registry", () => {
  const result = resolveRuntimeSkillBundles({
    requestedBundleIds: ["superpowers-full"],
    registry: { ...registry, bundles: [] },
    lockfile
  })

  assert.equal(result.status, "failed")
  assert.equal(result.status === "failed" ? result.errorCode : "", "bundle_not_in_registry")
})

test("runtime skill resolver fails when lockfile and registry checksum differ", () => {
  const result = resolveRuntimeSkillBundles({
    requestedBundleIds: ["superpowers-full"],
    registry,
    lockfile: {
      ...lockfile,
      lockedBundles: [
        {
          ...lockfile.lockedBundles[0],
          checksum: {
            algorithm: "sha256",
            value: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
          }
        }
      ]
    }
  })

  assert.equal(result.status, "failed")
  assert.equal(
    result.status === "failed" ? result.errorCode : "",
    "lockfile_registry_mismatch"
  )
})
