import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../agents/test-helpers/fast-coding-tools.js";
import {
  runInitialModelFallbackAttempt,
  type TestModelFallbackRunnerParams,
} from "../../agents/test-helpers/model-fallback-runner.test-support.js";
import type { CronStoredJob } from "../types.js";
import {
  loadRunCronIsolatedAgentTurn,
  resetRunCronIsolatedAgentTurnHarness,
  runEmbeddedAgentMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

describe("scheduled work uses the owning agent's current permissions", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    resetRunCronIsolatedAgentTurnHarness();
    runWithModelFallbackMock.mockImplementation(async (params: TestModelFallbackRunnerParams) => {
      const result = await runInitialModelFallbackAttempt(params);
      return { result, provider: params.provider, model: params.model, attempts: [] };
    });
  });

  afterEach(() => vi.unstubAllEnvs());

  it.each([
    { toolsAllow: [] },
    { toolsAllow: ["exec", "message"] },
    { toolsAllow: ["retired_plugin_tool"] },
  ])(
    "does not turn a stored tool snapshot $toolsAllow into a different runtime",
    { timeout: 300_000 },
    async ({ toolsAllow }) => {
      // Existing jobs must recover without an owner recreating them. The retired
      // snapshot stays on the stored record for rollback, but is not executable policy.
      const job = {
        id: "existing-scheduled-work",
        name: "Existing scheduled work",
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        payload: { kind: "agentTurn", message: "Read the project notes", toolsAllow },
        delivery: { mode: "none" },
        owner: { agentId: "main", sessionKey: "agent:main:chat:group:team", accountId: "default" },
        scheduledToolPolicy: {
          version: 1,
          mode: "account",
          ownerSessionKey: "agent:main:chat:group:team",
          ownerAccountId: "default",
        },
        runtimeAuthorityRecoveryRequired: true,
        runtimeAuthority: {
          version: 1,
          runtimeId: "retired-runtime",
          namespace: "retired.apps",
          payload: {},
        },
      } satisfies Partial<CronStoredJob>;
      const before = structuredClone(job);
      await runCronIsolatedAgentTurn({
        cfg: { tools: { deny: ["browser"] } },
        deps: {} as never,
        job: job as CronStoredJob,
        message: job.payload.message,
        sessionKey: `cron:${job.id}`,
      });

      expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
      const call = runEmbeddedAgentMock.mock.calls[0]?.[0];
      expect(call?.toolsAllow).toBeUndefined();
      expect(call?.scheduledRuntimeAuthority).toBeUndefined();
      expect(call?.scheduledRuntimeAuthorityRecoveryRequired).toBeUndefined();
      expect(call?.config?.tools?.deny).toEqual(["browser"]);
      expect(call?.scheduledToolPolicy).toMatchObject({
        mode: "account",
        ownerSessionKey: job.owner.sessionKey,
        ownerAccountId: job.owner.accountId,
      });
      expect(job).toEqual(before);
    },
  );
});
