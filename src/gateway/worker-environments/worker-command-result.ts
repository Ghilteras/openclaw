import type { SpawnResult } from "../../process/exec-result.js";

export function workerCommandSucceeded(result: SpawnResult): boolean {
  return result.termination === "exit" && result.code === 0;
}
