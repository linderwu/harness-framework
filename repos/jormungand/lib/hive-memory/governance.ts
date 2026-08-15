import { HiveMemoryRepository, normalizeContent } from "./repository"
import type { MemoryCandidate, PromotionOutcome } from "./types"

type GovernanceAction =
  | { actor: string; action: "activate"; candidateId: string }
  | { actor: string; action: "retract"; memoryId: string; reason?: string }

export class MemoryGovernance {
  constructor(private readonly repository: HiveMemoryRepository) {}

  async apply(action: GovernanceAction) {
    this.requireManager(action.actor)
    if (action.action === "activate") {
      return this.promoteCandidate({ actor: action.actor as "codex" | "control_plane", candidateId: action.candidateId })
    }
    return this.repository.transition({
      memoryId: action.memoryId,
      actor: action.actor as "codex" | "control_plane",
      status: "retracted",
      reason: action.reason?.trim() || "Retracted by memory governance.",
      evidenceRefs: []
    })
  }

  async promoteCandidate(input: { actor: "codex" | "control_plane"; candidateId: string }): Promise<PromotionOutcome> {
    this.requireManager(input.actor)
    const candidate = this.repository.getCandidate(input.candidateId)
    if (!candidate) throw new Error(`Memory candidate ${input.candidateId} not found.`)
    if (candidate.status !== "candidate") {
      return { status: "rejected", candidate, reason: `Candidate is already ${candidate.status}.` }
    }

    const invalidReason = validateCandidateBasics(candidate)
    if (invalidReason) return this.reject(candidate, invalidReason)

    const duplicate = this.repository.findExactActive({
      content: candidate.observation,
      scope: candidate.proposedScope,
      scopeId: candidate.proposedScopeId,
      kind: candidate.proposedKind
    })
    if (duplicate) {
      const memory = await this.repository.mergeEvidence(duplicate.id, {
        actor: input.actor,
        evidenceRefs: candidate.evidenceRefs,
        sourceEventIds: candidate.sourceEventIds,
        confidence: candidate.confidence,
        importance: candidate.importance
      })
      await this.repository.decideCandidate(candidate.id, "merged", `Merged into memory ${memory.id}.`)
      return { status: "merged", memory }
    }

    const scopeReason = validateGlobalPromotion(candidate)
    if (scopeReason) return this.reject(candidate, scopeReason)

    const conflicting = this.repository.findPotentialConflict({
      content: candidate.observation,
      scope: candidate.proposedScope,
      scopeId: candidate.proposedScopeId,
      kind: candidate.proposedKind
    })
    if (conflicting) {
      const verificationTaskId = crypto.randomUUID()
      const proposed = await this.repository.createMemory({
        actor: input.actor,
        scope: candidate.proposedScope,
        scopeId: candidate.proposedScopeId,
        kind: candidate.proposedKind,
        title: titleFromObservation(candidate.observation),
        content: candidate.observation,
        summary: candidate.observation,
        confidence: candidate.confidence,
        importance: candidate.importance,
        sourceAgent: candidate.sourceAgent,
        sourceEventIds: candidate.sourceEventIds,
        evidenceRefs: candidate.evidenceRefs,
        sensitivity: candidate.sensitivity,
        invalidationConditions: candidate.invalidationConditions
      })
      await this.repository.transition({
        memoryId: proposed.id,
        actor: input.actor,
        status: "retracted",
        reason: "Held inactive pending conflict verification.",
        evidenceRefs: []
      })
      const conflict = await this.repository.createConflict({
        leftMemoryId: conflicting.id,
        rightMemoryId: proposed.id,
        verificationTaskId
      })
      await this.repository.decideCandidate(candidate.id, "conflict", `Verification task ${verificationTaskId} created.`)
      return { status: "conflict", conflict, verificationTaskId }
    }

    const memory = await this.repository.createMemory({
      actor: input.actor,
      scope: candidate.proposedScope,
      scopeId: candidate.proposedScopeId,
      kind: candidate.proposedKind,
      title: titleFromObservation(candidate.observation),
      content: candidate.observation,
      summary: candidate.observation,
      confidence: candidate.confidence,
      importance: candidate.importance,
      sourceAgent: candidate.sourceAgent,
      sourceEventIds: candidate.sourceEventIds,
      evidenceRefs: candidate.evidenceRefs,
      sensitivity: candidate.sensitivity,
      invalidationConditions: candidate.invalidationConditions
    })
    await this.repository.decideCandidate(candidate.id, "activated", `Activated as memory ${memory.id}.`)
    return { status: "activated", memory }
  }

  async expireDueMemories(now = new Date()) {
    const due = this.repository.listActiveMemories().filter((memory) =>
      memory.expiresAt && memory.expiresAt <= now.toISOString() &&
      (memory.kind === "handoff" || memory.kind === "episodic")
    )
    return Promise.all(due.map((memory) => this.repository.transition({
      memoryId: memory.id,
      actor: "control_plane",
      status: "expired",
      reason: "Memory reached its configured retrieval expiry.",
      evidenceRefs: []
    })))
  }

  private requireManager(actor: string) {
    if (actor !== "codex" && actor !== "control_plane") {
      throw new Error("Workers cannot mutate formal memory; submit a candidate instead.")
    }
  }

  private async reject(candidate: MemoryCandidate, reason: string): Promise<PromotionOutcome> {
    const rejected = await this.repository.decideCandidate(candidate.id, "rejected", reason)
    return { status: "rejected", candidate: rejected, reason }
  }
}

export function createMemoryGovernance(repository: HiveMemoryRepository) {
  return new MemoryGovernance(repository)
}

function validateCandidateBasics(candidate: MemoryCandidate) {
  if (!candidate.evidenceRefs.length && !candidate.sourceEventIds.length) return "Candidate has no evidence."
  if (containsPlainSecret(candidate.observation) && candidate.sensitivity !== "secret_reference") {
    return "Secrets must be stored as a safe secret reference, never as memory content."
  }
  if (candidate.sensitivity === "secret_reference" && !candidate.observation.trim().startsWith("secret://")) {
    return "Secret reference memory must use a secret:// reference."
  }
  return undefined
}

function validateGlobalPromotion(candidate: MemoryCandidate) {
  if (candidate.proposedScope !== "global") return undefined
  if (candidate.proposedKind === "policy" && candidate.sourceAgent === "control_plane") return undefined

  const projects = new Set(candidate.evidenceRefs.filter((ref) => ref.startsWith("project:")))
  const runs = new Set(candidate.sourceEventIds.filter((ref) => ref.startsWith("run:")))
  if (projects.size < 2 && runs.size < 2) {
    return "Global memory requires corroboration across at least two projects or workflow runs."
  }
  return undefined
}

function containsPlainSecret(value: string) {
  const normalized = normalizeContent(value)
  return /(?:token|password|secret|api[_ -]?key)\s*[:=]\s*[^\s]+/.test(normalized)
}

function titleFromObservation(observation: string) {
  const normalized = observation.trim().replaceAll(/\s+/g, " ")
  return normalized.length <= 80 ? normalized : `${normalized.slice(0, 77)}…`
}
