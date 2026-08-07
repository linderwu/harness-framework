import type {
  RuntimeSkillBundleDescriptor,
  RuntimeSkillChecksum,
  RuntimeSkillResolution
} from "./types"

export interface RuntimeSkillRegistryVersion {
  version: string
  sourceUrl: string
  checksum: RuntimeSkillChecksum
  skills: string[]
}

export interface RuntimeSkillRegistryBundle {
  id: string
  versions: RuntimeSkillRegistryVersion[]
}

export interface RuntimeSkillRegistry {
  schemaVersion: "runtime-skills/v1"
  bundles: RuntimeSkillRegistryBundle[]
}

export interface RuntimeSkillLockedBundle {
  id: string
  version: string
  sourceUrl: string
  checksum: RuntimeSkillChecksum
}

export interface RuntimeSkillLockfile {
  schemaVersion: "runtime-skills-lock/v1"
  lockedBundles: RuntimeSkillLockedBundle[]
}

export function resolveRuntimeSkillBundles(input: {
  requestedBundleIds: string[]
  registry: RuntimeSkillRegistry
  lockfile: RuntimeSkillLockfile
}): RuntimeSkillResolution {
  const descriptors: RuntimeSkillBundleDescriptor[] = []

  for (const requestedBundleId of input.requestedBundleIds) {
    const lockedBundle = input.lockfile.lockedBundles.find(
      (bundle) => bundle.id === requestedBundleId
    )

    if (!lockedBundle) {
      return failure(
        "bundle_not_locked",
        `Runtime skill bundle "${requestedBundleId}" is not present in skill.lock.json.`
      )
    }

    const registryBundle = input.registry.bundles.find(
      (bundle) => bundle.id === requestedBundleId
    )
    const registryVersion = registryBundle?.versions.find(
      (version) => version.version === lockedBundle.version
    )

    if (!registryVersion) {
      return failure(
        "bundle_not_in_registry",
        `Runtime skill bundle "${requestedBundleId}" version "${lockedBundle.version}" is not approved in skill-registry.json.`
      )
    }

    if (!matchesRegistryVersion(lockedBundle, registryVersion)) {
      return failure(
        "lockfile_registry_mismatch",
        `Runtime skill bundle "${requestedBundleId}" lockfile entry does not match the curated registry entry.`
      )
    }

    descriptors.push({
      id: lockedBundle.id,
      version: lockedBundle.version,
      sourceUrl: lockedBundle.sourceUrl,
      checksum: lockedBundle.checksum,
      required: true
    })
  }

  return {
    status: "completed",
    bundles: descriptors
  }
}

function matchesRegistryVersion(
  lockedBundle: RuntimeSkillLockedBundle,
  registryVersion: RuntimeSkillRegistryVersion
) {
  return (
    lockedBundle.sourceUrl === registryVersion.sourceUrl &&
    lockedBundle.checksum.algorithm === registryVersion.checksum.algorithm &&
    lockedBundle.checksum.value === registryVersion.checksum.value
  )
}

function failure(
  errorCode:
    | "bundle_not_in_registry"
    | "bundle_not_locked"
    | "lockfile_registry_mismatch",
  errorMessage: string
): RuntimeSkillResolution {
  return {
    status: "failed",
    errorCode,
    errorMessage
  }
}
