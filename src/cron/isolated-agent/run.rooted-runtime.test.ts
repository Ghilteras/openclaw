// Rooted cron runtime tests cover fallback candidates that cannot use the CLI runtime.
import { describe, expect, it } from "vitest";
import {
  runFallbackModelAttempt,
  runInitialModelFallbackAttempt,
  type TestModelFallbackRunnerParams,
} from "../../agents/test-helpers/model-fallback-runner.test-support.js";
import { makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  isCliProviderMock,
  loadRunCronIsolatedAgentTurn,
  resolveEffectiveAgentRuntimeMock,
  runCliAgentMock,
  runEmbeddedAgentMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();
const executionRoot = {
  workspaceDir: "/tmp/workshop-skills",
  cwd: "/tmp/workshop-skills",
  sessionRoot: "/tmp/workshop-skills",
  requireWritableSandbox: true,
};

type FallbackRequest = TestModelFallbackRunnerParams & {
  canFallbackAfterError?: (params: {
    provider: string;
    model: string;
    error: unknown;
    attempt: number;
    total: number;
  }) => boolean | Promise<boolean>;
};

async function runFallbackCandidates(
  params: FallbackRequest,
  candidates: readonly { provider: string; model: string }[],
) {
  for (const [index, candidate] of candidates.entries()) {
    try {
      return await (index === 0
        ? runInitialModelFallbackAttempt(params)
        : runFallbackModelAttempt(params, candidate.provider, candidate.model, "unknown"));
    } catch (error) {
      if (
        !(await params.canFallbackAfterError?.({
          provider: candidate.provider,
          model: candidate.model,
          error,
          attempt: index + 1,
          total: candidates.length,
        }))
      ) {
        throw error;
      }
    }
  }
  throw new Error("Expected a fallback candidate");
}

describe("runCronIsolatedAgentTurn — rooted runtime fallback", () => {
  setupRunCronIsolatedAgentTurnSuite();

  it("rejects all-CLI fallbacks after a rooted embedded candidate fails", async () => {
    resolveEffectiveAgentRuntimeMock.mockImplementation(({ modelId }: { modelId: string }) =>
      modelId === "gpt-5.4" ? "openclaw" : "claude-cli",
    );
    isCliProviderMock.mockImplementation((provider: string) => provider === "claude-cli");
    runEmbeddedAgentMock.mockRejectedValueOnce(new Error("embedded primary failed"));
    runWithModelFallbackMock.mockImplementation(async (params: FallbackRequest) => {
      const result = await runFallbackCandidates(params, [
        { provider: "openai", model: "gpt-5.4" },
        { provider: "claude-cli", model: "claude-opus-4-6" },
      ]);
      return { result, provider: "claude-cli", model: "claude-opus-4-6", attempts: [] };
    });

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({ executionRoot }),
    );

    expect(result).toMatchObject({
      status: "error",
      admissionDisposition: "rejected",
      error:
        "collection review requires the embedded agent runtime; the configured CLI runtime cannot be rooted at the Workshop directory",
    });
    expect(runCliAgentMock).not.toHaveBeenCalled();
  });

  it("skips a rooted CLI fallback and reaches a later embedded candidate", async () => {
    resolveEffectiveAgentRuntimeMock.mockImplementation(({ modelId }: { modelId: string }) =>
      modelId === "gpt-5.4" || modelId === "gpt-5" ? "openclaw" : "claude-cli",
    );
    isCliProviderMock.mockImplementation((provider: string) => provider === "claude-cli");
    runEmbeddedAgentMock.mockImplementation(
      async (params: { model?: string; onExecutionStarted?: () => void }) => {
        params.onExecutionStarted?.();
        if (params.model === "gpt-5.4") {
          throw new Error("embedded primary failed");
        }
        return { payloads: [{ text: "later embedded succeeded" }], meta: { agentMeta: {} } };
      },
    );
    runWithModelFallbackMock.mockImplementation(async (params: FallbackRequest) => {
      const result = await runFallbackCandidates(params, [
        { provider: "openai", model: "gpt-5.4" },
        { provider: "claude-cli", model: "claude-opus-4-6" },
        { provider: "openai", model: "gpt-5" },
      ]);
      return { result, provider: "openai", model: "gpt-5", attempts: [] };
    });

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({ executionRoot }),
    );

    expect(result.status).toBe("ok");
    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(2);
    expect(runCliAgentMock).not.toHaveBeenCalled();
    expect(runEmbeddedAgentMock.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ provider: "openai", model: "gpt-5" }),
    );
  });
});
