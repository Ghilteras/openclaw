import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import type { HookRunner } from "../../plugins/hooks.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import {
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { PreparedAgentRunAdmission } from "../admitted-run-context.js";
import { getRegisteredAgentHarness, registerAgentHarness } from "../harness/registry.js";
import type {
  AgentHarness,
  AgentHarnessContextEngineCompactionCommitMutation,
  AgentHarnessContextEngineCompactionCommitParams,
} from "../harness/types.js";
import type {
  AcceptedCompactionSuccessor,
  acceptCompactionSuccessor,
} from "./compaction-successor.js";

type AcceptanceInput = Parameters<typeof acceptCompactionSuccessor>[0];

const hooks = vi.hoisted(() => ({
  hasHooks: vi.fn<HookRunner["hasHooks"]>(),
  runSessionEnd: vi.fn<HookRunner["runSessionEnd"]>(),
  runSessionStart: vi.fn<HookRunner["runSessionStart"]>(),
}));
vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => hooks,
}));

async function withAcceptanceFixture(
  options: { claimWriter?: boolean; agentHarnessId?: string },
  body: (fixture: {
    target: AcceptanceInput["currentTarget"];
    entry: InternalSessionEntry;
    successorId: string;
    callerError: Error;
    assertActive: () => void;
    stop: () => void;
    accept: (overrides?: Partial<AcceptanceInput>) => Promise<AcceptedCompactionSuccessor>;
    facts: AcceptedCompactionSuccessor[];
    loadEntry: () => InternalSessionEntry | undefined;
    replaceWriter: () => Promise<void>;
    replaceEntry: (patch: Partial<InternalSessionEntry>) => Promise<unknown>;
    deleteEntry: () => Promise<unknown>;
    rejectSuccessorWrite: () => () => void;
    observeIdentity: (observer: () => void) => void;
    writeLegacyArtifact: () => Promise<string>;
  }) => Promise<void>,
) {
  await withOpenClawTestState(
    { label: "compaction-successor", scenario: "minimal" },
    async (state) => {
      const {
        appendTranscriptMessage,
        applySessionEntryLifecycleMutation,
        loadSessionEntry,
        loadTranscriptEvents,
        replaceSessionEntry,
      } = await import("../../config/sessions/session-accessor.js");
      const { waitForSessionTranscriptIndexReconcile } =
        await import("../../config/sessions/session-transcript-reconcile.js");
      const { prepareSystemAgentRunAdmission, resolveAdmittedRunActiveAssertion } =
        await import("../admitted-run-context.js");
      const { claimAgentSessionWriter } = await import("./run/session-bootstrap.js");
      const { onSessionIdentityMutation } =
        await import("../../sessions/session-lifecycle-events.js");
      const { forgetActiveSessionForShutdown } =
        await import("../../gateway/active-sessions-shutdown-tracker.js");
      const { openOpenClawAgentDatabase } = await import("../../state/openclaw-agent-db.js");
      const { acceptCompactionSuccessor } = await import("./compaction-successor.js");
      const target = {
        agentId: "main",
        sessionId: randomUUID(),
        sessionKey: `agent:main:${randomUUID()}`,
        storePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
      };
      await replaceSessionEntry(target, {
        sessionId: target.sessionId,
        lifecycleRevision: randomUUID(),
        updatedAt: 1,
        compactionCount: 7,
        ...(options.agentHarnessId ? { agentHarnessId: options.agentHarnessId } : {}),
      });
      await appendTranscriptMessage(target, {
        cwd: state.workspaceDir,
        message: { role: "user", content: "Preserved predecessor history", timestamp: 1 },
      });
      const runId = randomUUID();
      const admission = prepareSystemAgentRunAdmission({}, runId, target.agentId, "successor-test");
      const admissions: PreparedAgentRunAdmission[] = [admission];
      const unsubscriptions: Array<() => void> = [];
      const facts: AcceptedCompactionSuccessor[] = [];
      const controller = new AbortController();
      const callerError = new Error("caller stopped successor acceptance");
      try {
        const admittedRunContext = await admission.admit("embedded");
        const runParams = {
          ...target,
          sessionFile: target.sessionKey,
          sessionTarget: target,
          runId,
          admittedRunContext,
          workspaceDir: state.workspaceDir,
          prompt: "continue",
          timeoutMs: 30_000,
        };
        if (options.claimWriter !== false) {
          await claimAgentSessionWriter(runParams);
        }
        const entry: InternalSessionEntry | undefined = loadSessionEntry(target);
        if (!entry) {
          throw new Error("fixture must own an existing durable session");
        }
        const live = resolveAdmittedRunActiveAssertion(admittedRunContext);
        if (!live) {
          throw new Error("fixture must own a live admission");
        }
        const assertActive = () => {
          controller.signal.throwIfAborted();
          live();
        };
        const stop = () => {
          admission.close();
          controller.abort(callerError);
        };
        const successorId = randomUUID();
        const input: AcceptanceInput = {
          currentTarget: target,
          expectedEntry: {
            sessionId: entry.sessionId,
            lifecycleRevision: entry.lifecycleRevision,
            activeWriterRunId: entry.activeWriterRunId,
          },
          assertActive,
          config: {},
          contextEngineOwnsCompaction: true,
          result: {
            ok: true,
            compacted: true,
            result: {
              summary: "Engine-owned successor context",
              tokensBefore: 4_097,
              tokensAfter: 3_000,
              sessionTarget: { sessionId: successorId, threadId: "thread-hint" },
            },
          },
        };
        await body({
          target,
          entry,
          successorId,
          callerError,
          assertActive,
          stop,
          facts,
          accept: (overrides = {}) =>
            acceptCompactionSuccessor({
              ...input,
              ...overrides,
              onCommitted: (accepted) => {
                facts.push(accepted);
                overrides.onCommitted?.(accepted);
              },
            }),
          loadEntry: () => loadSessionEntry(target),
          replaceWriter: async () => {
            const nextRunId = randomUUID();
            const next = prepareSystemAgentRunAdmission(
              {},
              nextRunId,
              target.agentId,
              "replacement-successor-test",
            );
            admissions.push(next);
            const nextContext = await next.admit("embedded");
            await claimAgentSessionWriter({
              ...runParams,
              runId: nextRunId,
              admittedRunContext: nextContext,
            });
          },
          replaceEntry: (patch) => replaceSessionEntry(target, { ...entry, ...patch }),
          deleteEntry: () =>
            applySessionEntryLifecycleMutation({
              agentId: target.agentId,
              storePath: target.storePath,
              removals: [{ sessionKey: target.sessionKey }],
              skipMaintenance: true,
            }),
          rejectSuccessorWrite: () => {
            const database = openOpenClawAgentDatabase({
              agentId: target.agentId,
              path: target.storePath,
            });
            const trigger = `reject_compaction_successor_${successorId.replaceAll("-", "_")}`;
            database.db.exec(`
              CREATE TRIGGER ${trigger}
              BEFORE UPDATE OF current_session_id ON session_nodes
              WHEN OLD.session_key = '${target.sessionKey}'
                AND NEW.current_session_id = '${successorId}'
              BEGIN
                SELECT RAISE(ABORT, 'injected compaction successor failure');
              END;
            `);
            return () => database.db.exec(`DROP TRIGGER ${trigger};`);
          },
          observeIdentity: (observer) => {
            unsubscriptions.push(
              onSessionIdentityMutation((mutation) => {
                if (
                  mutation.kind === "replace" &&
                  mutation.previous.sessionId === target.sessionId
                ) {
                  observer();
                }
              }),
            );
          },
          writeLegacyArtifact: async () => {
            // Named tagged-upgrade artifact contract: session_end may identify a
            // still-existing legacy export, while live state remains canonical SQLite.
            const artifact = path.join(state.agentDir(), `${target.sessionId}.jsonl`);
            const events = await loadTranscriptEvents(target);
            await fs.writeFile(
              artifact,
              `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
            );
            return await fs.realpath(artifact);
          },
        });
      } finally {
        for (const unsubscribe of unsubscriptions) {
          unsubscribe();
        }
        for (const owned of admissions) {
          owned.close();
        }
        await waitForSessionTranscriptIndexReconcile({
          agentId: target.agentId,
          path: target.storePath,
          env: state.env,
        });
        forgetActiveSessionForShutdown(target.sessionId);
        for (const accepted of facts) {
          forgetActiveSessionForShutdown(accepted.sessionId);
        }
      }
    },
  );
}

beforeEach(() => {
  resetGatewayWorkAdmission();
  hooks.hasHooks.mockReset().mockReturnValue(false);
  hooks.runSessionEnd.mockReset().mockResolvedValue(undefined);
  hooks.runSessionStart.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  resetGatewayWorkAdmission();
  vi.restoreAllMocks();
});

function enableLifecycleHooks() {
  hooks.hasHooks.mockImplementation((name) => name === "session_end" || name === "session_start");
}

describe("acceptCompactionSuccessor", () => {
  it.each([true, false])(
    "transfers the declared identity without reclaiming its writer (claimed=%s)",
    async (claimWriter) => {
      await withAcceptanceFixture({ claimWriter }, async (fixture) => {
        const accepted = await fixture.accept();
        expect(accepted.sessionTarget).toMatchObject({
          ...fixture.target,
          sessionId: fixture.successorId,
          threadId: "thread-hint",
        });
        expect(accepted.previousSessionId).toBe(fixture.target.sessionId);
        expect(accepted.entry).toMatchObject({
          sessionId: fixture.successorId,
          lifecycleRevision: fixture.entry.lifecycleRevision,
          compactionCount: 7,
          usageFamilyKey: fixture.target.sessionKey,
          usageFamilySessionIds: [fixture.target.sessionId, fixture.successorId],
        });
        expect(accepted.entry.activeWriterRunId).toBe(fixture.entry.activeWriterRunId);
        expect(fixture.loadEntry()).toEqual(accepted.entry);
        expect(fixture.facts).toEqual([accepted]);
        fixture.assertActive();
      });
    },
  );

  it("records same-ID acceptance without rewriting host metadata or lifecycle", async () => {
    await withAcceptanceFixture({}, async (fixture) => {
      const before = fixture.loadEntry();
      const identity = vi.fn();
      fixture.observeIdentity(identity);
      const accepted = await fixture.accept({
        result: { ok: true, compacted: true },
      });
      expect(accepted.previousSessionId).toBeUndefined();
      expect(accepted.sessionTarget).toEqual(fixture.target);
      expect(fixture.loadEntry()).toEqual(before);
      expect(fixture.facts).toEqual([accepted]);
      expect(identity).not.toHaveBeenCalled();
      expect(hooks.runSessionEnd).not.toHaveBeenCalled();
      expect(hooks.runSessionStart).not.toHaveBeenCalled();
    });
  });

  it.each([
    { ok: false, compacted: true },
    { ok: true, compacted: false },
  ])("does not transfer a failed or declined successor ($ok/$compacted)", async (outcome) => {
    await withAcceptanceFixture({}, async (fixture) => {
      enableLifecycleHooks();
      const before = fixture.loadEntry();
      await expect(
        fixture.accept({
          result: {
            ...outcome,
            result: { tokensBefore: 4_097, sessionId: fixture.successorId },
          },
        }),
      ).rejects.toThrow("without a successful completed compaction");
      expect(fixture.loadEntry()).toEqual(before);
      expect(fixture.facts).toEqual([]);
      expect(hooks.runSessionEnd).not.toHaveBeenCalled();
      expect(hooks.runSessionStart).not.toHaveBeenCalled();
    });
  });

  it.each(["writer", "lifecycle", "session", "deleted"] as const)(
    "rejects a stale predecessor after %s replacement",
    async (change) => {
      await withAcceptanceFixture({}, async (fixture) => {
        if (change === "writer") {
          await fixture.replaceWriter();
        } else if (change === "lifecycle") {
          await fixture.replaceEntry({ lifecycleRevision: randomUUID() });
        } else if (change === "session") {
          await fixture.replaceEntry({ sessionId: randomUUID() });
        } else {
          await fixture.deleteEntry();
        }
        const before = fixture.loadEntry();
        await expect(fixture.accept()).rejects.toThrow("session writer claim changed");
        expect(fixture.loadEntry()).toEqual(before);
        expect(fixture.facts).toEqual([]);
      });
    },
  );

  it("treats a captured absent writer as exact absence rather than a wildcard", async () => {
    await withAcceptanceFixture({ claimWriter: false }, async (fixture) => {
      expect(fixture.entry.activeWriterRunId).toBeUndefined();
      await fixture.replaceWriter();
      const before = fixture.loadEntry();
      await expect(fixture.accept()).rejects.toThrow("session writer claim changed");
      expect(fixture.loadEntry()).toEqual(before);
      expect(fixture.facts).toEqual([]);
    });
  });

  it("preserves the caller error and predecessor when cancellation precedes commit", async () => {
    await withAcceptanceFixture({}, async (fixture) => {
      const before = fixture.loadEntry();
      await expect(
        fixture.accept({
          assertActive: () => {
            fixture.assertActive();
            queueMicrotask(fixture.stop);
          },
        }),
      ).rejects.toBe(fixture.callerError);
      expect(fixture.loadEntry()).toEqual(before);
      expect(fixture.facts).toEqual([]);
    });
  });

  it("captures a real commit before an identity observer cancels the caller", async () => {
    await withAcceptanceFixture({}, async (fixture) => {
      let factAtObserver: AcceptedCompactionSuccessor | undefined;
      fixture.observeIdentity(() => {
        factAtObserver = fixture.facts[0];
        fixture.stop();
      });
      const accepted = await fixture.accept();
      expect(factAtObserver).toBe(accepted);
      expect(accepted.entry.sessionId).toBe(fixture.successorId);
      expect(fixture.loadEntry()).toEqual(accepted.entry);
      expect(fixture.assertActive).toThrow(fixture.callerError);
    });
  });

  it("commits same-ID native synchronization without rewriting host session metadata", async () => {
    await withPluginRuntimeRegistryScope(createEmptyPluginRegistry(), async () => {
      await withAcceptanceFixture({ agentHarnessId: "binding-test" }, async (fixture) => {
        const before = fixture.loadEntry();
        let nativeSyncPending = false;
        registerAgentHarness({
          id: "binding-test",
          label: "Binding Test",
          supports: () => ({ supported: true }),
          runAttempt: vi.fn(),
          withContextEngineCompactionCommit: async (_params, run) =>
            await run({
              commit() {
                nativeSyncPending = true;
              },
              rollback() {
                nativeSyncPending = false;
              },
              complete() {},
            }),
        } satisfies AgentHarness);

        const accepted = await fixture.accept({
          harnessRuntime: "binding-test",
          result: {
            ok: true,
            compacted: true,
            result: {
              summary: "same generation",
              tokensBefore: 4_097,
              tokensAfter: 3_000,
              sessionTarget: { sessionId: fixture.target.sessionId },
            },
          },
        });

        expect(nativeSyncPending).toBe(true);
        expect(accepted.previousSessionId).toBeUndefined();
        expect(accepted.entry).toEqual(before);
        expect(fixture.loadEntry()).toEqual(before);
        expect(fixture.facts).toEqual([accepted]);
        expect(hooks.runSessionEnd).not.toHaveBeenCalled();
        expect(hooks.runSessionStart).not.toHaveBeenCalled();
      });
    });
  });

  it("does not invoke the harness commit when the context engine does not own compaction", async () => {
    await withPluginRuntimeRegistryScope(createEmptyPluginRegistry(), async () => {
      await withAcceptanceFixture({ agentHarnessId: "binding-test" }, async (fixture) => {
        const withContextEngineCompactionCommit = vi.fn();
        registerAgentHarness({
          id: "binding-test",
          label: "Binding Test",
          supports: () => ({ supported: true }),
          runAttempt: vi.fn(),
          withContextEngineCompactionCommit,
        } satisfies AgentHarness);

        await expect(
          fixture.accept({
            harnessRuntime: "binding-test",
            contextEngineOwnsCompaction: false,
          }),
        ).resolves.toMatchObject({ sessionId: fixture.successorId });
        expect(withContextEngineCompactionCommit).not.toHaveBeenCalled();
      });
    });
  });

  it("completes the selected harness commit before identity and lifecycle observers", async () => {
    const order: string[] = [];
    await withPluginRuntimeRegistryScope(createEmptyPluginRegistry(), async () => {
      await withAcceptanceFixture({ agentHarnessId: "binding-test" }, async (fixture) => {
        const withContextEngineCompactionCommit = vi.fn(
          async <T>(
            params: AgentHarnessContextEngineCompactionCommitParams,
            run: (mutation: AgentHarnessContextEngineCompactionCommitMutation) => Promise<T>,
          ) => {
            params.assertCurrent();
            expect(params).toMatchObject({
              config: {},
              agentId: fixture.target.agentId,
              sessionKey: fixture.target.sessionKey,
              previousSessionId: fixture.target.sessionId,
              sessionId: fixture.successorId,
            });
            return await run({
              commit() {
                params.assertCurrent();
                order.push("transition");
              },
              rollback() {
                throw new Error("unexpected rollback");
              },
              complete() {
                params.assertCurrent();
                expect(fixture.loadEntry()?.sessionId).toBe(fixture.successorId);
                fixture.assertActive();
                order.push("completed");
              },
            });
          },
        );
        const harness = {
          id: "binding-test",
          label: "Binding Test",
          supports: () => ({ supported: true as const }),
          async runAttempt() {
            throw new Error("not used");
          },
          withContextEngineCompactionCommit,
        } satisfies AgentHarness;
        registerAgentHarness(harness);
        hooks.hasHooks.mockImplementation((name) => name === "session_end");
        hooks.runSessionEnd.mockImplementationOnce(async () => {
          order.push("observed");
        });
        fixture.observeIdentity(fixture.stop);

        const acceptance = fixture.accept({
          harnessRuntime: harness.id,
          onCommitted: () => {
            order.push("published");
            throw new Error("post-commit publication failed");
          },
        });
        const accepted = await acceptance;

        await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
        expect(accepted.entry.sessionId).toBe(fixture.successorId);
        expect(fixture.assertActive).toThrow(fixture.callerError);
        expect(withContextEngineCompactionCommit).toHaveBeenCalledOnce();
        expect(order).toEqual(["transition", "completed", "published", "observed"]);
      });
    });
  });

  it("rolls back a prepared harness transition when the host SQL write fails", async () => {
    await withPluginRuntimeRegistryScope(createEmptyPluginRegistry(), async () => {
      await withAcceptanceFixture({ agentHarnessId: "binding-test" }, async (fixture) => {
        const before = fixture.loadEntry();
        const mutation = {
          commit: vi.fn(),
          rollback: vi.fn(),
          complete: vi.fn(),
        } satisfies AgentHarnessContextEngineCompactionCommitMutation;
        const withContextEngineCompactionCommit = vi.fn(
          async <T>(
            _params: AgentHarnessContextEngineCompactionCommitParams,
            run: (prepared: AgentHarnessContextEngineCompactionCommitMutation) => Promise<T>,
          ) => await run(mutation),
        );
        registerAgentHarness({
          id: "binding-test",
          label: "Binding Test",
          supports: () => ({ supported: true }),
          runAttempt: vi.fn(),
          withContextEngineCompactionCommit,
        } satisfies AgentHarness);
        const removeFailure = fixture.rejectSuccessorWrite();
        try {
          await expect(fixture.accept({ harnessRuntime: "binding-test" })).rejects.toThrow(
            "injected compaction successor failure",
          );
        } finally {
          removeFailure();
        }
        expect(fixture.loadEntry()).toEqual(before);
        expect(fixture.facts).toEqual([]);
        expect(mutation.commit).toHaveBeenCalledOnce();
        expect(mutation.rollback).toHaveBeenCalledOnce();
        expect(mutation.complete).not.toHaveBeenCalled();
      });
    });
  });

  it("records host success when harness completion fails after COMMIT", async () => {
    await withPluginRuntimeRegistryScope(createEmptyPluginRegistry(), async () => {
      await withAcceptanceFixture({ agentHarnessId: "binding-test" }, async (fixture) => {
        const mutation = {
          commit: vi.fn(),
          rollback: vi.fn(),
          complete: vi.fn(() => {
            throw new Error("native transition remains recoverable");
          }),
        } satisfies AgentHarnessContextEngineCompactionCommitMutation;
        registerAgentHarness({
          id: "binding-test",
          label: "Binding Test",
          supports: () => ({ supported: true }),
          runAttempt: vi.fn(),
          withContextEngineCompactionCommit: async (_params, run) => await run(mutation),
        } satisfies AgentHarness);

        const accepted = await fixture.accept({ harnessRuntime: "binding-test" });

        expect(fixture.facts).toEqual([accepted]);
        expect(fixture.loadEntry()?.sessionId).toBe(fixture.successorId);
        expect(mutation.commit).toHaveBeenCalledOnce();
        expect(mutation.complete).toHaveBeenCalledOnce();
        expect(mutation.rollback).not.toHaveBeenCalled();
      });
    });
  });

  it("fails closed before commit when a registered transition owner is unavailable", async () => {
    await withPluginRuntimeRegistryScope(createEmptyPluginRegistry(), async () => {
      await withAcceptanceFixture({ agentHarnessId: "binding-test" }, async (fixture) => {
        const before = fixture.loadEntry();
        const withContextEngineCompactionCommit = vi.fn();
        registerAgentHarness(
          {
            id: "binding-test",
            label: "Binding Test",
            supports: () => ({ supported: true }),
            runAttempt: vi.fn(),
            withContextEngineCompactionCommit,
          } satisfies AgentHarness,
          { ownerPluginId: "missing-owner" },
        );

        await expect(
          fixture.accept({ harnessRuntime: "binding-test" }),
        ).rejects.toThrow(
          "Agent harness binding-test context-engine compaction owner is not current",
        );
        expect(fixture.loadEntry()).toEqual(before);
        expect(withContextEngineCompactionCommit).not.toHaveBeenCalled();
      });
    });
  });

  it("fences a replaced harness lifecycle before either transition commits", async () => {
    await withPluginRuntimeRegistryScope(createEmptyPluginRegistry(), async () => {
      await withAcceptanceFixture({ agentHarnessId: "binding-test" }, async (fixture) => {
        const before = fixture.loadEntry();
        const harness: AgentHarness = {
          id: "binding-test",
          label: "Binding Test",
          supports: () => ({ supported: true }),
          runAttempt: vi.fn(),
          withContextEngineCompactionCommit: async (transitionParams, run) => {
            const registeredHarness = getRegisteredAgentHarness("binding-test")?.harness;
            if (!registeredHarness) {
              throw new Error("expected registered binding-test harness");
            }
            registeredHarness.withContextEngineCompactionCommit = vi.fn();
            transitionParams.assertCurrent();
            return await run({
              commit() {},
              rollback() {},
              complete() {},
            });
          },
        };
        registerAgentHarness(harness);

        await expect(
          fixture.accept({ harnessRuntime: "binding-test" }),
        ).rejects.toThrow(
          "Agent harness binding-test changed during context-engine compaction commit",
        );
        expect(fixture.loadEntry()).toEqual(before);
        expect(fixture.facts).toEqual([]);
      });
    });
  });

  it("returns the known commit after a fact observer throws, without repeating notifications", async () => {
    await withAcceptanceFixture({}, async (fixture) => {
      const identity = vi.fn();
      fixture.observeIdentity(identity);
      enableLifecycleHooks();
      const accepted = await fixture.accept({
        onCommitted: () => {
          throw new Error("fact observer failed");
        },
      });
      expect(fixture.facts).toEqual([accepted]);
      expect(fixture.loadEntry()).toEqual(accepted.entry);
      expect(identity).toHaveBeenCalledOnce();
      expect(hooks.runSessionEnd).toHaveBeenCalledOnce();
      expect(hooks.runSessionStart).toHaveBeenCalledOnce();
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
    });
  });
});

describe("accepted successor lifecycle notifications", () => {
  it.each([false, true])(
    "publishes predecessor/successor payloads with a stable locator (legacy artifact=%s)",
    async (legacyArtifact) => {
      await withAcceptanceFixture({}, async (fixture) => {
        enableLifecycleHooks();
        const locator = legacyArtifact
          ? await fixture.writeLegacyArtifact()
          : `sqlite:${fixture.target.agentId}:${fixture.target.sessionId}:${fixture.target.storePath}`;
        await fixture.accept();
        expect(hooks.runSessionEnd).toHaveBeenCalledOnce();
        expect(hooks.runSessionStart).toHaveBeenCalledOnce();
        const [end, endContext] = hooks.runSessionEnd.mock.calls[0]!;
        const [start, startContext] = hooks.runSessionStart.mock.calls[0]!;
        expect(end).toMatchObject({
          sessionId: fixture.target.sessionId,
          sessionKey: fixture.target.sessionKey,
          reason: "compaction",
          sessionFile: locator,
          nextSessionId: fixture.successorId,
        });
        expect(end.transcriptArchived).toBe(legacyArtifact ? false : undefined);
        expect(start).toMatchObject({
          sessionId: fixture.successorId,
          sessionKey: fixture.target.sessionKey,
          resumedFrom: fixture.target.sessionId,
        });
        expect(endContext).toEqual({
          sessionId: fixture.target.sessionId,
          sessionKey: fixture.target.sessionKey,
          agentId: "main",
        });
        expect(startContext).toEqual({
          sessionId: fixture.successorId,
          sessionKey: fixture.target.sessionKey,
          agentId: "main",
        });
        await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
      });
    },
  );

  it.each([false, true])(
    "keeps both notification roots alive through settlement (restart draining=%s)",
    async (draining) => {
      await withAcceptanceFixture({}, async (fixture) => {
        enableLifecycleHooks();
        const endGate = createDeferred();
        const startGate = createDeferred();
        hooks.runSessionEnd.mockImplementationOnce(() => endGate.promise);
        hooks.runSessionStart.mockImplementationOnce(() => startGate.promise);
        const admission = draining ? tryBeginGatewayRootWorkAdmission() : null;
        try {
          if (draining) {
            expect(admission).not.toBeNull();
            await admission!.run(async () => {
              markGatewayRestartDraining();
              await fixture.accept();
              await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(3));
            });
            admission!.release();
          } else {
            await fixture.accept();
          }
          await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(2));
          expect(hooks.runSessionEnd).toHaveBeenCalledOnce();
          expect(hooks.runSessionStart).toHaveBeenCalledOnce();
          endGate.resolve();
          await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(1));
          startGate.resolve();
          await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
        } finally {
          admission?.release();
          endGate.resolve();
          startGate.resolve();
          await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
        }
      });
    },
  );
});
