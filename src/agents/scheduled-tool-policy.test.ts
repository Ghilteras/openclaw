import { describe, expect, it } from "vitest";
import {
  resolveScheduledToolCallerContext,
  resolveScheduledToolPolicyContext,
} from "./scheduled-tool-policy.js";

describe("resolveScheduledToolPolicyContext", () => {
  it("requires valid server provenance, not a persisted cap", () => {
    expect(
      resolveScheduledToolPolicyContext({
        scheduledToolPolicy: { version: 1, mode: "trusted" },
      }),
    ).toEqual({ version: 1, mode: "trusted" });
    expect(
      resolveScheduledToolPolicyContext({
        toolsAllow: ["write"],
      }),
    ).toBeUndefined();
    expect(
      resolveScheduledToolPolicyContext({
        toolsAllow: ["write"],
        scheduledToolPolicy: { version: 2, mode: "trusted" },
      }),
    ).toBeUndefined();
    expect(
      resolveScheduledToolPolicyContext({ toolsAllow: ["write"], scheduledToolPolicy: {} }),
    ).toBeUndefined();
  });

  it("normalizes account provenance independently of legacy caps", () => {
    expect(
      resolveScheduledToolPolicyContext({
        scheduledToolPolicy: {
          version: 1,
          mode: "account",
          ownerSessionKey: " agent:main:discord:group:ops ",
          ownerAccountId: " work ",
        },
        callerOrigin: { kind: "external", channel: " Discord " },
      }),
    ).toEqual({
      version: 1,
      mode: "account",
      ownerSessionKey: "agent:main:discord:group:ops",
      ownerAccountId: "work",
      ownerOrigin: { kind: "external", channel: "discord" },
    });
  });

  it("preserves explicit local account provenance without inventing a channel", () => {
    expect(
      resolveScheduledToolPolicyContext({
        toolsAllow: [],
        scheduledToolPolicy: {
          version: 1,
          mode: "account",
          ownerSessionKey: "agent:main:main",
          ownerAccountId: "work",
        },
        callerOrigin: { kind: "local" },
      }),
    ).toEqual({
      version: 1,
      mode: "account",
      ownerSessionKey: "agent:main:main",
      ownerAccountId: "work",
      ownerOrigin: { kind: "local" },
    });
  });

  it("keeps missing account provenance explicitly unknown", () => {
    expect(
      resolveScheduledToolPolicyContext({
        toolsAllow: [],
        scheduledToolPolicy: {
          version: 1,
          mode: "account",
          ownerSessionKey: "agent:main:main",
          ownerAccountId: "work",
        },
      }),
    ).toEqual({
      version: 1,
      mode: "account",
      ownerSessionKey: "agent:main:main",
      ownerAccountId: "work",
      ownerOrigin: { kind: "unknown" },
    });
  });
});

describe("resolveScheduledToolCallerContext", () => {
  it("uses account-bound creator identity without changing delivery identity", () => {
    expect(
      resolveScheduledToolCallerContext({
        scheduledToolPolicy: {
          version: 1,
          mode: "account",
          ownerSessionKey: "agent:main:discord:group:ops",
          ownerAccountId: "creator",
          ownerOrigin: { kind: "external", channel: "discord" },
        },
        accountId: "delivery",
        channel: "telegram",
      }),
    ).toEqual({ accountId: "creator", channel: "discord", scheduled: true });
  });

  it("makes an unprovable account-bound channel explicitly unavailable", () => {
    expect(
      resolveScheduledToolCallerContext({
        scheduledToolPolicy: {
          version: 1,
          mode: "account",
          ownerSessionKey: "agent:main:main",
          ownerAccountId: "creator",
          ownerOrigin: { kind: "unknown" },
        },
        accountId: "delivery",
        channel: "telegram",
      }),
    ).toEqual({ accountId: "creator", channel: null, scheduled: true });
  });

  it("keeps explicitly local scheduled authority on the local tool surface", () => {
    expect(
      resolveScheduledToolCallerContext({
        scheduledToolPolicy: {
          version: 1,
          mode: "account",
          ownerSessionKey: "agent:main:main",
          ownerAccountId: "creator",
          ownerOrigin: { kind: "local" },
        },
        accountId: "delivery",
        channel: "discord",
      }),
    ).toEqual({ accountId: "creator", channel: undefined, local: true, scheduled: true });
  });

  it("does not turn a legacy exec pin into current runtime policy", () => {
    expect(
      resolveScheduledToolPolicyContext({
        toolsAllow: ["exec"],
        scheduledToolPolicy: { version: 1, mode: "trusted" },
        execTarget: { version: 1, host: "gateway", ask: "always" },
      }),
    ).toEqual({
      version: 1,
      mode: "trusted",
    });
  });

  it("does not resurrect a legacy pin when re-resolving trusted owner context", () => {
    const first = resolveScheduledToolPolicyContext({
      toolsAllow: ["exec"],
      scheduledToolPolicy: { version: 1, mode: "trusted" },
      execTarget: { version: 1, host: "gateway", ask: "always" },
    });
    const again = resolveScheduledToolPolicyContext({
      toolsAllow: ["exec"],
      scheduledToolPolicy: first,
    });
    expect(again).toEqual({
      version: 1,
      mode: "trusted",
    });
  });

  it("keeps account identity without replaying a legacy execution target", () => {
    const first = resolveScheduledToolPolicyContext({
      toolsAllow: ["exec"],
      scheduledToolPolicy: {
        version: 1,
        mode: "account",
        ownerSessionKey: "agent:main:main",
        ownerAccountId: "creator",
      },
      execTarget: { version: 1, host: "gateway", ask: "always" },
    });
    expect(first?.execTarget).toBeUndefined();
    const again = resolveScheduledToolPolicyContext({
      toolsAllow: ["exec"],
      scheduledToolPolicy: first,
      execTarget: first?.execTarget,
    });
    expect(again?.execTarget).toBeUndefined();
    expect(again?.ownerAccountId).toBe("creator");
  });

  it("ignores invalid exec pin shapes instead of widening or failing", () => {
    for (const execTarget of [
      { version: 2, host: "gateway" },
      { version: 1, host: "node" },
      "gateway",
      null,
    ]) {
      expect(
        resolveScheduledToolPolicyContext({
          toolsAllow: ["exec"],
          scheduledToolPolicy: { version: 1, mode: "trusted" },
          execTarget,
        })?.execTarget,
      ).toBeUndefined();
    }
  });
});
