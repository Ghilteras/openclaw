import { describe, expect, it, vi } from "vitest";
import { makeCronJob } from "../delivery.test-helpers.js";
import { createNoopLogger } from "../service.test-harness.js";
import type { CronStoredJob } from "../types.js";
import { createCronServiceState } from "./state.js";
import { executeJobCore } from "./timer-execution.js";

function damagedPinnedJob(kind: "trigger" | "script" | "agentTurn"): CronStoredJob {
  const payload: CronStoredJob["payload"] =
    kind === "script"
      ? { kind: "script", script: "return {}", toolsAllow: ["exec"] }
      : { kind: "agentTurn", message: "run", toolsAllow: ["exec"] };
  return {
    ...makeCronJob({
      payload,
      ...(kind === "trigger" ? { trigger: { script: "return { fire: true }" } } : {}),
    }),
    toolsAllowExecTargetRequirement: {
      version: 1,
      target: { version: 1, host: "gateway", ask: "always" },
      grantIndex: 0,
    },
  };
}

describe("scheduled jobs inherit current execution policy", () => {
  it.each(["trigger", "script", "agentTurn"] as const)(
    "runs an existing %s job without replaying its obsolete exec pin",
    async (kind) => {
      const evaluateCronTrigger = vi.fn(async () => ({ kind: "evaluated" as const, fire: true }));
      const runScriptJob = vi.fn(async () => ({ status: "ok" as const }));
      const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
      const state = createCronServiceState({
        storePath: `/tmp/cron-exec-target-recovery-${kind}.json`,
        cronEnabled: true,
        log: createNoopLogger(),
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        evaluateCronTrigger,
        runScriptJob,
        runIsolatedAgentJob,
      });

      const result = await executeJobCore(state, damagedPinnedJob(kind));

      expect(result).toMatchObject({ status: "ok" });
      expect(evaluateCronTrigger).toHaveBeenCalledTimes(kind === "trigger" ? 1 : 0);
      expect(runScriptJob).toHaveBeenCalledTimes(kind === "script" ? 1 : 0);
      expect(runIsolatedAgentJob).toHaveBeenCalledTimes(kind === "script" ? 0 : 1);
    },
  );

  it("keeps legacy unmarked exec grants on baseline policy", async () => {
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
    const state = createCronServiceState({
      storePath: "/tmp/cron-exec-target-legacy.json",
      cronEnabled: true,
      log: createNoopLogger(),
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
    });
    const job = makeCronJob({
      payload: { kind: "agentTurn", message: "run", toolsAllow: ["exec"] },
    });

    await expect(executeJobCore(state, job)).resolves.toMatchObject({ status: "ok" });
    expect(runIsolatedAgentJob).toHaveBeenCalledOnce();
  });
});
