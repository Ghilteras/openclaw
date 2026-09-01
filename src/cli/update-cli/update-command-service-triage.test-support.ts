import { expect, it, vi } from "vitest";
import * as ancestry from "../../infra/restart-stale-pids.js";
import * as handoffLease from "../../infra/update-managed-service-handoff-lease.js";
import * as processIdentity from "../../shared/pid-alive.js";
import { captureEnv } from "../../test-utils/env.js";
import { maybeStopManagedServiceBeforeMutableUpdate } from "./update-command-service-maintenance.js";

export function registerTriageMaintenancePolicyTests(
  getFixture: () => { root: string; events: string[] },
) {
  it.each([
    "live triage",
    "updater",
    "copied env",
    "stale executor",
    "stale helper",
    "cancelled",
    "foreign unit",
    "unadmitted",
    "late triage",
  ] as const)("keeps maintenance self-stop policy for %s", async (scenario) => {
    const { root, events } = getFixture();
    const lease: handoffLease.ManagedHandoffLease = {
      owner: "fixture-handoff",
      key: root,
      payload: "fixture",
      updatedAt: 1,
      version: 2,
      executor: { pid: 42420, startIdentity: "10" },
      helper: { pid: 42421, startIdentity: "20" },
      action:
        scenario === "updater"
          ? { kind: "update" }
          : {
              kind: "triage",
              phase: scenario === "cancelled" ? "closing" : "running",
              lifetime: {
                kind: "native",
                unit: scenario === "foreign unit" ? "other.service" : "openclaw-gateway.service",
                scope: "fixture.scope",
                placement:
                  scenario === "unadmitted"
                    ? { kind: "pending" }
                    : { kind: "attached", invocation: "a".repeat(32) },
              },
            },
    };
    const read = vi
      .spyOn(handoffLease, "readManagedServiceUpdateHandoffLease")
      .mockReturnValue(lease);
    vi.spyOn(ancestry, "getSelfAndAncestorPidsSync").mockReturnValue(
      new Set(
        scenario === "copied env"
          ? [process.pid]
          : [process.pid, lease.executor.pid, lease.helper.pid],
      ),
    );
    vi.spyOn(processIdentity, "isPidAlive").mockReturnValue(true);
    vi.spyOn(handoffLease, "readManagedHandoffProcessStartTime").mockImplementation((pid) =>
      pid === lease.executor.pid
        ? scenario === "stale executor"
          ? 11
          : 10
        : scenario === "stale helper"
          ? 21
          : 20,
    );
    const inheritedHandoff = captureEnv(["OPENCLAW_UPDATE_RUN_HANDOFF"]);
    process.env.OPENCLAW_UPDATE_RUN_HANDOFF = "1";
    if (scenario === "late triage") {
      read.mockReturnValueOnce(null);
    }
    try {
      const result = maybeStopManagedServiceBeforeMutableUpdate({
        root,
        updateInstallKind: "package",
        shouldRestart: true,
        jsonMode: true,
      });
      if (scenario === "late triage") {
        await expect(result).rejects.toThrow("inside its automatic triage process tree");
      } else if (scenario === "live triage") {
        expect(await result).toMatchObject({
          stopped: false,
          blockMessage: expect.stringContaining("outside automatic triage"),
        });
      } else {
        expect(await result).toMatchObject({ stopped: true });
      }
      expect(events.filter((event) => event === "native stop")).toHaveLength(
        scenario === "live triage" || scenario === "late triage" ? 0 : 1,
      );
    } finally {
      inheritedHandoff.restore();
    }
  });
}
