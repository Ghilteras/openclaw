import { describe, expect, it } from "vitest";
import { makeCronJob } from "../delivery.test-helpers.js";
import type { CronStoredJob } from "../types.js";
import { reconcileScheduledJobOwnerPolicy } from "./jobs-tool-policy.js";

const owner = { agentId: "main", sessionKey: "agent:main:chat:group:team", accountId: "work" };
const policy = {
  version: 1 as const,
  mode: "account" as const,
  ownerSessionKey: owner.sessionKey,
  ownerAccountId: owner.accountId,
  ownerOrigin: { kind: "external" as const, channel: "chat" },
};
function toolJob(): CronStoredJob {
  return {
    ...makeCronJob({ payload: { kind: "agentTurn", message: "Read project notes" } }),
    owner,
  };
}

describe("scheduled job owner policy", () => {
  it("retains the authenticated account and origin without a per-job cap", () => {
    const job = toolJob();
    reconcileScheduledJobOwnerPolicy({
      job,
      previouslyUsedToolRuntime: false,
      scheduledToolPolicy: policy,
    });
    expect(job.scheduledToolPolicy).toEqual(policy);
    expect(job.payload.toolsAllow).toBeUndefined();
    expect(job.runtimeAuthority).toBeUndefined();
  });

  it("cannot stamp another account's policy onto a job", () => {
    const job = toolJob();
    expect(() =>
      reconcileScheduledJobOwnerPolicy({
        job,
        previouslyUsedToolRuntime: false,
        scheduledToolPolicy: { ...policy, ownerAccountId: "other" },
      }),
    ).toThrow("scheduled account policy must match the persisted job owner");
  });

  it("does not replace an existing owner with the operator editing the schedule", () => {
    const job = { ...toolJob(), scheduledToolPolicy: policy };
    reconcileScheduledJobOwnerPolicy({
      job,
      previouslyUsedToolRuntime: true,
      scheduledToolPolicy: { version: 1, mode: "trusted" },
    });
    expect(job.scheduledToolPolicy).toEqual(policy);
  });

  it("drops scheduled tool context when the payload becomes transport-only", () => {
    const job: CronStoredJob = {
      ...toolJob(),
      scheduledToolPolicy: policy,
      payload: { kind: "systemEvent", text: "wake" },
    };
    reconcileScheduledJobOwnerPolicy({ job, previouslyUsedToolRuntime: true });
    expect(job.scheduledToolPolicy).toBeUndefined();
  });
});
