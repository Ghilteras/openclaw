import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createReefFederatedPromptDigest,
  MemoryAuditStore,
  MemoryReplayStore,
} from "../protocol/index.js";
import { ReefChannelConfigSchema } from "./config-schema.js";
import { ReefFederationCoordinator } from "./federation-coordinator.js";
import { ReefFederationState, type ReefFederationMount } from "./federation-state.js";
import { ReefMessageFlow } from "./flow.js";
import {
  allow,
  flowStores,
  guard,
  peerTrust,
  reefKeys,
  resetFlowStoresForTests,
  transport,
  trust,
} from "./flow.test-helpers.js";
import { reefPeerIdentity } from "./friend-types.js";
import type { ReefTransportClient } from "./transport.js";
import type { InboxEntry } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function config(handle: string) {
  return ReefChannelConfigSchema.parse({
    handle,
    email: `${handle}@example.com`,
    guard: {
      provider: "openai",
      pinnedModel: "mock-2026-07-12",
      apiKeyEnv: "REEF_TEST_KEY",
      policyVersion: "v1",
      timeoutMs: 1_000,
    },
  });
}

function federationState(name: string, existingStateDir?: string): ReefFederationState {
  const runtime = createPluginRuntimeMock();
  const stateDir = existingStateDir ?? tempDirs.make(`openclaw-reef-${name}-`);
  runtime.state.openSyncKeyedStore = <T>(options: OpenKeyedStoreOptions) =>
    createPluginStateSyncKeyedStoreForTests<T>("reef", {
      ...options,
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
  return new ReefFederationState(runtime);
}

beforeEach(() => {
  resetPluginStateStoreForTests();
  resetFlowStoresForTests();
});

afterEach(() => {
  resetPluginStateStoreForTests();
  resetFlowStoresForTests();
});

describe("Reef federated prompt E2E", () => {
  it("mounts, approves, executes, acknowledges, and revokes across two isolated flows", async () => {
    const hostKeys = reefKeys();
    const guestKeys = reefKeys();
    const hostTrust = trust({ guest: peerTrust(guestKeys) });
    const guestTrust = trust({ host: peerTrust(hostKeys) });
    const hostStateDir = tempDirs.make("openclaw-reef-host-");
    const hostState = federationState("host", hostStateDir);
    const guestState = federationState("guest");
    const hostStores = flowStores();
    const guestStores = flowStores();
    const hostTransport = transport();
    const guestTransport = transport();
    const gatewayRequest = vi.fn(async (method: string) =>
      method === "plugin.approval.request"
        ? { id: "plugin:approval-1", decision: "allow-once" }
        : { runId: "run-1" },
    );
    const coordinator = new ReefFederationCoordinator(
      {
        gateway: {
          isAvailable: async () => true,
          request: async <T>(method: string) => {
            const response = await gatewayRequest(method);
            // SAFETY: this E2E fixture returns the exact response shape for each invoked method.
            return response as T;
          },
        },
      },
      hostState,
      (peer) => {
        const currentTrust = hostTrust.values.get(peer);
        return currentTrust ? reefPeerIdentity(currentTrust) : undefined;
      },
    );
    const outcomes: string[] = [];
    let sequence = 0;

    hostTransport.sendEnvelope.mockImplementation(async (_peer, envelope) => {
      await guestFlow.processEntries([
        {
          seq: ++sequence,
          peer: "host",
          id: envelope.id,
          kind: "message",
          envelope,
          ts: 1,
        },
      ]);
      return { id: envelope.id, status: "queued" };
    });
    guestTransport.sendEnvelope.mockImplementation(async (_peer, envelope) => {
      await hostFlow.processEntries([
        {
          seq: ++sequence,
          peer: "guest",
          id: envelope.id,
          kind: "message",
          envelope,
          ts: 1,
        },
      ]);
      return { id: envelope.id, status: "queued" };
    });

    const hostFlow = new ReefMessageFlow({
      config: config("host"),
      trust: hostTrust.store,
      keys: hostKeys,
      transport: hostTransport as unknown as ReefTransportClient,
      guard: guard(allow),
      audit: new MemoryAuditStore(new Uint8Array(32).fill(1)),
      replay: new MemoryReplayStore(),
      ...hostStores,
      onIngress: async () => {},
      onFederation: async ({ peer, from, to, frame }) => {
        if (frame.type !== "session.prompt.propose") {
          throw new Error(`unexpected host frame ${frame.type}`);
        }
        const outcome = await coordinator.handlePrompt({
          peer,
          from,
          to,
          peerIdentity: reefPeerIdentity(hostTrust.values.get(peer)!),
          frame,
        });
        await hostFlow.sendFederation(peer, outcome);
        if (!hostState.markOutcomeSent(frame.proposalId, frame.textSha256)) {
          throw new Error(`failed to mark ${frame.proposalId} delivered`);
        }
      },
      onOwnerNotice: async () => {},
    });
    const guestFlow = new ReefMessageFlow({
      config: config("guest"),
      trust: guestTrust.store,
      keys: guestKeys,
      transport: guestTransport as unknown as ReefTransportClient,
      guard: guard(allow),
      audit: new MemoryAuditStore(new Uint8Array(32).fill(2)),
      replay: new MemoryReplayStore(),
      ...guestStores,
      onIngress: async () => {},
      onFederation: async ({ peer, frame }) => {
        if (frame.type === "session.mount.offer") {
          guestState.createMount({
            mountId: frame.mountId,
            peer,
            peerIdentity: reefPeerIdentity(guestTrust.values.get(peer)!),
            role: "guest",
            sessionKey: frame.sessionKey,
            sessionId: frame.sessionId,
            grantGeneration: frame.grantGeneration,
            allowAlways: false,
            revoked: false,
          });
          return;
        }
        if (frame.type === "session.grant.revoked") {
          guestState.applyRevocation(frame.mountId, frame.grantGeneration);
          return;
        }
        outcomes.push(frame.type);
      },
      onOwnerNotice: async () => {},
    });

    const hostMount: ReefFederationMount = {
      mountId: "mount-1",
      peer: "guest",
      peerIdentity: reefPeerIdentity(hostTrust.values.get("guest")!),
      role: "host",
      sessionKey: "agent:main:shared",
      sessionId: "session-1",
      grantGeneration: 0,
      allowAlways: false,
      revoked: false,
    };
    expect(hostState.createMount(hostMount)).toBe(true);
    await hostFlow.sendFederation("guest", {
      type: "session.mount.offer",
      mountId: hostMount.mountId,
      sessionKey: hostMount.sessionKey,
      sessionId: hostMount.sessionId,
      grantGeneration: hostMount.grantGeneration,
    });

    const guestMount = guestState.getMount(hostMount.mountId);
    expect(guestMount).toMatchObject({ role: "guest", sessionId: "session-1" });
    await guestFlow.proposeFederatedPrompt(guestMount!, "Inspect the current build");

    expect(outcomes).toEqual(["session.prompt.accepted"]);
    expect(gatewayRequest.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "agent",
    ]);
    const sentProposal = guestTransport.sendEnvelope.mock.calls[0]?.[1];
    expect(sentProposal).toBeDefined();
    await hostFlow.processEntries([
      {
        seq: ++sequence,
        peer: "guest",
        id: sentProposal!.id,
        kind: "message",
        envelope: sentProposal!,
        ts: 2,
      } satisfies InboxEntry,
    ]);
    expect(gatewayRequest).toHaveBeenCalledTimes(2);

    const revoked = hostState.revoke(hostMount.mountId, 0);
    expect(revoked).toMatchObject({ grantGeneration: 1, allowAlways: false });
    await hostFlow.sendFederation("guest", {
      type: "session.grant.revoked",
      mountId: hostMount.mountId,
      sessionId: hostMount.sessionId,
      grantGeneration: revoked!.grantGeneration,
    });
    expect(guestState.getMount(hostMount.mountId)).toMatchObject({
      grantGeneration: 1,
      allowAlways: false,
      revoked: true,
    });
    await expect(
      guestFlow.proposeFederatedPrompt(
        guestState.getMount(hostMount.mountId)!,
        "Try after revocation",
      ),
    ).rejects.toThrow("Only active guest Reef mounts can propose prompts");

    const staleBinding = {
      from: "guest#1",
      to: "host#1",
      mountId: hostMount.mountId,
      proposalId: "proposal-after-revocation",
      sessionId: hostMount.sessionId,
      grantGeneration: 0,
      text: "Bypass the revoked mount",
    };
    hostTransport.sendEnvelope.mockRejectedValueOnce(new Error("relay unavailable"));
    await expect(
      guestFlow.sendFederation("host", {
        type: "session.prompt.propose",
        mountId: staleBinding.mountId,
        proposalId: staleBinding.proposalId,
        sessionId: staleBinding.sessionId,
        grantGeneration: staleBinding.grantGeneration,
        text: staleBinding.text,
        textSha256: createReefFederatedPromptDigest(staleBinding),
      }),
    ).rejects.toThrow("relay unavailable");

    expect(outcomes).toEqual(["session.prompt.accepted"]);
    expect(gatewayRequest).toHaveBeenCalledTimes(2);
    const restartedHostState = federationState("host-restart", hostStateDir);
    const [unsent] = restartedHostState.listUnsentProposals();
    expect(unsent).toMatchObject({
      proposalId: "proposal-after-revocation",
      status: "denied",
      outcome: expect.objectContaining({ reason: "grant-revoked" }),
    });

    await hostFlow.sendFederation(unsent!.request.peer, unsent!.outcome!);
    expect(restartedHostState.markOutcomeSent(unsent!.proposalId, unsent!.digest)).toBe(true);
    expect(restartedHostState.listUnsentProposals()).toEqual([]);
    expect(outcomes).toEqual(["session.prompt.accepted", "session.prompt.denied"]);
  });
});
