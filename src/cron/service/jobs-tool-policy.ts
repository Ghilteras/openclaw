import {
  createTrustedCronScheduledToolPolicy,
  resolveCronScheduledToolPolicy,
  type CronScheduledToolPolicy,
} from "../scheduled-tool-policy.js";
import { cronJobUsesToolRuntime } from "../tools-allow.js";
import type { CronStoredJob } from "../types.js";

/** Preserve the authenticated owner, not the creator turn's old tool inventory. */
export function reconcileScheduledJobOwnerPolicy(params: {
  job: CronStoredJob;
  previouslyUsedToolRuntime: boolean;
  scheduledToolPolicy?: CronScheduledToolPolicy;
}): void {
  const { job } = params;
  if (!cronJobUsesToolRuntime(job)) {
    delete job.scheduledToolPolicy;
    return;
  }
  const policy =
    resolveCronScheduledToolPolicy({
      scheduledToolPolicy: job.scheduledToolPolicy,
      owner: job.owner,
    }) ??
    params.scheduledToolPolicy ??
    (!params.previouslyUsedToolRuntime ? createTrustedCronScheduledToolPolicy() : undefined);
  if (!policy) {
    delete job.scheduledToolPolicy;
    return;
  }
  if (
    policy.mode === "account" &&
    (job.owner?.sessionKey !== policy.ownerSessionKey ||
      job.owner?.accountId !== policy.ownerAccountId)
  ) {
    throw new Error("scheduled account policy must match the persisted job owner");
  }
  job.scheduledToolPolicy = structuredClone(policy);
}
