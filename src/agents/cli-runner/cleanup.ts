import { runOwnedAgentCleanup } from "../run-cleanup-timeout.js";
import { cliBackendLog } from "./log.js";
import type { RunCliAgentParams } from "./types.js";

/** Join the CLI owner's cleanup without changing its error or delivery policy. */
export async function runCliCleanup(
  params: Pick<RunCliAgentParams, "runId" | "sessionId" | "oneShotCliRun">,
  step: string,
  cleanup: () => Promise<void>,
): Promise<void> {
  await runOwnedAgentCleanup({ ...params, step, cleanup, log: cliBackendLog });
}
