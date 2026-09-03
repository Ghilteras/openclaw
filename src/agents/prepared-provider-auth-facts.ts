import { normalizeAgentId } from "../routing/session-key.js";
import type { PreparedProviderAuth } from "./agent-auth-credential-modes.js";

// Published owners record their secret-free provider-auth facts here so runtime-policy
// decisions on request paths read the prepared generation instead of re-probing provider
// plugins or resolving agent directories. Keyed by agent id: a directory lookup would put
// a realpath on every harness-policy read.
const factsByAgentId = new Map<string, PreparedProviderAuth>();

export function publishPreparedProviderAuthFacts(agentId: string, facts: PreparedProviderAuth) {
  factsByAgentId.set(normalizeAgentId(agentId), facts);
}

/** Retires only the generation that is still current; a replacement owner already replaced it. */
export function retirePreparedProviderAuthFacts(agentId: string, facts: PreparedProviderAuth) {
  const key = normalizeAgentId(agentId);
  if (factsByAgentId.get(key) === facts) {
    factsByAgentId.delete(key);
  }
}

export function readPreparedProviderAuthFacts(agentId: string): PreparedProviderAuth | undefined {
  return factsByAgentId.get(normalizeAgentId(agentId));
}

export function resetPreparedProviderAuthFactsForTest(): void {
  factsByAgentId.clear();
}
