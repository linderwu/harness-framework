const CAPABILITY_NAMES = [
  'sessionResume',
  'models',
  'reasoning',
  'events',
  'eventReplay',
  'interrupt',
  'settledSignal',
  'attachments',
  'quota',
  'inputBudget'
]

export function capabilityFlags(observed = {}) {
  return Object.fromEntries(CAPABILITY_NAMES.map(name => [name, observed[name] === true]))
}

export function buildCapabilities({ hostId, agents = [], observedAt = new Date().toISOString() }) {
  return {
    schemaVersion: 'dsh-agent-bridge/v1',
    hostId,
    agents: agents.map(agent => ({
      agentId: agent.agentId,
      capabilities: capabilityFlags(agent.capabilities),
    })),
    limits: {
      maxRequestBytes: 1024 * 1024,
      maxEventPageBytes: 256 * 1024,
      maxEventPageItems: 200,
    },
    observedAt,
  }
}

export { CAPABILITY_NAMES }
