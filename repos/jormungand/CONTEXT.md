# Jormungand Agent Conversation Context

This context defines the product language used when Jormungand routes persistent conversations to agent runtimes. It distinguishes the application-facing ingress from the runtime that actually executes an agent.

## Language

**Conversation**:
A durable interaction identity with lifecycle metadata. In Phase 1, the refactor applies to unbound conversations; project/workflow-bound conversations keep their current behavior.
_Avoid_: Thread, Job

**Turn**:
One logical operator request and its agent response lifecycle. Its core status is `queued`, `running`, `completed`, `interrupted`, `canceled`, or `failed`.
_Avoid_: Runtime session, Execution Job

**Conversation Entry**:
A persisted user, agent, manager, or system record that participates in a Conversation. A user Entry and its response placeholder may belong to the same Turn.
_Avoid_: Execution Job

**Execution Job**:
The internal durable queue record that leases and dispatches work for a Turn. Its queue and lease state is not the Conversation or Turn state.
_Avoid_: Turn, Agent

**Conversation Lifecycle Module**:
The single writer for in-scope Conversation, Turn, Conversation Entry, and conversation Execution Job state. Routes, dispatch drivers, sync workers, and Runtime adapters submit commands or normalized outcomes to it.
_Avoid_: Provider, Runtime

**Provider Outcome**:
A normalized execution result returned by a Runtime boundary for the Conversation Lifecycle Module to validate and persist.
_Avoid_: Direct persistence update

**Provider Telemetry**:
Runtime availability and mapping information such as online, offline, or replacement pending. It is orthogonal to Turn state and cannot directly mutate core lifecycle state.
_Avoid_: Turn status

**Agent Profile**:
A Jormungand-visible agent identity that selects one Agent Family and its routing metadata.
_Avoid_: Worker type, provider name

**Agent Family**:
The Jormungand routing category assigned to an Agent Profile: `codex`, `openclaw`, or `minimax`.
_Avoid_: Runtime implementation

**Codex Device Ingress**:
The application-facing bridge entry used by Codex and Mavis requests on the Codex device. It executes Codex requests and forwards Mavis requests to the Lucky Runtime.
_Avoid_: Codex Runtime, Codex worker

**Lucky Runtime**:
The independent runtime behind the Mavis/Lucky Agent Profile. It receives forwarded requests from the Codex Device Ingress and does not participate in Codex native thread synchronization.
_Avoid_: Codex worker, Codex Runtime

**OpenClaw Agent**:
An Agent Profile executed through the OpenClaw runtime using its configured `mainAgent` identity.
_Avoid_: Codex worker
