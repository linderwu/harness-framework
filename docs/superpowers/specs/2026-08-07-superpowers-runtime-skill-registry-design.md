# Superpowers Runtime Skill Registry Design

## Purpose

Integrate Superpowers into Jormungand as a curated runtime skill bundle that remote agents can download, verify, install, and use during harness workflow execution.

This design keeps two concepts separate:

- `WorkflowEventSkill` remains the harness workflow contract for a bounded event such as planning, design, implementation, review, verification, or closeout.
- A runtime skill bundle is an external package of agent capabilities, such as the full Superpowers skill set, that an agent may use while executing a workflow event.

The first version targets the actual deployment topology: the Jormungand server runs in a Zeabur container, while agents run on separate machines or in separate containers. Server-local mount paths are not usable by remote agents, so the server resolves approved bundles and agents install them locally.

## Approved Direction

Use **Harness-resolved, agent-local install**.

Jormungand owns governance and resolution:

- Maintain a curated registry of approved runtime skill bundles.
- Pin the exact allowed bundle version and checksum in a strict lockfile.
- Resolve each workflow event's declared bundle requirements before dispatch.
- Send agents a bundle descriptor, not a server-local filesystem path.
- Record the agent's runtime skill attestation in the workflow run audit trail.

Agent runtimes own local installation:

- Download the harness-specified bundle from a private same-org GitHub Release.
- Use local credentials, such as `GITHUB_TOKEN` or an agent-specific download token.
- Verify the bundle checksum from the descriptor.
- Extract and install the bundle into the agent's own cache/runtime directory.
- Execute the workflow event with the installed bundle available.
- Report the actual bundle version, checksum, cache status, and verification result.

## MVP Scope

The first version includes:

- Curated registry committed to the repo.
- Same-org private GitHub Release artifact for the full Superpowers bundle.
- One full bundle named `superpowers-full`.
- Skill catalog over the full bundle for visibility.
- Minimal registry schema: bundle id, version, source URL, checksum, and skill list.
- Strict lockfile that controls the only executable bundle version.
- Workflow event declarations by bundle id only.
- Bridge protocol version gate: `harness-agent-bridge/v0.3`.
- Agent-local download, cache, checksum verification, extraction, and install.
- Hard failure for required bundle installation or verification failures.
- Operational diagnostic attestation written into the workflow run event log.

The first version does not include:

- Signature fields or signature verification.
- Runtime compatibility fields.
- License, provenance, dependency graph, channels, or deprecation metadata.
- Harness-proxied artifact downloads.
- Server-managed shared mount paths.
- Automatic update to the latest compatible bundle.

## Registry And Lockfile

`skill-registry.json` describes curated bundle versions that maintainers have approved for use. The sample URL and checksum below are example values; implementation must use the actual release URL and sha256 for the published bundle.

```json
{
  "schemaVersion": "runtime-skills/v1",
  "bundles": [
    {
      "id": "superpowers-full",
      "versions": [
        {
          "version": "1.0.0",
          "sourceUrl": "https://github.com/linderwu/harness-framework/releases/download/skills-v1.0.0/superpowers-full-1.0.0.tgz",
          "checksum": {
            "algorithm": "sha256",
            "value": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
          },
          "skills": [
            "brainstorming",
            "tdd",
            "verification-before-completion"
          ]
        }
      ]
    }
  ]
}
```

`skill.lock.json` is the execution authority. Runtime resolution must use the locked version and checksum, not the newest registry entry.

```json
{
  "schemaVersion": "runtime-skills-lock/v1",
  "lockedBundles": [
    {
      "id": "superpowers-full",
      "version": "1.0.0",
      "sourceUrl": "https://github.com/linderwu/harness-framework/releases/download/skills-v1.0.0/superpowers-full-1.0.0.tgz",
      "checksum": {
        "algorithm": "sha256",
        "value": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
      }
    }
  ]
}
```

The lockfile entry must match an approved registry version by id, version, source URL, checksum algorithm, and checksum value. A mismatch is a server-side resolution failure.

## Workflow Event Contract

`WorkflowEventSkill` gains an optional bundle-only declaration:

```ts
runtimeSkillBundles?: string[]
```

For MVP, these agent-executed development events declare `superpowers-full`:

- `plan.interview`
- `plan.review`
- `design.openspec`
- `implementation.dispatch`
- `implementation.code_review`
- `verification.implementation_review`
- `verification.generate`
- `closeout.archive`

These events do not declare runtime bundles in the first version:

- `intake.requirement`
- `plan.approval`
- `design.approval`
- `verification.approval`

Intake remains focused on requirement and repository setup. Approval gates remain explicit review decisions and should not inherit runtime skill behavior by default.

## Bridge Protocol

Runtime skill bundles require `harness-agent-bridge/v0.3`.

`harness-agent-bridge/v0.2` remains the existing protocol and does not support runtime skill bundles. If a workflow event requires a runtime bundle and the executor only supports v0.2, Jormungand fails before dispatch with `runtime_skill_protocol_unsupported`.

The v0.3 payload includes resolved bundle descriptors:

```json
{
  "protocolVersion": "harness-agent-bridge/v0.3",
  "runtimeSkillBundles": [
    {
      "id": "superpowers-full",
      "version": "1.0.0",
      "sourceUrl": "https://github.com/linderwu/harness-framework/releases/download/skills-v1.0.0/superpowers-full-1.0.0.tgz",
      "checksum": {
        "algorithm": "sha256",
        "value": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
      },
      "required": true
    }
  ]
}
```

The descriptor contains no secret. Agents infer download credentials from their own runtime configuration, such as a local GitHub token.

## Agent Attestation

Agents return operational diagnostic attestation for each required bundle:

```json
{
  "runtimeSkillBundleResults": [
    {
      "id": "superpowers-full",
      "version": "1.0.0",
      "checksum": {
        "algorithm": "sha256",
        "value": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
      },
      "downloadSource": "github-release",
      "cacheStatus": "hit",
      "verified": true,
      "installedPath": "/agent/.harness/runtime-skills/superpowers-full/1.0.0"
    }
  ]
}
```

On failure, the agent reports `verified: false`, an error code, and a short error message:

```json
{
  "runtimeSkillBundleResults": [
    {
      "id": "superpowers-full",
      "version": "1.0.0",
      "checksum": {
        "algorithm": "sha256",
        "value": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
      },
      "downloadSource": "github-release",
      "cacheStatus": "miss",
      "verified": false,
      "errorCode": "checksum_mismatch",
      "errorMessage": "Downloaded bundle sha256 did not match descriptor."
    }
  ]
}
```

`installedPath` is an agent-local diagnostic value only. Jormungand must not treat it as a reusable server path.

## Runtime Flow

1. A workflow event advances toward agent dispatch.
2. Jormungand checks whether the event declares runtime skill bundles.
3. If bundles are required, Jormungand verifies that the selected executor supports `harness-agent-bridge/v0.3`.
4. Jormungand reads `skill-registry.json`.
5. Jormungand reads `skill.lock.json`.
6. Jormungand resolves each declared bundle from the lockfile.
7. Jormungand verifies each locked bundle exists in the curated registry with matching source URL and checksum.
8. Jormungand sends the resolved descriptors in the bridge payload.
9. The agent downloads the private GitHub Release artifact using local credentials.
10. The agent verifies the sha256 checksum.
11. The agent extracts and installs the bundle into its own cache/runtime directory.
12. The agent executes the workflow event with the installed Superpowers bundle available.
13. The agent returns runtime skill attestation with the event result.
14. Jormungand records the resolution and attestation in the workflow run audit trail.

## Cache Policy

Agents maintain their own cache because remote agents do not share a filesystem with the Zeabur-hosted server.

Recommended agent paths:

```text
/agent/.harness/cache/skills/superpowers-full/1.0.0/superpowers-full-1.0.0.tgz
/agent/.harness/runtime-skills/superpowers-full/1.0.0/
```

Jormungand may also have a server-local cache in the future, but that cache is not part of the MVP delivery mechanism and must not be exposed as an agent mount path.

## Failure Policy

Runtime skill bundles are required for declared events. The agent must not fall back to no-skill execution when a required bundle cannot be installed or verified.

Server-side resolution errors:

- `resolution_failed`
- `registry_not_found`
- `lockfile_not_found`
- `bundle_not_in_registry`
- `bundle_not_locked`
- `lockfile_registry_mismatch`
- `runtime_skill_protocol_unsupported`

Agent-side installation errors:

- `installation_failed`
- `download_unauthorized`
- `download_failed`
- `checksum_mismatch`
- `extract_failed`
- `incomplete_attestation`

If a required bundle does not produce verified attestation, the workflow event is failed or marked incomplete.

## Audit Policy

Jormungand records both sides of the runtime skill decision:

- The server-side resolution descriptor that was authorized for the event.
- The agent-side attestation describing what was actually downloaded, verified, cached, and installed.

For MVP, this audit data can be stored in the existing workflow event note or agent run status message as structured JSON. A future UI can promote it into dedicated fields if querying and filtering become important.

## Security Model

MVP trust relies on:

- Curated registry review in the repository.
- Strict lockfile pinning.
- Private same-org GitHub Release artifacts.
- Agent-local download credentials.
- sha256 checksum verification.
- Per-run attestation.

Jormungand must never send GitHub tokens or download secrets inside the bridge payload. The descriptor includes only source URL, version, checksum, and required status.

## Testing

Focused tests should cover:

- Registry and lockfile resolution succeeds for a matching locked bundle.
- Missing registry fails with `registry_not_found`.
- Missing lockfile fails with `lockfile_not_found`.
- Declared bundle missing from lockfile fails with `bundle_not_locked`.
- Lockfile and registry mismatch fails with `lockfile_registry_mismatch`.
- Events without runtime bundles preserve the existing v0.2 bridge behavior.
- Events with runtime bundles require v0.3 support.
- Agent verified attestation is recorded in the workflow run audit trail.
- Agent checksum mismatch or missing attestation fails the workflow event.

Standard verification remains:

- `npm run typecheck`
- `npm run lint`
- `npm run test`
- `npm run build`

## Open Decisions

No blocking open decisions remain for MVP implementation.

Future versions may add signatures, runtime compatibility metadata, dependency graphs, harness-proxied downloads, richer UI inspection, or per-skill bundle granularity.
