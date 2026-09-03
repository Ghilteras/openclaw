/**
 * Resolves configured native harness policy for agent ids.
 */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ProviderRouteOverridePresence } from "../../plugin-sdk/provider-model-types.js";
import {
  AUTO_AGENT_RUNTIME_ID,
  type EmbeddedAgentRuntime,
  normalizeOptionalAgentRuntimeId,
} from "../agent-runtime-id.js";
import { resolveNativeLoginCliRuntime } from "../model-runtime-aliases.js";
import { resolveModelRuntimePolicy } from "../model-runtime-policy.js";
import { resolveOpenAIImplicitAgentRuntime } from "../openai-routing.js";

/** Who chose the runtime: operator config, an implicit default, or the credentials in use. */
export type AgentHarnessRuntimeSource = "model" | "provider" | "implicit" | "auth";

export type AgentHarnessPolicy = {
  runtime: EmbeddedAgentRuntime;
  runtimeSource?: AgentHarnessRuntimeSource;
  forcedByEnvironment?: true;
};

type AgentHarnessPolicyParams = {
  provider?: string;
  modelId?: string;
  modelApi?: string | null;
  modelBaseUrl?: unknown;
  requestTransportOverrides?: ProviderRouteOverridePresence;
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  env?: NodeJS.ProcessEnv;
};

/** Resolves model/provider/runtime config into the canonical harness runtime id. */
export function resolveAgentHarnessPolicy(params: AgentHarnessPolicyParams): AgentHarnessPolicy {
  const configured = resolveConfiguredHarnessPolicy(params);
  if (configured.runtime !== AUTO_AGENT_RUNTIME_ID) {
    return configured;
  }
  // A native login chose this runtime, not the provider's default route. The prepared
  // generation already recorded that fact; reading it here costs no store or directory lookup.
  const cliRuntime = resolveNativeLoginCliRuntime({
    provider: params.provider ?? "",
    agentId: params.agentId,
  });
  if (cliRuntime) {
    return { runtime: cliRuntime, runtimeSource: "auth" };
  }
  return resolveImplicitHarnessPolicy(params, configured);
}

/**
 * Config and implicit defaults only. Fleet-wide scans resolve every roster model; reading
 * credential state per model would re-project the roster O(agents x models) times (#135743).
 */
export function resolveConfiguredAgentHarnessPolicy(
  params: AgentHarnessPolicyParams,
): AgentHarnessPolicy {
  const configured = resolveConfiguredHarnessPolicy(params);
  return configured.runtime !== AUTO_AGENT_RUNTIME_ID
    ? configured
    : resolveImplicitHarnessPolicy(params, configured);
}

function resolveConfiguredHarnessPolicy(params: AgentHarnessPolicyParams): AgentHarnessPolicy {
  const configured = resolveModelRuntimePolicy({
    config: params.config,
    provider: params.provider,
    modelId: params.modelId,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
  const configuredRuntime = normalizeOptionalAgentRuntimeId(configured.policy?.id);
  const runtime =
    configuredRuntime && configuredRuntime !== "default"
      ? configuredRuntime
      : AUTO_AGENT_RUNTIME_ID;
  return {
    runtime,
    runtimeSource:
      runtime === AUTO_AGENT_RUNTIME_ID ? "implicit" : (configured.source ?? "implicit"),
    ...(runtime !== AUTO_AGENT_RUNTIME_ID && configured.forcedByEnvironment
      ? { forcedByEnvironment: true }
      : {}),
  };
}

function resolveImplicitHarnessPolicy(
  params: AgentHarnessPolicyParams,
  fallback: AgentHarnessPolicy,
): AgentHarnessPolicy {
  const openAIImplicitRuntime = resolveOpenAIImplicitAgentRuntime({
    provider: params.provider,
    modelId: params.modelId,
    api: params.modelApi,
    baseUrl: params.modelBaseUrl,
    config: params.config,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    env: params.env,
    requestTransportOverrides: params.requestTransportOverrides,
  });
  return openAIImplicitRuntime
    ? { runtime: openAIImplicitRuntime, runtimeSource: fallback.runtimeSource }
    : fallback;
}
