// Codex tests cover the SQLite-backed thread binding facade.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLazyCodexAppServerBindingStore } from "./session-binding-store.js";
import {
  bindingStoreKey,
  CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
  createCodexAppServerBindingStore,
  createStoredCodexAppServerBinding,
  hashCodexAppServerBindingFingerprint,
  readCodexAppServerThreadBinding,
  readStoredCodexAppServerBinding,
  readStoredCodexAppServerCompactionTransition,
  reclaimCurrentCodexSessionGeneration,
  type StoredCodexAppServerBinding,
} from "./session-binding.js";
import { retainCodexTestCompactionTransition } from "./session-binding.test-helpers.js";

function createStateStore() {
  const values = new Map<string, StoredCodexAppServerBinding>();
  const state: PluginStateSyncKeyedStore<StoredCodexAppServerBinding> = {
    register(key, value) {
      values.set(key, value);
    },
    registerIfAbsent(key, value) {
      if (values.has(key)) {
        return false;
      }
      values.set(key, value);
      return true;
    },
    update(key, updateValue) {
      const next = updateValue(values.get(key));
      if (!next) {
        return false;
      }
      values.set(key, next);
      return true;
    },
    lookup: (key) => values.get(key),
    consume(key) {
      const value = values.get(key);
      values.delete(key);
      return value;
    },
    delete: (key) => values.delete(key),
    deleteIf: (key, predicate) => {
      const value = values.get(key);
      return value !== undefined && predicate(value) && values.delete(key);
    },
    entries: () => [...values].map(([key, value]) => ({ key, value, createdAt: 0 })),
    clear: () => values.clear(),
  };
  return { state, values };
}

afterEach(() => {
  vi.useRealTimers();
  resetPluginStateStoreForTests();
});

describe("Codex app-server binding store", () => {
  it("rechecks resume authority after the lazy store resolves and before writing", async () => {
    const { state } = createStateStore();
    const store = createLazyCodexAppServerBindingStore(state);
    const identity = { kind: "conversation" as const, bindingId: "pending-resume" };
    const binding = {
      threadId: "thread-pending",
      cwd: "/repo",
      pendingResumeConfiguration: true as const,
    };
    await store.mutate(identity, { kind: "set", binding });
    let current = true;
    const writing = store.mutate(
      identity,
      {
        kind: "patch",
        threadId: binding.threadId,
        patch: { pendingResumeConfiguration: undefined },
      },
      () => {
        if (!current) {
          throw new Error("resume authority changed");
        }
      },
    );
    current = false;
    await expect(writing).rejects.toThrow("resume authority changed");
    expect(store.read(identity)).toEqual(binding);
  });

  it("deletes only the requested stable owner and restores it on transaction rollback", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-binding-delete-"));
    try {
      const state = createPluginStateSyncKeyedStoreForTests<StoredCodexAppServerBinding>("codex", {
        namespace: "deletion-test",
        maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
        overflowPolicy: "reject-new",
        env: { ...process.env, OPENCLAW_STATE_DIR: root },
      });
      const store = createCodexAppServerBindingStore(state);
      const base = {
        kind: "session" as const,
        agentId: "main",
        sessionId: "shared-id",
        sessionKey: "agent:main:cron:job",
      };
      const run = { ...base, sessionKey: `${base.sessionKey}:run:one` };
      for (const identity of [base, run]) {
        await store.mutate(identity, {
          kind: "set",
          binding: {
            threadId: identity.sessionKey,
            cwd: "/repo",
          },
        });
      }
      const original = state.lookup(bindingStoreKey(run));
      await store.withSessionDeletion(
        run,
        () => {},
        async (_binding, mutation) => {
          mutation.commit();
          expect(state.lookup(bindingStoreKey(run))).toBeUndefined();
          expect(state.lookup(bindingStoreKey(base))).toMatchObject({ state: "active" });
          mutation.rollback();
        },
      );
      expect(state.lookup(bindingStoreKey(run))).toEqual(original);
      let retainedCommit: (() => void) | undefined;
      await store.withSessionDeletion(
        run,
        () => {},
        async (_binding, mutation) => {
          retainedCommit = mutation.commit;
          mutation.commit();
        },
      );
      expect(state.entries().map(({ key }) => key)).toEqual([bindingStoreKey(base)]);
      expect(retainedCommit).toThrow("lease");
    } finally {
      resetPluginStateStoreForTests();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("removes retired fences without creating rows for absent bindings", async () => {
    const { state, values } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const identity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "old",
      sessionKey: "agent:main:cron:expired",
    };
    await store.mutate(identity, { kind: "set", binding: { threadId: "old", cwd: "/repo" } });
    await store.retireSessionGeneration(identity);
    for (let attempt = 0; attempt < 2; attempt++) {
      await store.withSessionDeletion(
        identity,
        () => {},
        async (binding, mutation) => {
          expect(binding).toBeUndefined();
          mutation.commit();
        },
      );
      expect(values.size).toBe(0);
    }
  });

  it("rejects revoked deletion authority and never restores over a successor", async () => {
    const { state, values } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const identity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "old",
      sessionKey: "agent:main:cron:expired",
    };
    await store.mutate(identity, { kind: "set", binding: { threadId: "old", cwd: "/repo" } });
    let active = true;
    await expect(
      store.withSessionDeletion(
        identity,
        () => {
          if (!active) {
            throw new Error("owner revoked");
          }
        },
        async (_binding, mutation) => {
          active = false;
          expect(mutation.commit).toThrow("owner revoked");
        },
      ),
    ).rejects.toThrow("owner revoked");
    expect(values.get(bindingStoreKey(identity))).toMatchObject({
      state: "active",
      sessionId: "old",
    });
    // Revocation intentionally leaves the lease for expiry. The next owner is
    // independent persisted state, not a continuation of that closed callback.
    const successor = {
      version: 1 as const,
      state: "active" as const,
      sessionId: "new",
      binding: { threadId: "new", cwd: "/repo" },
    };
    state.register(bindingStoreKey(identity), successor);
    await expect(
      store.withSessionDeletion(
        identity,
        () => {},
        async (_binding, mutation) => {
          mutation.commit();
        },
      ),
    ).rejects.toThrow("generation changed");
    expect(values.get(bindingStoreKey(identity))).toEqual(successor);

    const current = { ...identity, sessionId: "new" };
    await store.withSessionDeletion(
      current,
      () => {},
      async (_binding, mutation) => {
        mutation.commit();
        state.register(bindingStoreKey(identity), successor);
        expect(mutation.rollback).toThrow("changed before session deletion rollback");
      },
    );
    expect(values.get(bindingStoreKey(identity))).toEqual(successor);
  });

  it("normalizes the retired approval policy in persisted bindings", () => {
    expect(
      readCodexAppServerThreadBinding({
        threadId: "thread-legacy-policy",
        cwd: "/repo",
        approvalPolicy: "on-failure",
        sandbox: "workspace-write",
      }),
    ).toMatchObject({
      threadId: "thread-legacy-policy",
      cwd: "/repo",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
  });

  it("preserves the effective managed approval policy in persisted thread bindings", () => {
    expect(
      readCodexAppServerThreadBinding({
        threadId: "thread-untrusted-policy",
        cwd: "/repo",
        approvalPolicy: "untrusted",
        sandbox: "workspace-write",
      }),
    ).toEqual({
      threadId: "thread-untrusted-policy",
      cwd: "/repo",
      approvalPolicy: "untrusted",
      sandbox: "workspace-write",
    });
  });

  it("stores domain data under the canonical session identity", async () => {
    const { state, values } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const identity = { kind: "session" as const, agentId: "main", sessionId: "session-1" };

    await store.mutate(identity, {
      kind: "set",
      binding: { threadId: "thread-1", cwd: "/repo", model: "gpt-5.4-codex" },
    });

    const binding = store.read(identity);
    expect(binding).toMatchObject({ threadId: "thread-1", cwd: "/repo" });
    expect(binding).not.toHaveProperty("sessionFile");
    expect(binding).not.toHaveProperty("schemaVersion");
    expect(values.get("session:main:session-1")).toMatchObject({
      version: 1,
      state: "active",
      binding: { threadId: "thread-1" },
    });
  });

  it("replaces only the exact ordinary thread owner", async () => {
    const { state } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const identity = { kind: "session" as const, agentId: "main", sessionId: "session-cas" };
    await store.mutate(identity, {
      kind: "set",
      binding: { threadId: "thread-old", cwd: "/repo" },
    });

    await expect(
      store.mutate(identity, {
        kind: "replace-thread",
        expectedThreadId: "thread-stale",
        binding: { threadId: "thread-new", cwd: "/repo" },
      }),
    ).resolves.toBe(false);
    expect(store.read(identity)).toMatchObject({ threadId: "thread-old" });

    await expect(
      store.mutate(identity, {
        kind: "replace-thread",
        expectedThreadId: "thread-old",
        binding: { threadId: "thread-new", cwd: "/repo" },
      }),
    ).resolves.toBe(true);
    expect(store.read(identity)).toMatchObject({ threadId: "thread-new" });
  });

  it("drops native compaction sync when the binding changes threads", async () => {
    const { state } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const identity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-native-compaction-retry",
    };
    await store.mutate(identity, {
      kind: "set",
      binding: {
        threadId: "thread-old",
        cwd: "/repo",
        nativeCompactionSyncPending: true,
      },
    });
    expect(store.read(identity)).toMatchObject({ nativeCompactionSyncPending: true });

    await expect(
      store.mutate(identity, {
        kind: "replace-thread",
        expectedThreadId: "thread-old",
        binding: {
          threadId: "thread-new",
          cwd: "/repo",
          nativeCompactionSyncPending: true,
        },
      }),
    ).resolves.toBe(true);
    expect(store.read(identity)).toEqual({ threadId: "thread-new", cwd: "/repo" });
  });

  it("rejects same-thread and supervision ownership through replacement CAS", async () => {
    const { state } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const identity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-cas-boundary",
    };
    await store.mutate(identity, {
      kind: "set",
      binding: { threadId: "thread-old", cwd: "/repo" },
    });

    await expect(
      store.mutate(identity, {
        kind: "replace-thread",
        expectedThreadId: "thread-old",
        binding: { threadId: "thread-old", cwd: "/repo" },
      }),
    ).resolves.toBe(false);
    await expect(
      store.mutate(identity, {
        kind: "replace-thread",
        expectedThreadId: "thread-old",
        binding: {
          threadId: "thread-private",
          cwd: "/repo",
          connectionScope: "supervision",
          supervisionSourceThreadId: "thread-private",
          preserveNativeModel: true,
        },
      }),
    ).resolves.toBe(false);
    expect(store.read(identity)).toMatchObject({ threadId: "thread-old" });
  });

  it("does not report the exact session or conversation binding owner as another owner", async () => {
    const { state } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const sessionIdentity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-current",
    };
    await store.mutate(sessionIdentity, {
      kind: "set",
      binding: { threadId: "thread-session", cwd: "/repo" },
    });

    await expect(store.hasOtherThreadOwner("thread-session", sessionIdentity)).resolves.toBe(false);

    const conversationIdentity = { kind: "conversation" as const, bindingId: "conversation-1" };
    await store.mutate(conversationIdentity, {
      kind: "set",
      binding: { threadId: "thread-conversation", cwd: "/repo" },
    });
    await expect(
      store.hasOtherThreadOwner("thread-conversation", conversationIdentity),
    ).resolves.toBe(false);
  });

  it("reports a different valid active binding owner", async () => {
    const { state } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const currentIdentity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-current",
    };
    await store.mutate(
      { kind: "conversation", bindingId: "conversation-owner" },
      {
        kind: "set",
        binding: { threadId: "thread-owned", cwd: "/repo" },
      },
    );

    await expect(store.hasOtherThreadOwner("thread-owned", currentIdentity)).resolves.toBe(true);
  });

  it.each([
    { name: "a different generation", storedSessionId: "session-previous" },
    { name: "a missing generation", storedSessionId: undefined },
  ])("treats $name under the same stable key as another owner", async ({ storedSessionId }) => {
    const { state, values } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const currentIdentity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-current",
      sessionKey: "agent:main:stable",
    };
    values.set(bindingStoreKey(currentIdentity), {
      version: 1,
      state: "active",
      binding: { threadId: "thread-stale-generation", cwd: "/repo" },
      ...(storedSessionId ? { sessionId: storedSessionId } : {}),
    });

    await expect(
      store.hasOtherThreadOwner("thread-stale-generation", currentIdentity),
    ).resolves.toBe(true);
  });

  it("fails closed on a malformed row during reverse ownership scans", async () => {
    const { state, values } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const currentIdentity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-current",
    };
    values.set("conversation:invalid", {
      version: 1,
      state: "active",
      binding: { threadId: "", cwd: "/repo" },
    } as never);

    await expect(store.hasOtherThreadOwner("thread-unowned", currentIdentity)).rejects.toThrow(
      "Invalid Codex app-server binding row: conversation:invalid",
    );
  });

  it("ignores stale cleared rows during reverse ownership scans", async () => {
    const { state, values } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const currentIdentity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-current",
    };
    values.set("conversation:cleared", {
      version: 1,
      state: "cleared",
      retired: true,
      binding: { threadId: "thread-unowned", cwd: "/repo" },
    } as never);

    await expect(store.hasOtherThreadOwner("thread-unowned", currentIdentity)).resolves.toBe(false);
  });

  it("fails closed on malformed pending supervision state", async () => {
    expect(
      readCodexAppServerThreadBinding({
        threadId: "thread-source",
        cwd: "/repo",
        preserveNativeModel: true,
        pendingSupervisionBranch: {
          sourceThreadId: "thread-source",
          cleanupThreadIds: ["thread-probe", "thread-probe"],
        },
      }),
    ).toBeUndefined();
    expect(
      readCodexAppServerThreadBinding({
        threadId: "thread-other",
        cwd: "/repo",
        preserveNativeModel: true,
        pendingSupervisionBranch: { sourceThreadId: "thread-source" },
      }),
    ).toBeUndefined();
    expect(
      readCodexAppServerThreadBinding({
        threadId: "thread-source",
        cwd: "/repo",
        pendingSupervisionBranch: { sourceThreadId: "thread-source", unknown: true },
      }),
    ).toBeUndefined();

    const { state } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const identity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-corrupt",
    };
    state.register(bindingStoreKey(identity), {
      version: 1,
      state: "active",
      binding: {
        threadId: "thread-source",
        cwd: "/repo",
        preserveNativeModel: true,
        pendingSupervisionBranch: {
          sourceThreadId: "thread-source",
          cleanupThreadIds: ["thread-source"],
        },
      },
    } as never);

    expect(() => store.read(identity)).toThrow("Invalid Codex app-server binding row");
  });

  it("fails closed on malformed private supervision ownership", () => {
    const valid = {
      threadId: "thread-source",
      cwd: "/repo",
      connectionScope: "supervision",
      supervisionSourceThreadId: "thread-source",
      preserveNativeModel: true,
      conversationSourceTransferComplete: true,
      pendingSupervisionBranch: { sourceThreadId: "thread-source" },
    };

    expect(readCodexAppServerThreadBinding({ ...valid, connectionScope: "user" })).toBeUndefined();
    expect(readCodexAppServerThreadBinding({ ...valid, connectionScope: {} })).toBeUndefined();
    expect(
      readCodexAppServerThreadBinding({ ...valid, supervisionSourceThreadId: undefined }),
    ).toBeUndefined();
  });

  it("commits a pending supervision branch only from its exact cleanup snapshot", async () => {
    const { state } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const identity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-supervision-cas",
    };
    const initial = {
      sourceThreadId: "thread-source",
      connectionFingerprint: "connection-one",
      lastTurnId: "turn-terminal",
    };
    await expect(
      store.mutate(identity, {
        kind: "set",
        if: { kind: "absent" },
        binding: {
          threadId: "thread-source",
          cwd: "/repo",
          connectionScope: "supervision",
          supervisionSourceThreadId: "thread-source",
          preserveNativeModel: true,
          conversationSourceTransferComplete: true,
          pendingSupervisionBranch: initial,
        },
      }),
    ).resolves.toBe(true);
    const tracked = { ...initial, cleanupThreadIds: ["thread-probe"] };
    await expect(
      store.mutate(identity, {
        kind: "patch-pending-supervision-branch",
        expected: { ...initial, connectionFingerprint: "connection-two" },
        pending: tracked,
      }),
    ).resolves.toBe(false);
    await expect(
      store.mutate(identity, {
        kind: "patch-pending-supervision-branch",
        expected: { ...initial, lastTurnId: "turn-other" },
        pending: tracked,
      }),
    ).resolves.toBe(false);
    await expect(
      store.mutate(identity, {
        kind: "patch-pending-supervision-branch",
        expected: initial,
        pending: tracked,
      }),
    ).resolves.toBe(true);
    await expect(
      store.mutate(identity, {
        kind: "commit-pending-supervision-branch",
        expected: initial,
        threadId: "thread-final",
        patch: { model: "native-model", modelProvider: "native-provider" },
      }),
    ).resolves.toBe(false);
    await expect(
      store.mutate(identity, {
        kind: "commit-pending-supervision-branch",
        expected: tracked,
        threadId: "thread-final",
        patch: { model: "native-model", modelProvider: "native-provider" },
      }),
    ).resolves.toBe(true);
    expect(store.read(identity)).toEqual({
      threadId: "thread-final",
      cwd: "/repo",
      connectionScope: "supervision",
      supervisionSourceThreadId: "thread-source",
      preserveNativeModel: true,
      conversationSourceTransferComplete: true,
      model: "native-model",
      modelProvider: "native-provider",
    });
  });

  it("round-trips account app policy context", async () => {
    const { state } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const identity = { kind: "session" as const, agentId: "main", sessionId: "session-account" };
    const pluginAppPolicyContext = {
      fingerprint: "account-policy-1",
      apps: {
        "chatgpt-meetings": {
          source: "account" as const,
          appName: "ChatGPT Meetings",
          allowDestructiveActions: true,
          allowOpenWorld: false,
          destructiveApprovalMode: "auto" as const,
          mcpServerNames: [],
        },
      },
      pluginAppIds: {},
    };

    await store.mutate(identity, {
      kind: "set",
      binding: { threadId: "thread-account", cwd: "/repo", pluginAppPolicyContext },
    });
    expect(store.read(identity)).toMatchObject({ pluginAppPolicyContext });

    const imported = createStoredCodexAppServerBinding({
      schemaVersion: 2,
      threadId: "thread-account",
      cwd: "/repo",
      updatedAt: "2026-01-01T00:00:00.000Z",
      pluginAppPolicyContext,
    });
    expect(imported?.binding.pluginAppPolicyContext).toEqual(pluginAppPolicyContext);
  });

  it("round-trips repository marketplace app ownership through stored and imported bindings", async () => {
    const { state } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const identity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-security-review",
    };
    const pluginAppPolicyContext = {
      fingerprint: "repository-plugin-policy",
      apps: {
        github: {
          configKey: "security-review@company-tools",
          marketplaceName: "company-tools",
          pluginName: "security-review",
          allowDestructiveActions: true,
          destructiveApprovalMode: "ask" as const,
          mcpServerNames: ["github"],
        },
      },
      pluginAppIds: { "security-review@company-tools": ["github"] },
    };

    await store.mutate(identity, {
      kind: "set",
      binding: { threadId: "thread-security-review", cwd: "/repo/company", pluginAppPolicyContext },
    });
    expect(store.read(identity)).toMatchObject({ pluginAppPolicyContext });

    const imported = createStoredCodexAppServerBinding({
      schemaVersion: 2,
      threadId: "thread-security-review",
      cwd: "/repo/company",
      pluginAppPolicyContext,
    });
    expect(imported?.binding.pluginAppPolicyContext).toEqual(pluginAppPolicyContext);
  });

  it("rejects unsafe marketplace names in imported plugin app ownership", () => {
    const imported = createStoredCodexAppServerBinding({
      schemaVersion: 2,
      threadId: "thread-unsafe-plugin",
      cwd: "/repo/company",
      pluginAppPolicyContext: {
        fingerprint: "unsafe-plugin-policy",
        apps: {
          github: {
            configKey: "security-review",
            marketplaceName: "../unsafe-marketplace",
            pluginName: "security-review",
            allowDestructiveActions: true,
            mcpServerNames: ["github"],
          },
        },
        pluginAppIds: { "security-review": ["github"] },
      },
    });

    expect(imported?.binding.pluginAppPolicyContext).toBeUndefined();
  });

  it("normalizes legacy fingerprints without rehashing canonical values", () => {
    const rawDynamicToolsFingerprint = JSON.stringify([{ name: "legacy_tool" }]);
    const rawUserMcpServersFingerprint = JSON.stringify({
      mcp_servers: { legacy: { command: "node" } },
    });
    const nativeSkillIsolationFingerprint = `sha256:${"b".repeat(64)}`;
    const imported = createStoredCodexAppServerBinding({
      schemaVersion: 2,
      threadId: "thread-legacy-fingerprints",
      cwd: "/repo",
      updatedAt: "2026-01-01T00:00:00.000Z",
      dynamicToolsFingerprint: rawDynamicToolsFingerprint,
      nativeSkillIsolationFingerprint,
      userMcpServersFingerprint: rawUserMcpServersFingerprint,
    });
    expect(imported?.binding).toMatchObject({
      dynamicToolsFingerprint: hashCodexAppServerBindingFingerprint(rawDynamicToolsFingerprint),
      nativeSkillIsolationFingerprint,
      userMcpServersFingerprint: hashCodexAppServerBindingFingerprint(rawUserMcpServersFingerprint),
    });

    const existingHash = `sha256:${"a".repeat(64)}`;
    const canonical = createStoredCodexAppServerBinding({
      schemaVersion: 2,
      threadId: "thread-canonical-fingerprints",
      cwd: "/repo",
      updatedAt: "2026-01-01T00:00:00.000Z",
      dynamicToolsFingerprint: "[]",
      userMcpServersFingerprint: existingHash,
    });
    expect(canonical?.binding).toMatchObject({
      dynamicToolsFingerprint: "[]",
      userMcpServersFingerprint: existingHash,
    });
  });

  it("canonicalizes undefined fields before writing to JSON-only plugin state", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-binding-state-"));
    try {
      const state = createPluginStateSyncKeyedStoreForTests<StoredCodexAppServerBinding>("codex", {
        namespace: "app-server-thread-bindings-json-test",
        maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      });
      const store = createCodexAppServerBindingStore(state);
      const identity = { kind: "conversation" as const, bindingId: "binding-json" };

      await expect(
        store.mutate(identity, {
          kind: "set",
          binding: {
            threadId: "thread-json",
            cwd: "/repo",
            model: undefined,
            contextEngine: {
              schemaVersion: 1,
              engineId: "lossless-claw",
              policyFingerprint: "policy-1",
              projection: undefined,
            },
          },
        }),
      ).resolves.toBe(true);
      expect(state.lookup(bindingStoreKey(identity))).toEqual({
        version: 1,
        state: "active",
        binding: {
          threadId: "thread-json",
          cwd: "/repo",
          contextEngine: {
            schemaVersion: 1,
            engineId: "lossless-claw",
            policyFingerprint: "policy-1",
          },
        },
      });

      await expect(
        store.mutate(identity, {
          kind: "patch",
          threadId: "thread-json",
          patch: { contextEngine: undefined },
        }),
      ).resolves.toBe(true);
      expect(store.read(identity)).toEqual({
        threadId: "thread-json",
        cwd: "/repo",
      });
      expect(state.lookup(bindingStoreKey(identity))).not.toHaveProperty("lease");
      await expect(store.mutate(identity, { kind: "clear" })).resolves.toBe(true);
      expect(store.read(identity)).toBeUndefined();
    } finally {
      resetPluginStateStoreForTests();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("keeps a replacement thread when a stale clear completes later", async () => {
    const { state } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const identity = { kind: "session" as const, agentId: "main", sessionId: "session-1" };
    await store.mutate(identity, {
      kind: "set",
      binding: { threadId: "thread-old", cwd: "/repo" },
    });
    await store.mutate(identity, {
      kind: "set",
      binding: { threadId: "thread-new", cwd: "/repo" },
    });

    await expect(store.mutate(identity, { kind: "clear", threadId: "thread-old" })).resolves.toBe(
      false,
    );
    expect(store.read(identity)).toMatchObject({ threadId: "thread-new" });
    await expect(store.mutate(identity, { kind: "clear", threadId: "thread-new" })).resolves.toBe(
      true,
    );
    expect(store.read(identity)).toBeUndefined();
  });

  it("retains cleared legacy conversation provenance after normal tombstones expire", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-13T00:00:00.000Z"));
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-binding-state-"));
    try {
      const state = createPluginStateSyncKeyedStoreForTests<StoredCodexAppServerBinding>("codex", {
        namespace: "app-server-thread-bindings-clear-test",
        maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      });
      const store = createCodexAppServerBindingStore(state);
      const normal = { kind: "conversation" as const, bindingId: "normal" };
      const legacy = { kind: "conversation" as const, bindingId: "legacy-source" };
      for (const identity of [normal, legacy]) {
        await store.mutate(identity, {
          kind: "set",
          binding: { threadId: `thread-${identity.bindingId}`, cwd: "/repo" },
        });
        await store.mutate(identity, { kind: "clear" });
      }

      vi.advanceTimersByTime(10);
      expect(state.lookup(bindingStoreKey(normal))).toBeUndefined();
      expect(state.lookup(bindingStoreKey(legacy))).toEqual({ version: 1, state: "cleared" });
    } finally {
      resetPluginStateStoreForTests();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("isolates identical session ids owned by different agents", async () => {
    const { state } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const first = { kind: "session" as const, agentId: "first", sessionId: "shared" };
    const second = { kind: "session" as const, agentId: "second", sessionId: "shared" };

    await store.mutate(first, {
      kind: "set",
      binding: { threadId: "thread-first", cwd: "/first" },
    });
    await store.mutate(second, {
      kind: "set",
      binding: { threadId: "thread-second", cwd: "/second" },
    });

    expect(store.read(first)).toMatchObject({ threadId: "thread-first" });
    expect(store.read(second)).toMatchObject({ threadId: "thread-second" });
    expect(bindingStoreKey({ kind: "session", agentId: " First ", sessionId: "shared" })).toBe(
      "session:first:shared",
    );
  });

  it.each([
    {
      name: "ordinary",
      binding: {
        threadId: "thread-ordinary",
        clientId: "client-ordinary",
        cwd: "/repo",
        model: "gpt-5.6-codex",
        modelProvider: "openai",
        nativeCompactionSyncPending: true as const,
        contextEngine: {
          schemaVersion: 1 as const,
          engineId: "legacy",
          policyFingerprint: "policy",
        },
      },
    },
    {
      name: "supervised",
      binding: {
        threadId: "thread-supervised",
        cwd: "/repo",
        connectionScope: "supervision" as const,
        supervisionSourceThreadId: "thread-source",
        model: "gpt-5.6-codex",
        modelProvider: "openai",
        preserveNativeModel: true as const,
        conversationSourceTransferComplete: true as const,
      },
    },
  ])("preserves every $name binding field through the v2 transition", async ({ binding }) => {
    const { state, values } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const previous = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:telegram:chat-1",
    };
    const successor = { ...previous, sessionId: "session-2" };
    await store.mutate(previous, { kind: "set", binding });
    const before = values.get(bindingStoreKey(previous));
    if (!before || before.state !== "active") {
      throw new Error("expected the predecessor binding");
    }

    await store.withContextEngineCompactionCommit(
      successor,
      previous.sessionId,
      () => {},
      async (mutation) => {
        mutation.commit();
        const raw = values.get(bindingStoreKey(previous));
        expect(readStoredCodexAppServerBinding(raw)).toBeUndefined();
        const transition = readStoredCodexAppServerCompactionTransition(raw);
        expect(transition).toMatchObject({
          version: 2,
          state: "compaction-transition",
          fromSessionId: previous.sessionId,
          toSessionId: successor.sessionId,
          nativeCompactionSyncPending: true,
          previous: {
            kind: "active",
            value: {
              version: 1,
              state: "active",
              sessionId: previous.sessionId,
              binding,
            },
          },
        });
        await expect(store.hasOtherThreadOwner(binding.threadId)).resolves.toBe(true);
        mutation.complete();
      },
    );

    expect(bindingStoreKey(previous)).toBe(bindingStoreKey(successor));
    expect(values.get(bindingStoreKey(successor))).toEqual({
      ...before,
      sessionId: successor.sessionId,
      binding: { ...binding, nativeCompactionSyncPending: true },
    });
    expect(store.read(previous)).toBeUndefined();
    expect(store.read(successor)).toEqual({
      ...binding,
      nativeCompactionSyncPending: true,
    });
  });

  it("marks a same-generation binding pending without changing other native state", async () => {
    const { state, values } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const identity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:telegram:chat-1",
    };
    const binding = {
      threadId: "thread-1",
      clientId: "client-1",
      cwd: "/repo",
      model: "gpt-5.6-codex",
      contextEngine: {
        schemaVersion: 1 as const,
        engineId: "lossless-claw",
        policyFingerprint: "policy-1",
      },
    };
    await store.mutate(identity, { kind: "set", binding });

    await store.withContextEngineCompactionCommit(
      identity,
      identity.sessionId,
      () => {},
      async (mutation) => {
        mutation.commit();
        expect(store.read(identity)).toEqual({
          ...binding,
          nativeCompactionSyncPending: true,
        });
        mutation.complete();
      },
    );

    expect(values.get(bindingStoreKey(identity))).toEqual({
      version: 1,
      state: "active",
      sessionId: identity.sessionId,
      binding: { ...binding, nativeCompactionSyncPending: true },
    });
  });

  it("restores the exact same-generation binding when host acceptance is rejected", async () => {
    const { state, values } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const identity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:telegram:chat-1",
    };
    await store.mutate(identity, {
      kind: "set",
      binding: {
        threadId: "thread-1",
        cwd: "/repo",
        nativeCompactionSyncPending: true,
      },
    });
    const before = structuredClone(values.get(bindingStoreKey(identity)));
    const hostFailure = new Error("host acceptance rejected");

    await expect(
      store.withContextEngineCompactionCommit(
        identity,
        identity.sessionId,
        () => {},
        async (mutation) => {
          mutation.commit();
          mutation.rollback();
          throw hostFailure;
        },
      ),
    ).rejects.toBe(hostFailure);

    expect(values.get(bindingStoreKey(identity))).toEqual(before);
  });

  it("leaves no binding row for same-generation compaction without a native thread", async () => {
    const { state, values } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const identity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:telegram:chat-1",
    };

    await store.withContextEngineCompactionCommit(
      identity,
      identity.sessionId,
      () => {},
      async (mutation) => {
        mutation.commit();
        mutation.complete();
      },
    );

    expect(values.has(bindingStoreKey(identity))).toBe(false);
  });

  it("restores the exact predecessor when the host rolls back after transition commit", async () => {
    const { state, values } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const previous = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:telegram:chat-1",
    };
    const successor = { ...previous, sessionId: "session-2" };
    await store.mutate(previous, {
      kind: "set",
      binding: {
        threadId: "thread-1",
        cwd: "/repo",
        model: "gpt-5.6-codex",
        nativeCompactionSyncPending: true,
      },
    });
    const before = structuredClone(values.get(bindingStoreKey(previous)));

    await store.withContextEngineCompactionCommit(
      successor,
      previous.sessionId,
      () => {},
      async (mutation) => {
        mutation.commit();
        expect(
          readStoredCodexAppServerCompactionTransition(values.get(bindingStoreKey(previous))),
        ).toBeDefined();
        mutation.rollback();
      },
    );

    expect(values.get(bindingStoreKey(previous))).toEqual(before);
    expect(store.read(previous)).toMatchObject({
      threadId: "thread-1",
      nativeCompactionSyncPending: true,
    });
    expect(store.read(successor)).toBeUndefined();
  });

  it("does not reconcile a live transition until its owner releases the lease", async () => {
    vi.useFakeTimers();
    const { state, values } = createStateStore();
    const owner = createCodexAppServerBindingStore(state);
    const peer = createCodexAppServerBindingStore(state);
    const previous = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:telegram:chat-1",
    };
    const successor = { ...previous, sessionId: "session-2" };
    await owner.mutate(previous, {
      kind: "set",
      binding: { threadId: "thread-1", cwd: "/repo" },
    });
    let releaseOwner!: () => void;
    let markCommitted!: () => void;
    const ownerReleased = new Promise<void>((resolve) => {
      releaseOwner = resolve;
    });
    const committed = new Promise<void>((resolve) => {
      markCommitted = resolve;
    });
    const ownerFailure = new Error("owner stopped after transition commit");
    const ownerRun = owner.withContextEngineCompactionCommit(
      successor,
      previous.sessionId,
      () => {},
      async (mutation) => {
        mutation.commit();
        markCommitted();
        await ownerReleased;
        throw ownerFailure;
      },
    );
    await committed;
    const transition = readStoredCodexAppServerCompactionTransition(
      values.get(bindingStoreKey(previous)),
    );
    if (!transition) {
      throw new Error("expected a committed compaction transition");
    }
    let peerFinished = false;
    const readHost = vi.fn(() => ({ sessionId: previous.sessionId }));
    const peerReconcile = peer
      .reconcileCompactionSuccessor(previous, transition.transitionId, readHost)
      .then((result) => {
        peerFinished = true;
        return result;
      });

    await vi.advanceTimersByTimeAsync(66_000);
    expect(peerFinished).toBe(false);
    expect(readHost).not.toHaveBeenCalled();
    expect(
      readStoredCodexAppServerCompactionTransition(values.get(bindingStoreKey(previous))),
    ).toMatchObject({ transitionId: transition.transitionId });

    releaseOwner();
    await expect(ownerRun).rejects.toBe(ownerFailure);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(peerReconcile).resolves.toBe(true);
    expect(readHost).toHaveBeenCalledOnce();
    expect(values.get(bindingStoreKey(previous))).toEqual({
      version: 1,
      state: "active",
      sessionId: previous.sessionId,
      binding: { threadId: "thread-1", cwd: "/repo" },
    });
  });

  it("fences exact absence and rejects a binding that appears before commit", async () => {
    const { state, values } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const previous = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:telegram:chat-1",
    };
    const successor = { ...previous, sessionId: "session-2" };

    await store.withContextEngineCompactionCommit(
      successor,
      previous.sessionId,
      () => {},
      async (mutation) => {
        mutation.commit();
        expect(
          readStoredCodexAppServerCompactionTransition(values.get(bindingStoreKey(successor))),
        ).toMatchObject({ previous: { kind: "absent" } });
        mutation.complete();
      },
    );
    expect(values.size).toBe(0);

    await expect(
      store.withContextEngineCompactionCommit(
        successor,
        previous.sessionId,
        () => {},
        async (mutation) => {
          state.register(bindingStoreKey(successor), {
            version: 1,
            state: "active",
            sessionId: previous.sessionId,
            binding: { threadId: "thread-raced", cwd: "/repo" },
          });
          mutation.commit();
        },
      ),
    ).rejects.toThrow("changed before context-engine compaction commit");
    expect(values.get(bindingStoreKey(successor))).toMatchObject({
      state: "active",
      binding: { threadId: "thread-raced" },
    });
  });

  it("fails normal reads, mutations, resets, and deletion on a retained transition", async () => {
    const { state, values } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const previous = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:telegram:chat-1",
    };
    const successor = { ...previous, sessionId: "session-2" };
    await store.mutate(previous, {
      kind: "set",
      binding: { threadId: "thread-1", cwd: "/repo" },
    });
    await retainCodexTestCompactionTransition(store, successor, previous.sessionId);

    expect(() => store.read(successor)).toThrow("transition is unresolved");
    await expect(
      store.mutate(successor, {
        kind: "patch",
        threadId: "thread-1",
        patch: { cwd: "/changed" },
      }),
    ).rejects.toThrow("transition is unresolved");
    await expect(store.resetSessionGeneration(successor)).rejects.toThrow(
      "transition is unresolved",
    );
    await expect(
      store.withSessionDeletion(
        successor,
        () => {},
        async () => undefined,
      ),
    ).rejects.toThrow("transition is unresolved");
    await expect(store.hasOtherThreadOwner("thread-1")).resolves.toBe(true);
    expect(
      readStoredCodexAppServerCompactionTransition(values.get(bindingStoreKey(successor))),
    ).toBeDefined();
  });

  it("rejects reclaim when another session generation wins after verification", async () => {
    const { state } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const first = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:telegram:chat-1",
    };
    const second = { ...first, sessionId: "session-2" };
    const third = { ...first, sessionId: "session-3" };
    await store.mutate(first, {
      kind: "set",
      binding: { threadId: "thread-1", cwd: "/repo" },
    });

    const plan = await store.prepareSessionGenerationReclaim(second);
    expect(plan).toEqual({ kind: "verify", expectedPreviousSessionId: first.sessionId });
    state.register(bindingStoreKey(third), {
      version: 1,
      state: "active",
      sessionId: third.sessionId,
      binding: { threadId: "thread-1", cwd: "/repo" },
    });
    if (plan.kind !== "verify") {
      throw new Error("expected stale session generation");
    }
    await expect(
      store.mutate(second, {
        kind: "reclaim-generation",
        expectedPreviousSessionId: plan.expectedPreviousSessionId,
      }),
    ).resolves.toBe(false);
    expect(store.read(third)).toMatchObject({ threadId: "thread-1" });
  });

  it.each([
    {
      name: "rolls back to P when the host still owns P",
      hostSessionId: "session-1",
      hostPreviousSessionId: undefined,
      reclaimSessionId: "session-1",
      expectedSessionId: "session-1",
      expectedNativeCompactionSyncPending: false,
    },
    {
      name: "finalizes S when the host owns S with previous P",
      hostSessionId: "session-2",
      hostPreviousSessionId: "session-1",
      reclaimSessionId: "session-2",
      expectedSessionId: "session-2",
      expectedNativeCompactionSyncPending: true,
    },
  ])("$name", async (scenario) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-transition-reclaim-"));
    const storePath = path.join(root, "sessions.json");
    const { state, values } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const previous = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:telegram:direct:123",
    };
    const successor = { ...previous, sessionId: "session-2" };
    const binding = {
      threadId: "thread-1",
      clientId: "client-1",
      cwd: "/repo",
      model: "gpt-5.6-codex",
    };
    try {
      await upsertSessionEntry({
        agentId: previous.agentId,
        sessionKey: previous.sessionKey,
        storePath,
        entry: {
          sessionId: scenario.hostSessionId,
          updatedAt: 1,
          ...(scenario.hostPreviousSessionId
            ? { previousSessionId: scenario.hostPreviousSessionId }
            : {}),
        },
      });
      await store.mutate(previous, { kind: "set", binding });
      await retainCodexTestCompactionTransition(store, successor, previous.sessionId);

      await expect(
        reclaimCurrentCodexSessionGeneration({
          bindingStore: store,
          identity: { ...previous, sessionId: scenario.reclaimSessionId },
          config: { session: { store: storePath } },
        }),
      ).resolves.toBe(true);
      expect(values.get(bindingStoreKey(previous))).toEqual({
        version: 1,
        state: "active",
        sessionId: scenario.expectedSessionId,
        binding: {
          ...binding,
          ...(scenario.expectedNativeCompactionSyncPending
            ? { nativeCompactionSyncPending: true as const }
            : {}),
        },
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: "wrong predecessor",
      hostSessionId: "session-2",
      hostPreviousSessionId: "session-other",
      reclaimSessionId: "session-2",
    },
    {
      name: "unrelated host",
      hostSessionId: "session-3",
      hostPreviousSessionId: "session-2",
      reclaimSessionId: "session-2",
    },
    {
      name: "stale caller",
      hostSessionId: "session-2",
      hostPreviousSessionId: "session-1",
      reclaimSessionId: "session-3",
    },
  ])("preserves v2 and fails closed for $name reconciliation", async (scenario) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-transition-stale-"));
    const storePath = path.join(root, "sessions.json");
    const { state, values } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const previous = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:telegram:direct:123",
    };
    const successor = { ...previous, sessionId: "session-2" };
    try {
      await upsertSessionEntry({
        agentId: previous.agentId,
        sessionKey: previous.sessionKey,
        storePath,
        entry: {
          sessionId: scenario.hostSessionId,
          previousSessionId: scenario.hostPreviousSessionId,
          updatedAt: 1,
        },
      });
      await store.mutate(previous, {
        kind: "set",
        binding: { threadId: "thread-1", cwd: "/repo" },
      });
      await retainCodexTestCompactionTransition(store, successor, previous.sessionId);
      const retained = structuredClone(values.get(bindingStoreKey(previous)));

      await expect(
        reclaimCurrentCodexSessionGeneration({
          bindingStore: store,
          identity: { ...previous, sessionId: scenario.reclaimSessionId },
          config: { session: { store: storePath } },
        }),
      ).resolves.toBe(false);
      expect(values.get(bindingStoreKey(previous))).toEqual(retained);
      expect(readStoredCodexAppServerCompactionTransition(retained)).toBeDefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("leaves recoverable v2 evidence when completion fails after host COMMIT", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-transition-complete-"));
    const storePath = path.join(root, "sessions.json");
    const fixture = createStateStore();
    const originalUpdate = fixture.state.update!.bind(fixture.state);
    let rejectCompletion = false;
    fixture.state.update = (key, updateValue, options) => {
      if (
        rejectCompletion &&
        readStoredCodexAppServerCompactionTransition(fixture.values.get(key))
      ) {
        rejectCompletion = false;
        throw new Error("injected transition completion failure");
      }
      return originalUpdate(key, updateValue, options);
    };
    const store = createCodexAppServerBindingStore(fixture.state);
    const previous = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:telegram:direct:123",
    };
    const successor = { ...previous, sessionId: "session-2" };
    try {
      await upsertSessionEntry({
        agentId: previous.agentId,
        sessionKey: previous.sessionKey,
        storePath,
        entry: {
          sessionId: previous.sessionId,
          updatedAt: 1,
        },
      });
      await store.mutate(previous, {
        kind: "set",
        binding: { threadId: "thread-1", cwd: "/repo" },
      });

      await expect(
        store.withContextEngineCompactionCommit(
          successor,
          previous.sessionId,
          () => {},
          async (mutation) => {
            mutation.commit();
            await upsertSessionEntry({
              agentId: previous.agentId,
              sessionKey: previous.sessionKey,
              storePath,
              entry: {
                sessionId: successor.sessionId,
                previousSessionId: previous.sessionId,
                updatedAt: 2,
              },
            });
            rejectCompletion = true;
            mutation.complete();
          },
        ),
      ).rejects.toThrow("injected transition completion failure");
      expect(
        readStoredCodexAppServerCompactionTransition(
          fixture.values.get(bindingStoreKey(successor)),
        ),
      ).toBeDefined();

      await expect(
        reclaimCurrentCodexSessionGeneration({
          bindingStore: store,
          identity: successor,
          config: { session: { store: storePath } },
        }),
      ).resolves.toBe(true);
      expect(store.read(successor)).toEqual({
        threadId: "thread-1",
        cwd: "/repo",
        nativeCompactionSyncPending: true,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to physical session identity when no stable session key exists", () => {
    const first = { kind: "session" as const, agentId: "main", sessionId: "session-1" };
    const second = { ...first, sessionId: "session-2" };

    expect(bindingStoreKey(first)).not.toBe(bindingStoreKey(second));
  });

  it("does not create a retirement tombstone for a session without a Codex binding", async () => {
    const { state, values } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const identity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:telegram:chat-1",
    };

    await expect(store.retireSessionGeneration(identity)).resolves.toBe("absent");
    expect(values.size).toBe(0);
  });

  it("expires physical-session retirement fences but retains stable-key fences", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-13T00:00:00.000Z"));
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-binding-state-"));
    try {
      const state = createPluginStateSyncKeyedStoreForTests<StoredCodexAppServerBinding>("codex", {
        namespace: "app-server-thread-bindings-retirement-test",
        maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
        overflowPolicy: "reject-new",
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      });
      const store = createCodexAppServerBindingStore(state);
      const physical = {
        kind: "session" as const,
        agentId: "main",
        sessionId: "physical-session",
      };
      const stable = {
        ...physical,
        sessionId: "stable-session",
        sessionKey: "agent:main:telegram:chat-1",
      };
      for (const identity of [physical, stable]) {
        await store.mutate(identity, {
          kind: "set",
          binding: { threadId: `thread-${identity.sessionId}`, cwd: "/repo" },
        });
        await expect(store.retireSessionGeneration(identity)).resolves.toBe("applied");
      }

      expect(state.lookup(bindingStoreKey(physical))).toMatchObject({
        state: "cleared",
        retired: true,
      });
      expect(state.lookup(bindingStoreKey(stable))).toMatchObject({
        state: "cleared",
        retired: true,
      });

      vi.advanceTimersByTime(2 * 60_000);

      expect(state.lookup(bindingStoreKey(physical))).toBeUndefined();
      expect(state.lookup(bindingStoreKey(stable))).toMatchObject({
        state: "cleared",
        retired: true,
      });
    } finally {
      resetPluginStateStoreForTests();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("claims a cleared binding once without allowing the retired generation back in", async () => {
    const { state, values } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const previous = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:telegram:chat-1",
    };
    const current = { ...previous, sessionId: "session-2" };
    await store.mutate(previous, {
      kind: "set",
      binding: { threadId: "thread-old", cwd: "/old" },
    });
    await expect(
      store.mutate(current, {
        kind: "set",
        binding: { threadId: "thread-premature", cwd: "/new" },
        if: { kind: "absent" },
      }),
    ).resolves.toBe(false);
    await expect(store.mutate(previous, { kind: "clear" })).resolves.toBe(true);

    await expect(
      store.mutate(current, {
        kind: "set",
        binding: { threadId: "thread-new", cwd: "/new" },
        if: { kind: "absent" },
      }),
    ).resolves.toBe(false);
    await expect(
      store.mutate(current, {
        kind: "reclaim-generation",
        expectedPreviousSessionId: previous.sessionId,
      }),
    ).resolves.toBe(true);
    await expect(
      store.mutate(current, {
        kind: "set",
        binding: { threadId: "thread-new", cwd: "/new" },
        if: { kind: "absent" },
      }),
    ).resolves.toBe(true);

    expect(store.read(previous)).toBeUndefined();
    expect(store.read(current)).toMatchObject({
      threadId: "thread-new",
      cwd: "/new",
    });
    await expect(
      store.mutate(previous, {
        kind: "set",
        binding: { threadId: "thread-stale", cwd: "/stale" },
        if: { kind: "absent" },
      }),
    ).resolves.toBe(false);
    await expect(store.mutate(previous, { kind: "clear" })).resolves.toBe(false);
    expect(values.size).toBe(1);
  });

  it("reclaims a stale stable generation only for the current OpenClaw session", async () => {
    const { state, values } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const previous = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:telegram:chat-1",
    };
    const current = { ...previous, sessionId: "session-2" };
    await store.mutate(previous, {
      kind: "set",
      binding: { threadId: "thread-old", cwd: "/old" },
    });
    await expect(
      store.mutate(current, {
        kind: "reclaim-generation",
        expectedPreviousSessionId: "other-session",
      }),
    ).resolves.toBe(false);
    expect(values.get(bindingStoreKey(previous))).toMatchObject({
      state: "active",
      sessionId: "session-1",
    });

    await expect(
      store.mutate(current, {
        kind: "reclaim-generation",
        expectedPreviousSessionId: previous.sessionId,
      }),
    ).resolves.toBe(true);
    expect(values.get(bindingStoreKey(current))).toEqual({
      version: 1,
      state: "cleared",
      sessionId: "session-2",
    });
    await expect(
      store.mutate(previous, {
        kind: "set",
        binding: { threadId: "thread-delayed-before-commit", cwd: "/stale" },
      }),
    ).resolves.toBe(false);
    await expect(
      store.mutate(current, {
        kind: "set",
        binding: { threadId: "thread-new", cwd: "/new" },
        if: { kind: "absent" },
      }),
    ).resolves.toBe(true);

    await expect(
      store.mutate(previous, {
        kind: "reclaim-generation",
        expectedPreviousSessionId: previous.sessionId,
      }),
    ).resolves.toBe(false);
    await expect(
      store.mutate(previous, {
        kind: "set",
        binding: { threadId: "thread-delayed", cwd: "/stale" },
      }),
    ).resolves.toBe(false);
    expect(store.read(current)).toMatchObject({ threadId: "thread-new" });
  });

  it("preserves a stale private supervision binding instead of reclaiming it as empty", async () => {
    const { state, values } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const previous = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:telegram:supervised",
    };
    const current = { ...previous, sessionId: "session-2" };
    await store.mutate(previous, {
      kind: "set",
      binding: {
        threadId: "thread-supervised",
        connectionScope: "supervision",
        supervisionSourceThreadId: "thread-source",
        cwd: "/repo",
        model: "gpt-5.5",
        modelProvider: "openai",
        preserveNativeModel: true,
        conversationSourceTransferComplete: true,
      },
    });
    await expect(
      store.mutate(previous, {
        kind: "set",
        binding: { threadId: "thread-replacement", cwd: "/other" },
      }),
    ).resolves.toBe(false);
    await expect(
      store.mutate(previous, { kind: "clear", threadId: "thread-supervised" }),
    ).resolves.toBe(false);

    await expect(
      store.mutate(current, {
        kind: "reclaim-generation",
        expectedPreviousSessionId: previous.sessionId,
      }),
    ).resolves.toBe(false);
    expect(values.get(bindingStoreKey(previous))).toMatchObject({
      state: "active",
      sessionId: previous.sessionId,
      binding: { threadId: "thread-supervised", connectionScope: "supervision" },
    });
    expect(store.read(previous)).toMatchObject({
      threadId: "thread-supervised",
      connectionScope: "supervision",
    });
    expect(store.read(current)).toBeUndefined();
  });

  it("fences a retired physical generation until its successor claims the stable key", async () => {
    const { state, values } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const previous = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:telegram:chat-1",
    };
    const current = { ...previous, sessionId: "session-2" };
    await store.mutate(previous, {
      kind: "set",
      binding: { threadId: "thread-old", cwd: "/old" },
    });

    await expect(store.retireSessionGeneration(previous)).resolves.toBe("applied");
    await expect(store.mutate(previous, { kind: "clear" })).resolves.toBe(true);
    expect(values.get(bindingStoreKey(previous))).toEqual({
      version: 1,
      state: "cleared",
      retired: true,
      sessionId: "session-1",
    });
    await expect(
      store.mutate(previous, {
        kind: "set",
        binding: { threadId: "thread-stale", cwd: "/stale" },
      }),
    ).resolves.toBe(false);
    await expect(store.withLease(previous, async () => undefined)).rejects.toThrow(
      "generation was retired",
    );

    await store.withLease(current, async () => undefined);
    expect(values.get(bindingStoreKey(previous))).toEqual({
      version: 1,
      state: "cleared",
      retired: true,
      sessionId: "session-1",
    });
    await expect(
      store.mutate(previous, {
        kind: "set",
        binding: { threadId: "thread-delayed", cwd: "/stale" },
      }),
    ).resolves.toBe(false);

    await expect(
      store.mutate(current, {
        kind: "reclaim-generation",
        expectedPreviousSessionId: previous.sessionId,
      }),
    ).resolves.toBe(true);
    await expect(
      store.mutate(current, {
        kind: "set",
        binding: { threadId: "thread-new", cwd: "/new" },
      }),
    ).resolves.toBe(true);
    expect(store.read(current)).toMatchObject({ threadId: "thread-new" });
  });

  it("keeps a retired in-place generation fenced until it is verified", async () => {
    const { state, values } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const identity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:telegram:chat-1",
    };
    await store.mutate(identity, {
      kind: "set",
      binding: { threadId: "thread-old", cwd: "/old" },
    });
    await store.retireSessionGeneration(identity);

    await expect(store.resetSessionGeneration(identity)).resolves.toBe("conflict");
    expect(values.get(bindingStoreKey(identity))).toEqual({
      version: 1,
      state: "cleared",
      retired: true,
      sessionId: identity.sessionId,
    });
    await expect(
      store.mutate(identity, {
        kind: "set",
        binding: { threadId: "thread-unverified", cwd: "/new" },
      }),
    ).resolves.toBe(false);
  });

  it("verifies and releases a retired fence for the still-current stable session id", async () => {
    const { state, values } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const identity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:telegram:chat-1",
    };
    await store.mutate(identity, {
      kind: "set",
      binding: { threadId: "thread-old", cwd: "/old" },
    });
    await store.retireSessionGeneration(identity);

    const plan = await store.prepareSessionGenerationReclaim(identity);
    expect(plan).toEqual({
      kind: "verify",
      expectedPreviousSessionId: identity.sessionId,
    });
    if (plan.kind !== "verify") {
      throw new Error("expected the current retired generation to require verification");
    }
    await expect(
      store.mutate(identity, {
        kind: "reclaim-generation",
        expectedPreviousSessionId: plan.expectedPreviousSessionId,
      }),
    ).resolves.toBe(true);
    expect(values.get(bindingStoreKey(identity))).toEqual({
      version: 1,
      state: "cleared",
      sessionId: identity.sessionId,
    });
    await expect(
      store.mutate(identity, {
        kind: "set",
        binding: { threadId: "thread-recovered", cwd: "/new" },
      }),
    ).resolves.toBe(true);
  });

  it("recovers a retired in-place generation through the authoritative session store", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-reset-reclaim-"));
    const storePath = path.join(root, "sessions.json");
    const { state } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const identity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-current",
      sessionKey: "agent:main:telegram:direct:123",
    };
    try {
      await upsertSessionEntry({
        agentId: identity.agentId,
        sessionKey: identity.sessionKey,
        storePath,
        entry: { sessionId: identity.sessionId, updatedAt: 1 },
      });
      await store.mutate(identity, {
        kind: "set",
        binding: { threadId: "thread-before-reset", cwd: "/repo" },
      });
      await store.retireSessionGeneration(identity);

      await expect(
        reclaimCurrentCodexSessionGeneration({
          bindingStore: store,
          identity,
          config: { session: { store: storePath } },
        }),
      ).resolves.toBe(true);
      await expect(
        store.mutate(identity, {
          kind: "set",
          binding: { threadId: "thread-after-reset", cwd: "/repo" },
        }),
      ).resolves.toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("drains an in-flight ownership mutation and rejects late attachment during archive", async () => {
    const fixture = createStateStore();
    const stateUpdate = fixture.state.update;
    if (!stateUpdate) {
      throw new Error("test state store must support atomic updates");
    }
    const originalUpdate = stateUpdate.bind(fixture.state);
    let startArchive: (() => void) | undefined;
    fixture.state.update = (...args) => {
      startArchive?.();
      startArchive = undefined;
      return originalUpdate(...args);
    };
    const store = createCodexAppServerBindingStore(fixture.state);
    const firstIdentity = { kind: "conversation" as const, bindingId: "first" };
    const lateIdentity = { kind: "conversation" as const, bindingId: "late" };
    let releaseArchive!: () => void;
    const archiveReleased = new Promise<void>((resolve) => {
      releaseArchive = resolve;
    });
    let archive!: Promise<void>;
    startArchive = () => {
      archive = store.withThreadArchiveFence(async () => {
        await expect(
          store.mutate(firstIdentity, {
            kind: "patch",
            threadId: "thread-before-archive",
            patch: { cwd: "/updated" },
          }),
        ).resolves.toBe(true);
        await archiveReleased;
      });
    };

    await expect(
      store.mutate(firstIdentity, {
        kind: "set",
        binding: { threadId: "thread-before-archive", cwd: "/repo" },
      }),
    ).resolves.toBe(true);
    await Promise.resolve();
    await expect(
      store.mutate(lateIdentity, {
        kind: "set",
        binding: { threadId: "thread-late", cwd: "/repo" },
      }),
    ).rejects.toThrow("native archive is in progress");
    releaseArchive();
    await expect(archive).resolves.toBeUndefined();
    expect(store.read(firstIdentity)).toMatchObject({ cwd: "/updated" });
    expect(store.read(lateIdentity)).toBeUndefined();
  });

  it("hashes stable session keys and keeps agent ownership distinct", () => {
    const sessionKey = "agent:main:telegram:private-peer@example.com";
    const first = bindingStoreKey({
      kind: "session",
      agentId: "first",
      sessionId: "session-1",
      sessionKey,
    });
    const second = bindingStoreKey({
      kind: "session",
      agentId: "second",
      sessionId: "session-2",
      sessionKey,
    });

    expect(first).toMatch(/^session-key:first:[A-Za-z0-9_-]{43}$/u);
    expect(first).not.toContain("private-peer");
    expect(second).not.toBe(first);
  });

  it("patches only the expected thread without advancing history implicitly", async () => {
    const { state } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const identity = { kind: "conversation" as const, bindingId: "binding-1" };
    const historyCoveredThrough = "2026-01-01T00:00:00.000Z";
    await store.mutate(identity, {
      kind: "set",
      binding: {
        threadId: "thread-1",
        cwd: "/repo",
        model: "gpt-5.4-codex",
        historyCoveredThrough,
      },
    });

    await expect(
      store.mutate(identity, {
        kind: "patch",
        threadId: "thread-1",
        patch: { serviceTier: "fast" },
      }),
    ).resolves.toBe(true);
    expect(store.read(identity)).toMatchObject({
      threadId: "thread-1",
      model: "gpt-5.4-codex",
      serviceTier: "priority",
      historyCoveredThrough,
    });
  });

  it("rejects stale patches and absent-only writes", async () => {
    const { state } = createStateStore();
    const store = createCodexAppServerBindingStore(state);
    const identity = { kind: "conversation" as const, bindingId: "binding-1" };
    await store.mutate(identity, {
      kind: "set",
      binding: { threadId: "thread-new", cwd: "/repo" },
    });

    await expect(
      store.mutate(identity, {
        kind: "patch",
        threadId: "thread-old",
        patch: { model: "stale-model" },
      }),
    ).resolves.toBe(false);
    await expect(
      store.mutate(identity, {
        kind: "set",
        binding: { threadId: "thread-stale", cwd: "/repo" },
        if: { kind: "absent" },
      }),
    ).resolves.toBe(false);
    expect(store.read(identity)).toMatchObject({ threadId: "thread-new" });
  });

  it("maps the legacy sidecar update timestamp to the history watermark", () => {
    const updatedAt = "2026-01-01T00:00:00.000Z";
    const stored = createStoredCodexAppServerBinding({
      schemaVersion: 1,
      threadId: "thread-1",
      cwd: "/repo",
      createdAt: "2025-12-31T00:00:00.000Z",
      updatedAt,
    });

    expect(stored?.binding).toMatchObject({ historyCoveredThrough: updatedAt });
    expect(stored?.binding).not.toHaveProperty("createdAt");
    expect(stored?.binding).not.toHaveProperty("updatedAt");
  });

  it("normalizes version 1 destructive approval modes during import", () => {
    const stored = createStoredCodexAppServerBinding({
      schemaVersion: 1,
      threadId: "thread-1",
      cwd: "/repo",
      pluginAppPolicyContext: {
        fingerprint: "policy-1",
        apps: {
          allow: {
            configKey: "allow",
            marketplaceName: "openai-curated",
            pluginName: "allow-plugin",
            allowDestructiveActions: true,
            destructiveApprovalMode: "auto",
            mcpServerNames: [],
          },
          prompt: {
            configKey: "prompt",
            marketplaceName: "openai-curated",
            pluginName: "prompt-plugin",
            allowDestructiveActions: true,
            destructiveApprovalMode: "on-request",
            mcpServerNames: [],
          },
        },
        pluginAppIds: {},
      },
    });

    expect(stored?.binding.pluginAppPolicyContext?.apps.allow?.destructiveApprovalMode).toBe(
      "allow",
    );
    expect(stored?.binding.pluginAppPolicyContext?.apps.prompt?.destructiveApprovalMode).toBe(
      "auto",
    );
  });

  it("preserves version 2 ask approval mode and drops invalid policy contexts", () => {
    const policyContext = {
      fingerprint: "policy-2",
      apps: {
        app: {
          configKey: "app",
          marketplaceName: "openai-curated",
          pluginName: "plugin",
          allowDestructiveActions: true,
          destructiveApprovalMode: "ask",
          mcpServerNames: [],
        },
      },
      pluginAppIds: {},
    };
    const stored = createStoredCodexAppServerBinding({
      schemaVersion: 2,
      threadId: "thread-2",
      cwd: "/repo",
      pluginAppPolicyContext: policyContext,
    });
    const invalid = createStoredCodexAppServerBinding({
      schemaVersion: 2,
      threadId: "thread-invalid",
      cwd: "/repo",
      pluginAppPolicyContext: {
        ...policyContext,
        apps: { app: { ...policyContext.apps.app, appId: "not-allowed" } },
      },
    });

    expect(stored?.binding.pluginAppPolicyContext?.apps.app?.destructiveApprovalMode).toBe("ask");
    expect(invalid?.binding.pluginAppPolicyContext).toBeUndefined();
  });

  it("round-trips workspace-directory plugin policy context", () => {
    const stored = createStoredCodexAppServerBinding({
      schemaVersion: 2,
      threadId: "thread-workspace-plugin",
      cwd: "/repo",
      pluginAppPolicyContext: {
        fingerprint: "policy-workspace",
        apps: {
          workspaceData: {
            configKey: "workspaceData",
            marketplaceName: "workspace-directory",
            pluginName: "workspace-data@workspace-directory",
            allowDestructiveActions: true,
            destructiveApprovalMode: "ask",
            mcpServerNames: [],
          },
        },
        pluginAppIds: { workspaceData: ["workspace-data"] },
      },
    });

    expect(stored?.binding.pluginAppPolicyContext).toMatchObject({
      apps: {
        workspaceData: {
          marketplaceName: "workspace-directory",
          pluginName: "workspace-data@workspace-directory",
          destructiveApprovalMode: "ask",
        },
      },
      pluginAppIds: { workspaceData: ["workspace-data"] },
    });
  });

  it("serializes writes from another facade behind a native-compaction lease", async () => {
    vi.useFakeTimers();
    const { state } = createStateStore();
    const owner = createCodexAppServerBindingStore(state);
    const peer = createCodexAppServerBindingStore(state);
    const identity = { kind: "conversation" as const, bindingId: "binding-1" };
    await owner.mutate(identity, {
      kind: "set",
      binding: { threadId: "thread-1", cwd: "/repo" },
    });
    let peerFinished = false;
    let peerWrite!: Promise<boolean>;

    await owner.withLease(identity, async () => {
      peerWrite = peer
        .mutate(identity, {
          kind: "set",
          binding: { threadId: "thread-2", cwd: "/repo" },
        })
        .then((result) => {
          peerFinished = true;
          return result;
        });
      await Promise.resolve();
      expect(peerFinished).toBe(false);
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await peerWrite;

    expect(peer.read(identity)).toMatchObject({ threadId: "thread-2" });
  });

  it("leases an absent binding before creating its first thread", async () => {
    vi.useFakeTimers();
    const { state } = createStateStore();
    const owner = createCodexAppServerBindingStore(state);
    const peer = createCodexAppServerBindingStore(state);
    const identity = { kind: "conversation" as const, bindingId: "binding-new" };
    let peerFinished = false;
    let peerWrite!: Promise<boolean>;

    await owner.withLease(identity, async () => {
      peerWrite = peer
        .mutate(identity, {
          kind: "set",
          binding: { threadId: "thread-peer", cwd: "/repo" },
          if: { kind: "absent" },
        })
        .then((result) => {
          peerFinished = true;
          return result;
        });
      await Promise.resolve();
      expect(peerFinished).toBe(false);
      await expect(
        owner.mutate(identity, {
          kind: "set",
          binding: { threadId: "thread-owner", cwd: "/repo" },
          if: { kind: "absent" },
        }),
      ).resolves.toBe(true);
      await Promise.resolve();
      expect(peerFinished).toBe(false);
    });
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(peerWrite).resolves.toBe(false);
    expect(owner.read(identity)).toMatchObject({ threadId: "thread-owner" });
  });

  it("releases a lease when its owner callback rejects", async () => {
    const { state } = createStateStore();
    const owner = createCodexAppServerBindingStore(state);
    const peer = createCodexAppServerBindingStore(state);
    const identity = { kind: "conversation" as const, bindingId: "binding-rejected-owner" };
    await owner.mutate(identity, {
      kind: "set",
      binding: { threadId: "thread-owner", cwd: "/repo" },
    });

    await expect(
      owner.withLease(identity, async () => {
        throw new Error("owner failed");
      }),
    ).rejects.toThrow("owner failed");
    await expect(
      peer.mutate(identity, {
        kind: "patch",
        threadId: "thread-owner",
        patch: { serviceTier: "priority" },
      }),
    ).resolves.toBe(true);
  });

  it("renews a live lease across a long app-server request", async () => {
    vi.useFakeTimers();
    const { state } = createStateStore();
    const owner = createCodexAppServerBindingStore(state);
    const peer = createCodexAppServerBindingStore(state);
    const identity = { kind: "conversation" as const, bindingId: "binding-renewed-owner" };
    await owner.mutate(identity, {
      kind: "set",
      binding: { threadId: "thread-owner", cwd: "/repo" },
    });
    let releaseOwner!: () => void;
    let markOwnerStarted!: () => void;
    const ownerStarted = new Promise<void>((resolve) => {
      markOwnerStarted = resolve;
    });
    const holdOwner = new Promise<void>((resolve) => {
      releaseOwner = resolve;
    });
    const ownerRun = owner.withLease(identity, async () => {
      markOwnerStarted();
      await holdOwner;
      return await owner.mutate(identity, {
        kind: "patch",
        threadId: "thread-owner",
        patch: { serviceTier: "priority" },
      });
    });
    await ownerStarted;
    let peerFinished = false;
    const peerWrite = peer
      .mutate(identity, {
        kind: "set",
        binding: { threadId: "thread-peer", cwd: "/repo" },
      })
      .then((result) => {
        peerFinished = true;
        return result;
      });

    await vi.advanceTimersByTimeAsync(66_000);
    expect(peerFinished).toBe(false);
    releaseOwner();
    await expect(ownerRun).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(peerWrite).resolves.toBe(true);
    expect(peer.read(identity)).toMatchObject({ threadId: "thread-peer" });
  });

  it("fences an expired lease owner after a peer takes over", async () => {
    vi.useFakeTimers();
    const { state } = createStateStore();
    const owner = createCodexAppServerBindingStore(state);
    const peer = createCodexAppServerBindingStore(state);
    const identity = { kind: "conversation" as const, bindingId: "binding-stale-owner" };
    await owner.mutate(identity, {
      kind: "set",
      binding: { threadId: "thread-owner", cwd: "/repo" },
    });

    await expect(
      owner.withLease(identity, async () => {
        vi.setSystemTime(Date.now() + 66_000);
        await peer.withLease(identity, async () => {
          await expect(
            peer.mutate(identity, {
              kind: "set",
              binding: { threadId: "thread-peer", cwd: "/repo" },
            }),
          ).resolves.toBe(true);
        });
        await owner.mutate(identity, {
          kind: "set",
          binding: { threadId: "thread-stale", cwd: "/repo" },
        });
      }),
    ).rejects.toThrow("Lost Codex binding lease");

    expect(owner.read(identity)).toMatchObject({ threadId: "thread-peer" });
  });

  it("surfaces heartbeat lease loss without deleting the replacement owner", async () => {
    vi.useFakeTimers();
    const { state, values } = createStateStore();
    const owner = createCodexAppServerBindingStore(state);
    const identity = { kind: "conversation" as const, bindingId: "binding-replaced-owner" };
    await owner.mutate(identity, {
      kind: "set",
      binding: { threadId: "thread-owner", cwd: "/repo" },
    });
    let releaseOwner!: () => void;
    let markOwnerStarted!: () => void;
    const ownerStarted = new Promise<void>((resolve) => {
      markOwnerStarted = resolve;
    });
    const holdOwner = new Promise<void>((resolve) => {
      releaseOwner = resolve;
    });
    const ownerRun = owner.withLease(identity, async () => {
      markOwnerStarted();
      await holdOwner;
    });
    await ownerStarted;
    const key = bindingStoreKey(identity);
    const current = values.get(key)!;
    values.set(key, {
      ...current,
      lease: { token: "peer-owner", expiresAt: Date.now() + 120_000 },
    });

    await vi.advanceTimersByTimeAsync(30_000);
    releaseOwner();
    await expect(ownerRun).rejects.toThrow("Lost Codex binding lease");
    expect(values.get(key)?.lease?.token).toBe("peer-owner");
  });

  it("rejects empty storage identities", () => {
    expect(() => bindingStoreKey({ kind: "session", agentId: "main", sessionId: " " })).toThrow(
      "requires a session id",
    );
    expect(() =>
      bindingStoreKey({ kind: "session", agentId: " ", sessionId: "session-1" }),
    ).toThrow("requires an agent id");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
