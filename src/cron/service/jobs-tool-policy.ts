import {
  createTrustedCronScheduledToolPolicy,
  resolveCronScheduledToolPolicy,
  type CronScheduledToolPolicy,
  type CronScheduledToolCallerOrigin,
} from "../scheduled-tool-policy.js";
import { cronJobUsesToolRuntime } from "../tools-allow.js";
import type { CronStoredJob } from "../types.js";

/** Preserve the authenticated owner, not the creator turn's old tool inventory. */
export function reconcileScheduledJobOwnerPolicy(params: {
  job: CronStoredJob;
  previouslyUsedToolRuntime: boolean;
  scheduledToolPolicy?: CronScheduledToolPolicy;
  scheduledToolCallerOrigin?: CronScheduledToolCallerOrigin;
}): void {
  const { job } = params;
  if (!cronJobUsesToolRuntime(job)) {
    delete job.scheduledToolPolicy;
    return;
  }
  const storedPolicy = resolveCronScheduledToolPolicy({
    scheduledToolPolicy: job.scheduledToolPolicy,
    owner: job.owner,
  });
  const policy =
    storedPolicy ??
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
  const callerPolicy = params.scheduledToolPolicy;
  const sameOwner =
    policy.mode === "account" &&
    callerPolicy?.mode === "account" &&
    policy.ownerAccountId === callerPolicy.ownerAccountId &&
    policy.ownerSessionKey === callerPolicy.ownerSessionKey;
  if (
    policy.mode === "account" &&
    params.scheduledToolCallerOrigin &&
    (!storedPolicy || sameOwner) &&
    !job.toolsAllowProvenance?.callerOrigin
  ) {
    // Keep the existing v1 policy closed for older readers. This legacy envelope
    // now carries only authenticated origin, never a captured tool permission.
    job.toolsAllowProvenance = {
      version: 1,
      source: "final-executable-surface",
      callerOrigin: structuredClone(params.scheduledToolCallerOrigin),
    };
  }
}
