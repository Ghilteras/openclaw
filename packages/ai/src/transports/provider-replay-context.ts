import type { ProviderReplayState } from "@openclaw/llm-core";
import { shortHash } from "../utils/hash.js";

type ProviderReplayContext = Readonly<
  Pick<
    ProviderReplayState,
    "provider" | "api" | "model" | "baseUrlHash" | "sessionHash" | "authProfileHash"
  >
>;

export function hashReplayContextValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? shortHash(normalized) : undefined;
}

export function providerReplayContextMatches(
  state: ProviderReplayContext,
  context: ProviderReplayContext,
): boolean {
  // Replay state must stay fenced to its exact provider, model, endpoint, session, and auth identity.
  return (
    state.provider === context.provider &&
    state.api === context.api &&
    state.model === context.model &&
    state.baseUrlHash === context.baseUrlHash &&
    state.sessionHash === context.sessionHash &&
    state.authProfileHash === context.authProfileHash
  );
}
