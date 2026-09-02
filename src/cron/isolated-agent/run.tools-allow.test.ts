// Legacy jobs retain their verified owner context without retaining tool snapshots.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../agents/test-helpers/fast-coding-tools.js";
import {
  runInitialModelFallbackAttempt,
  type TestModelFallbackRunnerParams,
} from "../../agents/test-helpers/model-fallback-runner.test-support.js";
import {
  loadRunCronIsolatedAgentTurn,
  resetRunCronIsolatedAgentTurnHarness,
  resolveDeliveryTargetMock,
  runEmbeddedAgentMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const RUN_TOOLS_ALLOW_TIMEOUT_MS = 300_000;

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

function makeParams() {
  return {
    cfg: {},
    deps: {} as never,
    job: {
      id: "tools-allow",
      name: "Tools Allow",
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "check allowed tools" },
      delivery: { mode: "none" },
      owner: {
        agentId: "main",
        sessionKey: "agent:main:whatsapp:group:team",
        accountId: "default",
      },
    } as never,
    message: "check allowed tools",
    sessionKey: "cron:tools-allow",
  };
}

function makeParamsWithToolsAllow(toolsAllow: string[]) {
  const params = makeParams();
  const job = params.job as Record<string, unknown>;
  return {
    ...params,
    job: {
      ...job,
      scheduledToolPolicy: {
        version: 1,
        mode: "account",
        ownerSessionKey: "agent:main:whatsapp:group:team",
        ownerAccountId: "default",
      },
      toolsAllowProvenance: {
        version: 1,
        source: "final-executable-surface",
        callerOrigin: { kind: "external", channel: "whatsapp" },
      },
      payload: {
        kind: "agentTurn",
        message: "check allowed tools",
        toolsAllow,
      },
    } as never,
  };
}

function makeParamsWithDefaultToolsAllow(toolsAllow: string[]) {
  const params = makeParams();
  const job = params.job as Record<string, unknown>;
  return {
    ...params,
    job: {
      ...job,
      scheduledToolPolicy: {
        version: 1,
        mode: "account",
        ownerSessionKey: "agent:main:whatsapp:group:team",
        ownerAccountId: "default",
      },
      payload: {
        kind: "agentTurn",
        message: "check allowed tools",
        toolsAllow,
        toolsAllowIsDefault: true,
      },
    } as never,
  };
}

function requireEmbeddedAgentCall(): {
  jobId?: string;
  toolsAllow?: string[];
  scheduledToolPolicy?: {
    version: 1;
    mode: "account";
    ownerSessionKey: string;
    ownerAccountId: string;
    ownerOrigin: { kind: "external"; channel: string } | { kind: "local" } | { kind: "unknown" };
  };
} {
  const call = runEmbeddedAgentMock.mock.calls[0]?.[0] as
    | {
        jobId?: string;
        toolsAllow?: string[];
        scheduledToolPolicy?: {
          version: 1;
          mode: "account";
          ownerSessionKey: string;
          ownerAccountId: string;
          ownerOrigin:
            | { kind: "external"; channel: string }
            | { kind: "local" }
            | { kind: "unknown" };
        };
      }
    | undefined;
  if (!call) {
    throw new Error("Expected embedded OpenClaw agent call for toolsAllow passthrough");
  }
  return call;
}

describe("legacy scheduled owner context", () => {
  let previousFastTestEnv: string | undefined;

  beforeEach(() => {
    previousFastTestEnv = process.env.OPENCLAW_TEST_FAST;
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    resetRunCronIsolatedAgentTurnHarness();
    resolveDeliveryTargetMock.mockResolvedValue({
      channel: "forum",
      to: "123",
      accountId: undefined,
      error: undefined,
    });
    runWithModelFallbackMock.mockImplementation(async (params: TestModelFallbackRunnerParams) => {
      const result = await runInitialModelFallbackAttempt(params);
      return { result, provider: params.provider, model: params.model, attempts: [] };
    });
  });

  afterEach(() => {
    if (previousFastTestEnv == null) {
      vi.unstubAllEnvs();
      delete process.env.OPENCLAW_TEST_FAST;
      return;
    }
    vi.stubEnv("OPENCLAW_TEST_FAST", previousFastTestEnv);
  });

  it(
    "keeps capless legacy runs on the ordinary policy path",
    { timeout: RUN_TOOLS_ALLOW_TIMEOUT_MS },
    async () => {
      await runCronIsolatedAgentTurn(makeParams());

      const call = requireEmbeddedAgentCall();
      expect(call.toolsAllow).toBeUndefined();
      expect(call.scheduledToolPolicy).toBeUndefined();
    },
  );

  it(
    "keeps capped accountless legacy jobs on the ordinary sender-policy path",
    { timeout: RUN_TOOLS_ALLOW_TIMEOUT_MS },
    async () => {
      const params = makeParamsWithToolsAllow(["cron"]);
      delete (params.job as { owner?: { accountId?: string } }).owner?.accountId;

      await runCronIsolatedAgentTurn(params);

      const call = requireEmbeddedAgentCall();
      expect(call.toolsAllow).toBeUndefined();
      expect(call.scheduledToolPolicy).toBeUndefined();
    },
  );

  it(
    "retains the exact self-management job scope without a tool snapshot",
    { timeout: RUN_TOOLS_ALLOW_TIMEOUT_MS },
    async () => {
      await runCronIsolatedAgentTurn(makeParamsWithToolsAllow(["cron"]));

      expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
      const call = requireEmbeddedAgentCall();
      expect(call.jobId).toBe("tools-allow");
      expect(call.toolsAllow).toBeUndefined();
      expect(call.scheduledToolPolicy).toEqual({
        version: 1,
        mode: "account",
        ownerSessionKey: "agent:main:whatsapp:group:team",
        ownerAccountId: "default",
        ownerOrigin: { kind: "external", channel: "whatsapp" },
      });
    },
  );

  it(
    "preserves explicit local scheduled-tool provenance",
    { timeout: RUN_TOOLS_ALLOW_TIMEOUT_MS },
    async () => {
      const params = makeParamsWithDefaultToolsAllow(["transcripts"]);
      (params.job as { toolsAllowProvenance?: unknown }).toolsAllowProvenance = {
        version: 1,
        source: "final-executable-surface",
        callerOrigin: { kind: "local" },
      };

      await runCronIsolatedAgentTurn(params);

      expect(requireEmbeddedAgentCall().scheduledToolPolicy).toEqual({
        version: 1,
        mode: "account",
        ownerSessionKey: "agent:main:whatsapp:group:team",
        ownerAccountId: "default",
        ownerOrigin: { kind: "local" },
      });
    },
  );
});
