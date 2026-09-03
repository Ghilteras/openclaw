import { describe, expect, it, vi } from "vitest";
import {
  createReefFederatedPromptDigest,
  type ReefFederationFrame,
} from "../protocol/federation.js";
import { ReefFederationCoordinator } from "./federation-coordinator.js";
import type { ReefFederationMount, ReefFederationProposal } from "./federation-state.js";

const from = "guest#1";
const to = "host#1";
const mount: ReefFederationMount = {
  mountId: "mount-1",
  peer: "guest",
  peerKeyEpoch: 1,
  sessionKey: "agent:main:shared",
  sessionId: "session-1",
  grantGeneration: 0,
  allowAlways: false,
};

function promptFrame(
  overrides: Partial<Extract<ReefFederationFrame, { type: "session.prompt.propose" }>> = {},
): Extract<ReefFederationFrame, { type: "session.prompt.propose" }> {
  const binding = {
    from,
    to,
    mountId: mount.mountId,
    proposalId: "proposal-1",
    sessionId: mount.sessionId,
    grantGeneration: mount.grantGeneration,
    text: "Check the current build",
    ...overrides,
  };
  return {
    type: "session.prompt.propose",
    mountId: binding.mountId,
    proposalId: binding.proposalId,
    sessionId: binding.sessionId,
    grantGeneration: binding.grantGeneration,
    text: binding.text,
    textSha256: createReefFederatedPromptDigest(binding),
  };
}

function fixture(options?: { allowAlways?: boolean }) {
  let currentMount = { ...mount, allowAlways: options?.allowAlways ?? false };
  const proposals = new Map<string, ReefFederationProposal>();
  const state = {
    getMount: vi.fn(() => ({ ...currentMount })),
    allowAlways: vi.fn((mountId: string, generation: number) => {
      if (mountId !== currentMount.mountId || generation !== currentMount.grantGeneration) {
        return false;
      }
      currentMount = { ...currentMount, allowAlways: true };
      return true;
    }),
    claimProposal: vi.fn((proposal: ReefFederationProposal) => {
      const existing = proposals.get(proposal.proposalId);
      if (!existing) {
        proposals.set(proposal.proposalId, { ...proposal });
        return { result: "new" as const, proposal };
      }
      return {
        result:
          existing.digest === proposal.digest ? ("duplicate" as const) : ("mismatch" as const),
        proposal: { ...existing },
      };
    }),
    resolveProposal: vi.fn(
      (
        proposalId: string,
        digest: string,
        outcome: Omit<ReefFederationProposal, "proposalId" | "mountId" | "digest">,
      ) => {
        const existing = proposals.get(proposalId);
        if (!existing || existing.digest !== digest) {
          return undefined;
        }
        const resolved = { ...existing, ...outcome };
        proposals.set(proposalId, resolved);
        return resolved;
      },
    ),
  };
  const request = vi.fn(async (method: string) =>
    method === "plugin.approval.request"
      ? { id: "plugin:approval-1", decision: "allow-once" }
      : { runId: "run-1" },
  );
  const coordinator = new ReefFederationCoordinator(
    { gateway: { isAvailable: async () => true, request } },
    state,
  );
  return { coordinator, request, state, proposals };
}

async function handle(
  coordinator: ReefFederationCoordinator,
  frame = promptFrame(),
  overrides: Partial<{ peer: string; peerKeyEpoch: number }> = {},
) {
  return await coordinator.handlePrompt({
    from,
    to,
    peer: "guest",
    peerKeyEpoch: 1,
    frame,
    ...overrides,
  });
}

describe("Reef federation coordinator", () => {
  it("uses the existing plugin approval and canonical agent admission", async () => {
    const { coordinator, request } = fixture();

    await expect(handle(coordinator)).resolves.toMatchObject({
      type: "session.prompt.accepted",
      runId: "run-1",
    });
    expect(request).toHaveBeenNthCalledWith(
      1,
      "plugin.approval.request",
      expect.objectContaining({
        pluginId: "reef",
        description: "Check the current build",
        sessionKey: mount.sessionKey,
        allowedDecisions: ["allow-once", "allow-always", "deny"],
      }),
      expect.any(Object),
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      "agent",
      expect.objectContaining({
        expectedExistingSessionId: mount.sessionId,
        idempotencyKey: "reef:proposal-1",
        inputProvenance: expect.objectContaining({
          kind: "inter_session",
          sourceChannel: "reef",
          sourceTool: "reef_federated_prompt",
        }),
      }),
      expect.any(Object),
    );
  });

  it("stores allow-always and skips approval for the next exact proposal", async () => {
    const { coordinator, request, state } = fixture();
    request.mockResolvedValueOnce({ id: "plugin:approval-1", decision: "allow-always" });

    await handle(coordinator);
    await handle(coordinator, promptFrame({ proposalId: "proposal-2" }));

    expect(state.allowAlways).toHaveBeenCalledWith(mount.mountId, 0);
    expect(
      request.mock.calls.filter(([method]) => method === "plugin.approval.request"),
    ).toHaveLength(1);
  });

  it("records denial without dispatching an agent run", async () => {
    const { coordinator, request } = fixture();
    request.mockResolvedValueOnce({ id: "plugin:approval-1", decision: "deny" });

    await expect(handle(coordinator)).resolves.toMatchObject({
      type: "session.prompt.denied",
      reason: "host-denied",
    });
    expect(request.mock.calls.some(([method]) => method === "agent")).toBe(false);
  });

  it("rejects stale grant and session bindings before approval", async () => {
    const { coordinator, request } = fixture();

    await expect(handle(coordinator, promptFrame({ grantGeneration: 1 }))).resolves.toMatchObject({
      type: "session.prompt.denied",
      reason: "grant-revoked",
    });
    await expect(
      handle(coordinator, promptFrame({ sessionId: "session-2" })),
    ).resolves.toMatchObject({
      type: "session.prompt.denied",
      reason: "stale-session",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("returns a committed duplicate outcome without another run", async () => {
    const { coordinator, request } = fixture({ allowAlways: true });

    const first = await handle(coordinator);
    const second = await handle(coordinator);

    expect(second).toEqual(first);
    expect(request.mock.calls.filter(([method]) => method === "agent")).toHaveLength(1);
  });
});
