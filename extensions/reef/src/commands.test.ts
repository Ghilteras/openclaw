import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const mounts = new Map<string, Record<string, unknown>>();
  const federation = {
    createMount: vi.fn((mount: Record<string, unknown>) => {
      mounts.set(String(mount.mountId), mount);
      return true;
    }),
    getMount: vi.fn((mountId: string) => mounts.get(mountId)),
    listMounts: vi.fn(() => [...mounts.values()]),
    revoke: vi.fn((mountId: string, generation: number) => {
      const mount = mounts.get(mountId);
      if (!mount) {
        return undefined;
      }
      const revoked = {
        ...mount,
        allowAlways: false,
        revoked: true,
        grantGeneration: generation + 1,
      };
      mounts.set(mountId, revoked);
      return revoked;
    }),
  };
  const flow = {
    sendFederation: vi.fn(async () => "envelope-1"),
    proposeFederatedPrompt: vi.fn(async () => "proposal-1"),
  };
  const trust = {
    get: vi.fn(() => ({ keyEpoch: 1, safetyNumberChanged: false })),
  };
  const gatewayRequest = vi.fn(async () => ({
    sessions: [{ key: "agent:main:shared", sessionId: "session-1" }],
  }));
  return { mounts, federation, flow, trust, gatewayRequest };
});

vi.mock("./runtime.js", () => ({
  getActiveReef: () => ({
    federation: mocks.federation,
    flow: mocks.flow,
    trust: mocks.trust,
    friends: {},
    reviews: {},
  }),
  getReefRuntime: () => ({ gateway: { request: mocks.gatewayRequest } }),
}));

import { handleReefCommand } from "./commands.js";

describe("Reef session commands", () => {
  beforeEach(() => {
    mocks.mounts.clear();
    vi.clearAllMocks();
  });

  it("shares an exact session incarnation with a trusted peer", async () => {
    const result = await handleReefCommand({
      args: "session share @guest agent:main:shared",
      senderIsOwner: true,
    });

    expect(result.text).toMatch(/^Shared agent:main:shared with @guest as mount reef-mount-/);
    const mount = mocks.federation.createMount.mock.calls[0]![0];
    expect(mount).toMatchObject({
      peer: "guest",
      peerKeyEpoch: 1,
      role: "host",
      sessionKey: "agent:main:shared",
      sessionId: "session-1",
      grantGeneration: 0,
    });
    expect(mocks.flow.sendFederation).toHaveBeenCalledWith(
      "guest",
      expect.objectContaining({
        type: "session.mount.offer",
        mountId: mount.mountId,
        sessionId: "session-1",
      }),
    );
  });

  it("submits and revokes an existing mount", async () => {
    const mount = {
      mountId: "mount-1",
      peer: "host",
      peerKeyEpoch: 1,
      role: "guest",
      sessionKey: "agent:main:shared",
      sessionId: "session-1",
      grantGeneration: 0,
      allowAlways: false,
      revoked: false,
    };
    mocks.mounts.set(mount.mountId, mount);

    await expect(
      handleReefCommand({
        args: "session prompt mount-1 Check the current build",
        senderIsOwner: true,
      }),
    ).resolves.toEqual({ text: "Sent Reef prompt proposal proposal-1." });
    expect(mocks.flow.proposeFederatedPrompt).toHaveBeenCalledWith(
      mount,
      "Check the current build",
    );
    mocks.mounts.set(mount.mountId, { ...mount, role: "host", peer: "host" });

    await expect(
      handleReefCommand({ args: "session revoke mount-1", senderIsOwner: true }),
    ).resolves.toEqual({ text: "Revoked Reef session mount mount-1." });
    expect(mocks.flow.sendFederation).toHaveBeenCalledWith("host", {
      type: "session.grant.revoked",
      mountId: "mount-1",
      sessionId: "session-1",
      grantGeneration: 1,
    });
  });

  it("keeps session mutation commands owner-only", async () => {
    await expect(
      handleReefCommand({ args: "session prompt mount-1 hello", senderIsOwner: false }),
    ).resolves.toEqual({
      text: "Only an owner in commands.ownerAllowFrom can change Reef friends or decide reviews. Ask a configured owner; friendship changes can also use openclaw reef locally.",
    });
    expect(mocks.flow.proposeFederatedPrompt).not.toHaveBeenCalled();
  });
});
