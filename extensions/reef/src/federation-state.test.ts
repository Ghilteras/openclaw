import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ReefFederationState,
  type ReefFederationMount,
  type ReefFederationProposal,
} from "./federation-state.js";

function createRuntime(stateDir: string) {
  const runtime = createPluginRuntimeMock();
  runtime.state.openSyncKeyedStore = <T>(options: OpenKeyedStoreOptions) =>
    createPluginStateSyncKeyedStoreForTests<T>("reef", {
      ...options,
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
  return runtime;
}

const mount: ReefFederationMount = {
  mountId: "mount-1",
  peer: "guest",
  peerKeyEpoch: 1,
  role: "host",
  sessionKey: "agent:main:shared",
  sessionId: "session-1",
  grantGeneration: 0,
  allowAlways: false,
  revoked: false,
};

function pendingProposal(overrides: Partial<ReefFederationProposal> = {}): ReefFederationProposal {
  const digest = "a".repeat(64);
  return {
    proposalId: "proposal-1",
    mountId: mount.mountId,
    digest,
    status: "pending",
    request: {
      from: "guest#1",
      to: "host#1",
      peer: "guest",
      peerKeyEpoch: 1,
      frame: {
        type: "session.prompt.propose",
        mountId: mount.mountId,
        proposalId: "proposal-1",
        sessionId: mount.sessionId,
        grantGeneration: 0,
        text: "Check the build",
        textSha256: digest,
      },
    },
    ...overrides,
  };
}

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("Reef federation state", () => {
  let stateDir = "";

  beforeEach(() => {
    resetPluginStateStoreForTests();
    stateDir = tempDirs.make("openclaw-reef-federation-");
  });

  afterEach(() => {
    resetPluginStateStoreForTests();
  });

  it("persists session-scoped grants and revokes them by generation", () => {
    const state = new ReefFederationState(createRuntime(stateDir));
    expect(state.createMount(mount)).toBe(true);
    expect(state.allowAlways(mount.mountId, 0)).toBe(true);
    expect(new ReefFederationState(createRuntime(stateDir)).getMount(mount.mountId)).toMatchObject({
      allowAlways: true,
      grantGeneration: 0,
      sessionId: mount.sessionId,
    });

    expect(state.revoke(mount.mountId, 0)).toMatchObject({
      allowAlways: false,
      revoked: true,
      grantGeneration: 1,
    });
    expect(state.allowAlways(mount.mountId, 0)).toBe(false);
    expect(state.applyRevocation(mount.mountId, 3)).toBe(true);
    expect(state.getMount(mount.mountId)).toMatchObject({
      allowAlways: false,
      revoked: true,
      grantGeneration: 3,
    });
    expect(state.applyRevocation(mount.mountId, 2)).toBe(false);
  });

  it("deduplicates an exact proposal and rejects ID rebinding", () => {
    const state = new ReefFederationState(createRuntime(stateDir));
    const proposal = pendingProposal();
    const outcome = {
      type: "session.prompt.accepted" as const,
      mountId: mount.mountId,
      proposalId: proposal.proposalId,
      sessionId: mount.sessionId,
      runId: "run-1",
    };

    expect(state.claimProposal(proposal).result).toBe("new");
    expect(state.claimProposal(proposal).result).toBe("duplicate");
    expect(state.claimProposal({ ...proposal, digest: "b".repeat(64) }).result).toBe("mismatch");
    expect(
      state.resolveProposal(proposal.proposalId, proposal.digest, {
        status: "accepted",
        runId: "run-1",
        outcome,
      }),
    ).toMatchObject({ status: "accepted", runId: "run-1" });
    expect(state.listUnsentProposals()).toEqual([
      expect.objectContaining({ proposalId: proposal.proposalId, outcome }),
    ]);
    expect(state.markOutcomeSent(proposal.proposalId, proposal.digest)).toBe(true);
    expect(state.listUnsentProposals()).toEqual([]);
  });

  it("limits live mounts per peer", () => {
    const state = new ReefFederationState(createRuntime(stateDir));
    for (let index = 0; index < 32; index += 1) {
      expect(
        state.createMount({ ...mount, mountId: `mount-${index}`, sessionId: `session-${index}` }),
      ).toBe(true);
    }
    expect(state.createMount({ ...mount, mountId: "mount-overflow" })).toBe(false);
    expect(state.createMount({ ...mount, mountId: "other-peer", peer: "other" })).toBe(true);
  });
});
