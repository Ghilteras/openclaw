/** SQLite-backed Codex app-server thread bindings. */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  AgentHarnessPreflightError,
  AgentHarnessSessionSupersededError,
  embeddedAgentLog,
  type AgentHarnessContextEngineCompactionCommitMutation,
  type AgentHarnessSessionDeletionMutation,
  type EmbeddedRunAttemptParamsV2,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  ensureAuthProfileStore,
  resolveDefaultAgentDir,
  resolveProviderIdForAuth,
  type AuthProfileStore,
} from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { getSessionEntry, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { CODEX_PLUGIN_MARKETPLACE_NAME_PATTERN } from "./config-contracts.js";
import type { CodexManagedThreadStore } from "./managed-thread-store.js";
import type { PluginAppPolicyContext } from "./plugin-thread-config.js";
import {
  bindingStoreKey,
  inspectCodexSessionRuntimeOwnership,
  ownsStoredSessionGeneration,
  readCodexAppServerThreadBinding,
  readCodexBindingTimestamp,
  readCurrentCodexAppServerBinding,
  readStoredCodexAppServerBinding,
  readStoredCodexAppServerBindingValue,
  readStoredCodexAppServerCompactionTransition,
  stripUndefinedBinding,
  validateBindingForWrite,
  type CodexAppServerBindingIdentity,
  type CodexAppServerPendingSupervisionBranch,
  type CodexAppServerThreadBinding,
  type CodexSessionRuntimeOwnershipInspection,
  type StoredCodexAppServerBinding,
  type StoredCodexAppServerBindingV1,
  type StoredCodexAppServerCompactionTransition,
} from "./session-binding-record.js";
export {
  bindingStoreKey,
  readCodexAppServerThreadBinding,
  readStoredCodexAppServerBinding,
  readStoredCodexAppServerCompactionTransition,
  sessionBindingIdentity,
  validateBindingForWrite,
  type CodexAppServerBindingIdentity,
  type CodexAppServerContextEngineBinding,
  type CodexAppServerContextEngineProjectionBinding,
  type CodexAppServerPendingSupervisionBranch,
  type CodexAppServerThreadBinding,
  type StoredCodexAppServerBinding,
  type StoredCodexAppServerBindingV1,
  type StoredCodexAppServerCompactionTransition,
} from "./session-binding-record.js";

const CODEX_APP_SERVER_NATIVE_AUTH_PROVIDER = "openai";
const PUBLIC_OPENAI_MODEL_PROVIDER = "openai";
const BINDING_LEASE_RETRY_INTERVAL_MS = 1_000;
const BOUNDED_BINDING_FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/i;

export {
  CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
  CODEX_APP_SERVER_BINDING_NAMESPACE,
} from "./session-binding-meta.js";
export const CODEX_APP_SERVER_BINDING_GUARDED_REQUEST_TIMEOUT_MS = 60_000;
const BINDING_LEASE_STALE_MS = CODEX_APP_SERVER_BINDING_GUARDED_REQUEST_TIMEOUT_MS + 5_000;
const BINDING_LEASE_WAIT_MS = BINDING_LEASE_STALE_MS + 5_000;
const BINDING_LEASE_RENEW_INTERVAL_MS = Math.floor(BINDING_LEASE_STALE_MS / 3);
// Physical session keys cannot have a successor generation. Retain their
// retirement fence only long enough for bounded stale lease work to drain.
const PHYSICAL_SESSION_RETIRE_TTL_MS = BINDING_LEASE_WAIT_MS;

type ProviderAuthAliasLookupParams = Parameters<typeof resolveProviderIdForAuth>[1];
type ProviderAuthAliasConfig = NonNullable<ProviderAuthAliasLookupParams>["config"];

/** Inputs needed to resolve whether a binding's auth profile is native Codex/OpenAI auth. */
export type CodexAppServerAuthProfileLookup = {
  authProfileId?: string;
  authProfileStore?: AuthProfileStore;
  agentDir?: string;
  config?: ProviderAuthAliasConfig;
};

export type CodexRunSessionBindingAuthority = "current" | "ephemeral" | "superseded";

/** Decides whether a run may share the durable stable-key binding owner. */
export function resolveCodexRunSessionBindingAuthority(params: {
  identity: Extract<CodexAppServerBindingIdentity, { kind: "session" }>;
  config?: OpenClawConfig;
  storePath?: string;
}): CodexRunSessionBindingAuthority {
  const sessionKey = params.identity.sessionKey?.trim();
  if (!sessionKey) {
    return "ephemeral";
  }
  try {
    const storePath =
      params.storePath?.trim() ||
      resolveStorePath(params.config?.session?.store, { agentId: params.identity.agentId });
    const entry = getSessionEntry({
      agentId: params.identity.agentId,
      hydrateSkillPromptRefs: false,
      readConsistency: "latest",
      sessionKey,
      storePath,
    });
    if (!entry) {
      return "ephemeral";
    }
    return entry.sessionId === params.identity.sessionId ? "current" : "superseded";
  } catch {
    return "superseded";
  }
}

/** Builds the terminal coordination error used when a newer OpenClaw session owns the binding. */
export function createCodexSessionGenerationSupersededError(
  sessionId: string,
): AgentHarnessSessionSupersededError {
  return new AgentHarnessSessionSupersededError(
    `Codex session generation is no longer current: ${sessionId}`,
  );
}

export class CodexSupervisionBindingReplacementError extends Error {
  constructor(threadId: string, operation: string) {
    super(
      `Refusing to replace supervised Codex thread ${threadId} while ${operation}; ` +
        "its native user-home connection and model ownership must be preserved",
    );
    this.name = "CodexSupervisionBindingReplacementError";
  }
}

export function assertCodexBindingMayBeReplaced(
  binding: CodexAppServerThreadBinding | undefined,
  operation: string,
  expected?: EmbeddedRunAttemptParamsV2["expectedSessionRuntimeOwnership"],
): void {
  // A native-prepared attempt has no host-selected model for a replacement thread.
  if (expected) {
    throw new AgentHarnessPreflightError(
      `Codex native model ownership prevents ${operation}. Continue or compact the original session in its native runtime, or create a new chat with a concrete model; the original binding was preserved.`,
    );
  }
  if (binding?.connectionScope === "supervision") {
    throw new CodexSupervisionBindingReplacementError(binding.threadId, operation);
  }
}
type CodexAppServerBindingMutation =
  | {
      kind: "set";
      binding: CodexAppServerThreadBinding;
      if?: { kind: "absent" };
    }
  | {
      kind: "patch";
      threadId: string;
      patch: Partial<Omit<CodexAppServerThreadBinding, "threadId">>;
    }
  | {
      kind: "replace-thread";
      expectedThreadId: string;
      binding: CodexAppServerThreadBinding;
    }
  | {
      kind: "patch-pending-supervision-branch";
      expected: CodexAppServerPendingSupervisionBranch;
      pending: CodexAppServerPendingSupervisionBranch;
    }
  | {
      kind: "commit-pending-supervision-branch";
      expected: CodexAppServerPendingSupervisionBranch;
      threadId: string;
      patch: Partial<Omit<CodexAppServerThreadBinding, "threadId" | "pendingSupervisionBranch">>;
    }
  | {
      kind: "reclaim-generation";
      expectedPreviousSessionId: string;
    }
  | {
      kind: "clear";
      threadId?: string;
    };

export type CodexSessionGenerationRetirementResult = "applied" | "absent" | "conflict";

export type CodexSessionGenerationReclaimPlan =
  | { kind: "resolved"; result: boolean }
  | { kind: "verify"; expectedPreviousSessionId: string }
  | {
      kind: "reconcile-compaction";
      transitionId: string;
      previousSessionId: string;
      sessionId: string;
    };

export function hashCodexAppServerBindingFingerprint(canonical: string): string {
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function normalizeLegacyBindingFingerprint(value: unknown): unknown {
  if (
    typeof value !== "string" ||
    value === "" ||
    value === "[]" ||
    BOUNDED_BINDING_FINGERPRINT_PATTERN.test(value)
  ) {
    return value;
  }
  return hashCodexAppServerBindingFingerprint(value);
}

function normalizeLegacyBindingFingerprints<
  T extends {
    dynamicToolsFingerprint?: unknown;
    userMcpServersFingerprint?: unknown;
  },
>(record: T): T {
  // Shipped sidecars can contain unbounded canonical JSON fingerprints. Bound
  // them at the legacy encoder so plugin-state registration cannot reject the row.
  let normalized = record;
  for (const key of ["dynamicToolsFingerprint", "userMcpServersFingerprint"] as const) {
    const value = record[key];
    const next = normalizeLegacyBindingFingerprint(value);
    if (next === value) {
      continue;
    }
    if (normalized === record) {
      normalized = { ...record };
    }
    Object.assign(normalized, { [key]: next });
  }
  return normalized;
}

export function normalizeStoredCodexAppServerBindingFingerprints(
  value: unknown,
): StoredCodexAppServerBindingV1 | undefined {
  const stored = readStoredCodexAppServerBinding(value);
  if (!stored || stored.state !== "active") {
    return stored;
  }
  const binding = normalizeLegacyBindingFingerprints(stored.binding);
  return binding === stored.binding
    ? stored
    : readStoredCodexAppServerBinding({ ...stored, binding });
}

/** Encodes a migrated sidecar binding as one canonical plugin-state row. */
export function createStoredCodexAppServerBinding(
  value: unknown,
  options: {
    now?: string;
    lookup?: Omit<CodexAppServerAuthProfileLookup, "authProfileId">;
  } = {},
): Extract<StoredCodexAppServerBinding, { state: "active" }> | undefined {
  const rawRecord = asOptionalRecord(value);
  if (!rawRecord) {
    return undefined;
  }
  const record = normalizeLegacyBindingFingerprints(rawRecord);
  if (record.schemaVersion !== 1 && record.schemaVersion !== 2) {
    return undefined;
  }
  const pluginAppPolicyContext = readPluginAppPolicyContext(
    record.pluginAppPolicyContext,
    record.schemaVersion,
  );
  const historyCoveredThrough =
    readCodexBindingTimestamp(record.historyCoveredThrough) ??
    readCodexBindingTimestamp(record.updatedAt) ??
    readCodexBindingTimestamp(record.createdAt) ??
    readCodexBindingTimestamp(options.now) ??
    new Date().toISOString();
  const authProfileId = typeof record.authProfileId === "string" ? record.authProfileId : undefined;
  const binding = readCodexAppServerThreadBinding({
    ...record,
    modelProvider: normalizeCodexAppServerBindingModelProvider({
      ...options.lookup,
      authProfileId,
      modelProvider: typeof record.modelProvider === "string" ? record.modelProvider : undefined,
    }),
    cwd: typeof record.cwd === "string" ? record.cwd : "",
    pluginAppPolicyContext,
    historyCoveredThrough,
  });
  return binding
    ? {
        version: 1,
        state: "active",
        binding: stripUndefinedBinding(binding),
      }
    : undefined;
}

type BindingStateStore = Pick<
  PluginStateSyncKeyedStore<StoredCodexAppServerBinding>,
  "deleteIf" | "entries" | "lookup" | "registerIfAbsent" | "update"
>;

type BindingLeaseOwner = {
  token: string;
  phase: "held" | "transition" | "deleted" | "closed";
  failure?: Error;
  assertCurrent?: () => void;
  transition?: StoredCodexAppServerCompactionTransition;
};

function bindingLeaseLostError(key: string, cause?: unknown): Error {
  return new Error(`Lost Codex binding lease: ${key}`, cause === undefined ? undefined : { cause });
}

function unresolvedCompactionTransitionError(key: string): Error {
  return new Error(`Codex binding compaction transition is unresolved: ${key}`);
}

function readBindingValueOrThrow(
  raw: unknown,
  key: string,
): StoredCodexAppServerBinding | undefined {
  const current = readStoredCodexAppServerBindingValue(raw);
  if (raw !== undefined && !current) {
    throw new Error(`Invalid Codex app-server binding row: ${key}`);
  }
  return current;
}

function readNormalBindingOrThrow(
  raw: unknown,
  key: string,
): StoredCodexAppServerBindingV1 | undefined {
  const current = readStoredCodexAppServerBinding(raw);
  if (raw !== undefined && !current) {
    if (readStoredCodexAppServerCompactionTransition(raw)) {
      throw unresolvedCompactionTransitionError(key);
    }
    throw new Error(`Invalid Codex app-server binding row: ${key}`);
  }
  return current;
}

function activeBindingFromStoredValue(
  value: StoredCodexAppServerBinding,
): Extract<StoredCodexAppServerBindingV1, { state: "active" }> | undefined {
  if (value.state === "active") {
    return value;
  }
  return value.state === "compaction-transition" && value.previous.kind === "active"
    ? value.previous.value
    : undefined;
}

type BindingLease = { token: string; expiresAt: number };

function withStoredBindingLease(
  value: StoredCodexAppServerBinding,
  lease: BindingLease | undefined,
): StoredCodexAppServerBinding {
  const { lease: _lease, ...withoutLease } = value;
  if (value.state !== "compaction-transition") {
    // SAFETY: The discriminant excludes transition rows; replacing only the optional lease preserves V1.
    return { ...withoutLease, ...(lease ? { lease } : {}) } as StoredCodexAppServerBindingV1;
  }
  const previous =
    value.previous.kind === "active"
      ? (() => {
          const { lease: _previousLease, ...previousWithoutLease } = value.previous.value;
          return {
            kind: "active" as const,
            value: {
              ...previousWithoutLease,
              ...(lease ? { lease } : {}),
            },
          };
        })()
      : value.previous;
  return {
    ...withoutLease,
    previous,
    ...(lease ? { lease } : {}),
    // SAFETY: The transition discriminant and validated predecessor shape are preserved while leases change.
  } as StoredCodexAppServerCompactionTransition;
}

function restoreCompactionTransition(
  transition: StoredCodexAppServerCompactionTransition,
): StoredCodexAppServerBindingV1 | undefined {
  return transition.previous.kind === "active" ? transition.previous.value : undefined;
}

function completeCompactionTransition(
  transition: StoredCodexAppServerCompactionTransition,
): StoredCodexAppServerBindingV1 | undefined {
  if (transition.previous.kind !== "active") {
    return undefined;
  }
  return {
    ...transition.previous.value,
    sessionId: transition.toSessionId,
    binding: {
      ...transition.previous.value.binding,
      nativeCompactionSyncPending: transition.nativeCompactionSyncPending,
    },
  };
}

export type CodexAppServerBindingStore = {
  /** Durable ownership rows kept separate from replaceable session bindings. */
  managedThreads?: CodexManagedThreadStore;
  read(identity: CodexAppServerBindingIdentity): CodexAppServerThreadBinding | undefined;
  inspectSessionRuntimeOwnership(
    identity: Extract<CodexAppServerBindingIdentity, { kind: "session" }>,
  ): CodexSessionRuntimeOwnershipInspection | undefined;
  hasOtherThreadOwner(
    threadId: string,
    currentIdentity?: CodexAppServerBindingIdentity,
  ): Promise<boolean>;
  mutate(
    identity: CodexAppServerBindingIdentity,
    mutation: CodexAppServerBindingMutation,
    assertCurrent?: () => void,
  ): Promise<boolean>;
  prepareSessionGenerationReclaim(
    identity: Extract<CodexAppServerBindingIdentity, { kind: "session" }>,
  ): Promise<CodexSessionGenerationReclaimPlan>;
  reconcileCompactionSuccessor(
    identity: Extract<CodexAppServerBindingIdentity, { kind: "session" }>,
    transitionId: string,
    readHost: () => { sessionId?: string; previousSessionId?: string } | undefined,
    assertCurrent?: () => void,
  ): Promise<boolean>;
  withContextEngineCompactionCommit<T>(
    identity: Extract<CodexAppServerBindingIdentity, { kind: "session" }>,
    previousSessionId: string,
    assertCurrent: () => void,
    run: (mutation: AgentHarnessContextEngineCompactionCommitMutation) => Promise<T>,
  ): Promise<T>;
  resetSessionGeneration(
    identity: Extract<CodexAppServerBindingIdentity, { kind: "session" }>,
  ): Promise<CodexSessionGenerationRetirementResult>;
  retireSessionGeneration(
    identity: Extract<CodexAppServerBindingIdentity, { kind: "session" }>,
  ): Promise<CodexSessionGenerationRetirementResult>;
  withSessionDeletion<T>(
    identity: Extract<CodexAppServerBindingIdentity, { kind: "session" }>,
    assertCurrent: () => void,
    run: (
      binding: CodexAppServerThreadBinding | undefined,
      mutation: AgentHarnessSessionDeletionMutation,
    ) => Promise<T>,
  ): Promise<T>;
  withThreadArchiveFence<T>(run: () => Promise<T>): Promise<T>;
  withLease<T>(identity: CodexAppServerBindingIdentity, run: () => Promise<T>): Promise<T>;
};

/** Carries one prepared run identity through callers that rederive it from public params. */
export function scopeCodexRunBindingStore(params: {
  bindingStore: CodexAppServerBindingStore;
  logicalIdentity: Extract<CodexAppServerBindingIdentity, { kind: "session" }>;
  physicalIdentity: Extract<CodexAppServerBindingIdentity, { kind: "session" }>;
}): CodexAppServerBindingStore {
  const mapSessionIdentity = (
    identity: Extract<CodexAppServerBindingIdentity, { kind: "session" }>,
  ) =>
    identity.agentId === params.logicalIdentity.agentId &&
    identity.sessionId === params.logicalIdentity.sessionId &&
    identity.sessionKey?.trim() === params.logicalIdentity.sessionKey?.trim()
      ? params.physicalIdentity
      : identity;
  const mapIdentity = (identity: CodexAppServerBindingIdentity) =>
    identity.kind === "session" ? mapSessionIdentity(identity) : identity;
  return {
    ...params.bindingStore,
    read: (identity) => params.bindingStore.read(mapIdentity(identity)),
    inspectSessionRuntimeOwnership: (identity) =>
      params.bindingStore.inspectSessionRuntimeOwnership(mapSessionIdentity(identity)),
    hasOtherThreadOwner: (threadId, identity) =>
      params.bindingStore.hasOtherThreadOwner(
        threadId,
        identity ? mapIdentity(identity) : undefined,
      ),
    mutate: (identity, mutation, assertCurrent) =>
      params.bindingStore.mutate(mapIdentity(identity), mutation, assertCurrent),
    prepareSessionGenerationReclaim: (identity) =>
      params.bindingStore.prepareSessionGenerationReclaim(mapSessionIdentity(identity)),
    reconcileCompactionSuccessor: (identity, transitionId, readHost, assertCurrent) =>
      params.bindingStore.reconcileCompactionSuccessor(
        mapSessionIdentity(identity),
        transitionId,
        readHost,
        assertCurrent,
      ),
    withContextEngineCompactionCommit: (identity, previousSessionId, assertCurrent, run) =>
      params.bindingStore.withContextEngineCompactionCommit(
        mapSessionIdentity(identity),
        previousSessionId,
        assertCurrent,
        run,
      ),
    resetSessionGeneration: (identity) =>
      params.bindingStore.resetSessionGeneration(mapSessionIdentity(identity)),
    retireSessionGeneration: (identity) =>
      params.bindingStore.retireSessionGeneration(mapSessionIdentity(identity)),
    withSessionDeletion: (identity, assertCurrent, run) =>
      params.bindingStore.withSessionDeletion(mapSessionIdentity(identity), assertCurrent, run),
    withThreadArchiveFence: (run) => params.bindingStore.withThreadArchiveFence(run),
    withLease: (identity, run) => params.bindingStore.withLease(mapIdentity(identity), run),
  };
}

/** Lets the authoritative OpenClaw session generation claim a stale stable binding row. */
export async function reclaimCurrentCodexSessionGeneration(params: {
  assertCurrent?: () => void;
  bindingStore: CodexAppServerBindingStore;
  identity: Extract<CodexAppServerBindingIdentity, { kind: "session" }>;
  config?: OpenClawConfig;
  storePath?: string;
}): Promise<boolean> {
  params.assertCurrent?.();
  const sessionKey = params.identity.sessionKey?.trim();
  if (!sessionKey) {
    return true;
  }
  const readHostEntry = () => {
    const storePath =
      params.storePath?.trim() ||
      resolveStorePath(params.config?.session?.store, { agentId: params.identity.agentId });
    return getSessionEntry({
      agentId: params.identity.agentId,
      hydrateSkillPromptRefs: false,
      readConsistency: "latest",
      sessionKey,
      storePath,
    });
  };
  while (true) {
    const plan = await params.bindingStore.prepareSessionGenerationReclaim(params.identity);
    params.assertCurrent?.();
    if (plan.kind === "resolved") {
      return plan.result;
    }

    if (plan.kind === "reconcile-compaction") {
      const reconciled = await params.bindingStore.reconcileCompactionSuccessor(
        params.identity,
        plan.transitionId,
        () => {
          try {
            const entry = readHostEntry();
            return entry
              ? {
                  sessionId: entry.sessionId,
                  previousSessionId: entry.previousSessionId,
                }
              : undefined;
          } catch {
            return undefined;
          }
        },
        params.assertCurrent,
      );
      if (!reconciled) {
        return false;
      }
      continue;
    }
    let entry: ReturnType<typeof readHostEntry>;
    try {
      entry = readHostEntry();
    } catch {
      return false;
    }
    params.assertCurrent?.();
    if (entry?.sessionId !== params.identity.sessionId) {
      return false;
    }
    return await params.bindingStore.mutate(
      params.identity,
      {
        kind: "reclaim-generation",
        expectedPreviousSessionId: plan.expectedPreviousSessionId,
      },
      params.assertCurrent,
    );
  }
}

/** Creates the single binding facade owned by the Codex plugin runtime. */
export function createCodexAppServerBindingStore(
  state: BindingStateStore,
): CodexAppServerBindingStore {
  const update = state.update?.bind(state);
  if (!update) {
    throw new Error("Codex app-server bindings require atomic plugin-state updates");
  }
  const leaseContext = new AsyncLocalStorage<Map<string, BindingLeaseOwner>>();
  const archiveContext = new AsyncLocalStorage<boolean>();
  let activeBindingMutations = 0;
  let pendingArchives = 0;
  let archiveTail = Promise.resolve();
  let bindingMutationsDrained: (() => void)[] = [];

  const waitForBindingMutations = async (): Promise<void> => {
    if (activeBindingMutations === 0) {
      return;
    }
    await new Promise<void>((resolve) => {
      bindingMutationsDrained.push(resolve);
    });
  };

  const runBindingMutation = async <T>(run: () => Promise<T>): Promise<T> => {
    if (archiveContext.getStore() === true) {
      return await run();
    }
    // Archive validates the complete native subtree against one stable ownership
    // snapshot. Reject late mutations so a stale caller cannot attach after archive.
    if (pendingArchives > 0) {
      throw new Error(
        "Codex binding mutation blocked while a native archive is in progress; retry",
      );
    }
    activeBindingMutations += 1;
    try {
      return await run();
    } finally {
      activeBindingMutations -= 1;
      if (activeBindingMutations === 0) {
        const drained = bindingMutationsDrained;
        bindingMutationsDrained = [];
        for (const resolve of drained) {
          resolve();
        }
      }
    }
  };

  const renewLease = (key: string, owner: BindingLeaseOwner): void => {
    if (owner.failure || (owner.phase !== "held" && owner.phase !== "transition")) {
      return;
    }
    try {
      let renewed = false;
      let renewedTransition: StoredCodexAppServerCompactionTransition | undefined;
      owner.assertCurrent?.();
      const stored = update(key, (raw) => {
        owner.assertCurrent?.();
        const current = readBindingValueOrThrow(raw, key);
        const lease = current?.lease;
        const now = Date.now();
        if (
          !lease ||
          lease.token !== owner.token ||
          lease.expiresAt <= now ||
          (owner.phase === "transition" &&
            (!owner.transition ||
              current?.state !== "compaction-transition" ||
              !isDeepStrictEqual(
                withStoredBindingLease(current, owner.transition.lease),
                owner.transition,
              )))
        ) {
          return undefined;
        }
        renewed = true;
        const next = withStoredBindingLease(current, {
          token: owner.token,
          expiresAt: now + BINDING_LEASE_STALE_MS,
        });
        if (next.state === "compaction-transition") {
          renewedTransition = next;
        }
        return next;
      });
      if (!renewed || !stored) {
        owner.failure = bindingLeaseLostError(key);
      } else if (renewedTransition) {
        owner.transition = renewedTransition;
      }
    } catch (error) {
      owner.failure = bindingLeaseLostError(key, error);
    }
  };

  const transactKey = async <T>(
    key: string,
    apply: (
      current: StoredCodexAppServerBindingV1 | undefined,
      leaseToken?: string,
    ) => {
      next?: StoredCodexAppServerBindingV1;
      result: T;
    },
    ttlMs?: number,
    assertCurrent?: () => void,
  ): Promise<T> => {
    const deadline = Date.now() + BINDING_LEASE_WAIT_MS;
    while (true) {
      let busy = false;
      let leaseLost = false;
      let result!: T;
      const ownedLease = leaseContext.getStore()?.get(key);
      if (ownedLease && ownedLease.phase !== "held") {
        throw bindingLeaseLostError(key);
      }
      if (ownedLease?.failure) {
        throw ownedLease.failure;
      }
      const ownedToken = ownedLease?.token;
      assertCurrent?.();
      ownedLease?.assertCurrent?.();
      update(
        key,
        (raw) => {
          assertCurrent?.();
          ownedLease?.assertCurrent?.();
          const current = readNormalBindingOrThrow(raw, key);
          const activeLease = current?.lease;
          const now = Date.now();
          if (
            ownedToken &&
            (!activeLease || activeLease.token !== ownedToken || activeLease.expiresAt <= now)
          ) {
            leaseLost = true;
            return undefined;
          }
          if (activeLease && activeLease.token !== ownedToken && activeLease.expiresAt > now) {
            busy = true;
            return undefined;
          }
          const applied = apply(current, ownedToken);
          result = applied.result;
          return applied.next;
        },
        ttlMs == null ? undefined : { ttlMs },
      );
      if (leaseLost) {
        const failure = bindingLeaseLostError(key);
        if (ownedLease) {
          ownedLease.failure = failure;
        }
        throw failure;
      }
      if (!busy) {
        return result;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for Codex binding lease: ${key}`);
      }
      await sleep(BINDING_LEASE_RETRY_INTERVAL_MS);
    }
  };

  const withBindingLease = async <T>(
    identity: CodexAppServerBindingIdentity,
    run: () => Promise<T>,
    options: { allowRetired?: boolean; assertCurrent?: () => void } = {},
  ): Promise<T> => {
    options.assertCurrent?.();
    const key = bindingStoreKey(identity);
    const owned = leaseContext.getStore();
    const existingOwner = owned?.get(key);
    if (existingOwner) {
      if (existingOwner.phase !== "held") {
        throw bindingLeaseLostError(key);
      }
      const failureBeforeRun = existingOwner.failure;
      if (failureBeforeRun) {
        throw failureBeforeRun;
      }
      const result = await run();
      options.assertCurrent?.();
      const failureAfterRun = existingOwner.failure;
      if (failureAfterRun) {
        throw failureAfterRun;
      }
      return result;
    }
    const token = randomUUID();
    const acquired = await transactKey(
      key,
      (current) => {
        if (
          current?.state === "cleared" &&
          current.retired === true &&
          ownsStoredSessionGeneration(identity, current) &&
          !options.allowRetired
        ) {
          return { result: false };
        }
        const lease = { token, expiresAt: Date.now() + BINDING_LEASE_STALE_MS };
        if (current?.state === "active") {
          return {
            result: true,
            next: { ...current, ...preservedSessionGeneration(identity, current), lease },
          };
        }
        if (current?.state === "cleared" && current.retired === true) {
          return { result: true, next: { ...current, lease } };
        }
        return {
          result: true,
          next: {
            version: 1,
            state: "cleared",
            ...preservedSessionGeneration(identity, current),
            lease,
          },
        };
      },
      undefined,
      options.assertCurrent,
    );
    options.assertCurrent?.();
    if (!acquired) {
      throw new Error(`Codex binding generation was retired: ${key}`);
    }
    const owner: BindingLeaseOwner = { token, phase: "held", assertCurrent: options.assertCurrent };
    const nested = new Map(owned);
    nested.set(key, owner);
    // Long app-server RPCs can outlive the stale-owner window. Renew with an
    // exact-token CAS so live work stays serialized while a replaced owner remains fenced.
    const heartbeat = setInterval(() => renewLease(key, owner), BINDING_LEASE_RENEW_INTERVAL_MS);
    heartbeat.unref();
    try {
      const result = await leaseContext.run(nested, run);
      options.assertCurrent?.();
      if (owner.failure) {
        throw owner.failure;
      }
      return result;
    } finally {
      clearInterval(heartbeat);
      owner.phase = "closed";
      options.assertCurrent?.();
      try {
        const current = readBindingValueOrThrow(state.lookup(key), key);
        if (current?.lease?.token === token) {
          const ttlMs =
            current.state === "compaction-transition" ||
            current.state === "active" ||
            (current.state === "cleared" &&
              current.retired === true &&
              !key.startsWith("session:"))
              ? undefined
              : current.state === "cleared" && current.retired === true
                ? PHYSICAL_SESSION_RETIRE_TTL_MS
                : 1;
          options.assertCurrent?.();
          update(
            key,
            (raw) => {
              options.assertCurrent?.();
              const stored = readBindingValueOrThrow(raw, key);
              if (stored?.lease?.token !== token) {
                return undefined;
              }
              return withStoredBindingLease(stored, undefined);
            },
            ttlMs === undefined ? undefined : { ttlMs },
          );
        }
      } catch (error) {
        options.assertCurrent?.();
        // A crashed owner leaves only its bounded lease for recovery.
        embeddedAgentLog.warn("failed to release codex app-server binding lease", { key, error });
      }
    }
  };

  const transitionSessionGeneration = async (
    identity: Extract<CodexAppServerBindingIdentity, { kind: "session" }>,
    mode: "reset" | "retire",
  ): Promise<CodexSessionGenerationRetirementResult> => {
    return await runBindingMutation(async () => {
      const key = bindingStoreKey(identity);
      const ttlMs =
        mode === "reset"
          ? leaseContext.getStore()?.has(key)
            ? undefined
            : 1
          : identity.sessionKey?.trim()
            ? undefined
            : PHYSICAL_SESSION_RETIRE_TTL_MS;
      return await transactKey(
        key,
        (current, leaseToken) => {
          if (!current) {
            return { result: "absent" as const };
          }
          if (!ownsStoredSessionGeneration(identity, current)) {
            return { result: "conflict" as const };
          }
          // Retirement is idempotent, but reset cannot clear a same-id deletion fence.
          // Only the authoritative session-store reclaim path can prove an in-place reset.
          if (current.state === "cleared" && current.retired === true) {
            return { result: mode === "retire" ? ("applied" as const) : ("conflict" as const) };
          }
          return {
            result: "applied" as const,
            next: {
              version: 1,
              state: "cleared",
              ...(mode === "retire" ? { retired: true as const } : {}),
              ...storedSessionGeneration(identity, current),
              ...(current.lease && current.lease.token === leaseToken
                ? { lease: current.lease }
                : {}),
            },
          };
        },
        ttlMs,
      );
    });
  };

  return {
    read: (identity) => readCurrentCodexAppServerBinding(state, identity),
    inspectSessionRuntimeOwnership: (identity) =>
      inspectCodexSessionRuntimeOwnership(state, identity),

    async hasOtherThreadOwner(threadId, currentIdentity) {
      const currentKey = currentIdentity ? bindingStoreKey(currentIdentity) : undefined;
      return state.entries().some(({ key, value }) => {
        const stored = readBindingValueOrThrow(value, key)!;
        const active = activeBindingFromStoredValue(stored);
        const ownerSessionId =
          stored.state === "compaction-transition" ? stored.fromSessionId : stored.sessionId;
        const isCurrentOwner =
          currentIdentity !== undefined &&
          key === currentKey &&
          (currentIdentity.kind === "conversation" ||
            ownerSessionId === currentIdentity.sessionId.trim());
        if (!active || active.binding.threadId !== threadId || isCurrentOwner) {
          return false;
        }
        return true;
      });
    },

    async prepareSessionGenerationReclaim(identity) {
      const key = bindingStoreKey(identity);
      const current = readBindingValueOrThrow(state.lookup(key), key);
      if (current?.state === "compaction-transition") {
        return {
          kind: "reconcile-compaction",
          transitionId: current.transitionId,
          previousSessionId: current.fromSessionId,
          sessionId: current.toSessionId,
        };
      }
      if (!current) {
        return { kind: "resolved", result: true };
      }
      const currentSessionId = current.sessionId;
      if (!currentSessionId) {
        return {
          kind: "resolved",
          result: current.state !== "cleared" || current.retired !== true,
        };
      }
      if (currentSessionId === identity.sessionId) {
        return current.state === "cleared" && current.retired === true
          ? { kind: "verify", expectedPreviousSessionId: currentSessionId }
          : { kind: "resolved", result: true };
      }
      return { kind: "verify", expectedPreviousSessionId: currentSessionId };
    },

    async mutate(identity, mutation, assertCurrent) {
      return await runBindingMutation(async () => {
        const key = bindingStoreKey(identity);
        // A retained legacy sidecar may be revisited by doctor after runtime
        // clear. Keep provenance so migration cannot resurrect its stale thread.
        const retainLegacyClear =
          mutation.kind === "clear" && key.startsWith("conversation:legacy-");
        return await transactKey(
          key,
          (current, leaseToken) => {
            const ownsGeneration = ownsStoredSessionGeneration(identity, current);
            const ownedLease =
              current?.lease && current.lease.token === leaseToken ? { lease: current.lease } : {};
            if (mutation.kind === "reclaim-generation") {
              if (identity.kind !== "session" || !identity.sessionKey?.trim()) {
                return { result: false };
              }
              if (!current) {
                return { result: true };
              }
              if (ownsGeneration) {
                if (
                  current.state === "cleared" &&
                  current.retired === true &&
                  current.sessionId === mutation.expectedPreviousSessionId
                ) {
                  // Reset boundaries now retain the OpenClaw session id. The
                  // authoritative session-store check above proves this fence
                  // belongs to the previous in-place lifecycle, not live work.
                  return {
                    result: true,
                    next: {
                      version: 1,
                      state: "cleared",
                      sessionId: identity.sessionId,
                      ...ownedLease,
                    },
                  };
                }
                return {
                  result: current.state !== "cleared" || current.retired !== true,
                };
              }
              if (current.sessionId !== mutation.expectedPreviousSessionId) {
                return { result: false };
              }
              // A stale physical generation must never turn private user-home ownership into
              // an ordinary empty binding. Supervision adoption has an explicit generation
              // transfer path; every other successor fails closed and preserves this owner.
              if (current.state === "active" && current.binding.connectionScope === "supervision") {
                return { result: false };
              }
              return {
                result: true,
                next: {
                  version: 1,
                  state: "cleared",
                  sessionId: identity.sessionId,
                  ...ownedLease,
                },
              };
            }
            const storedActive = current?.state === "active" ? current : undefined;
            const active = ownsGeneration ? storedActive : undefined;
            const retiredGeneration =
              current?.state === "cleared" && current.retired === true && ownsGeneration;
            const preservesSupervisionOwner =
              mutation.kind === "set" &&
              active?.binding.connectionScope === "supervision" &&
              isSameSupervisionOwner(active.binding, mutation.binding);
            const replacesExpectedOrdinaryOwner =
              mutation.kind === "replace-thread" &&
              active?.binding.threadId === mutation.expectedThreadId &&
              active.binding.connectionScope !== "supervision" &&
              mutation.binding.connectionScope !== "supervision" &&
              mutation.binding.threadId !== mutation.expectedThreadId;
            if (
              (mutation.kind === "set" &&
                ((mutation.if?.kind === "absent" && storedActive) ||
                  (current !== undefined && !ownsGeneration) ||
                  retiredGeneration ||
                  (active?.binding.connectionScope === "supervision" &&
                    !preservesSupervisionOwner))) ||
              (mutation.kind === "patch" && active?.binding.threadId !== mutation.threadId) ||
              (mutation.kind === "replace-thread" && !replacesExpectedOrdinaryOwner) ||
              ((mutation.kind === "patch-pending-supervision-branch" ||
                mutation.kind === "commit-pending-supervision-branch") &&
                !matchesPendingSupervisionBranch(active?.binding, mutation.expected)) ||
              (mutation.kind === "clear" &&
                (!ownsGeneration ||
                  (mutation.threadId !== undefined &&
                    active?.binding.threadId !== mutation.threadId) ||
                  active?.binding.connectionScope === "supervision"))
            ) {
              return { result: false };
            }
            if (mutation.kind === "clear" && retiredGeneration) {
              return { result: true };
            }
            if (mutation.kind === "clear") {
              return {
                result: true,
                next: {
                  version: 1,
                  state: "cleared",
                  ...storedSessionGeneration(identity, current),
                  ...ownedLease,
                },
              };
            }
            let binding: CodexAppServerThreadBinding;
            if (mutation.kind === "set" || mutation.kind === "replace-thread") {
              binding = validateBindingForWrite(mutation.binding);
            } else if (mutation.kind === "patch-pending-supervision-branch") {
              binding = validateBindingForWrite({
                ...active!.binding,
                pendingSupervisionBranch: mutation.pending,
              });
            } else if (mutation.kind === "commit-pending-supervision-branch") {
              binding = validateBindingForWrite({
                ...active!.binding,
                ...mutation.patch,
                threadId: mutation.threadId,
                pendingSupervisionBranch: undefined,
              });
            } else {
              binding = validateBindingForWrite({
                ...active!.binding,
                ...mutation.patch,
                threadId: mutation.threadId,
              });
            }
            if (active && binding.threadId !== active.binding.threadId) {
              const { nativeCompactionSyncPending: _pending, ...replacement } = binding;
              binding = replacement;
            }
            return {
              result: true,
              next: {
                version: 1,
                state: "active",
                binding,
                ...storedSessionGeneration(identity, current),
                ...ownedLease,
              },
            };
          },
          // Plain clears may expire immediately: a stale generation that re-sets
          // the key afterwards is fenced by ownsStoredSessionGeneration on read
          // and displaced via reclaim-generation; durable stable-key fences come
          // from retireSessionGeneration, not runtime clears.
          mutation.kind === "clear" && !retainLegacyClear && !leaseContext.getStore()?.has(key)
            ? 1
            : undefined,
          assertCurrent,
        );
      });
    },

    async reconcileCompactionSuccessor(identity, transitionId, readHost, assertCurrent) {
      return await runBindingMutation(async () => {
        const key = bindingStoreKey(identity);
        const sessionId = identity.sessionId.trim();
        const deadline = Date.now() + BINDING_LEASE_WAIT_MS;
        const token = randomUUID();
        let current: StoredCodexAppServerCompactionTransition;
        // Another process can see host P while the live owner has staged v2 just
        // before COMMIT. Recovery must acquire the marker lease before deciding P or S.
        while (true) {
          let outcome: "acquired" | "busy" | "conflict" | "resolved" = "resolved";
          let acquired: StoredCodexAppServerCompactionTransition | undefined;
          assertCurrent?.();
          const updated = update(key, (raw) => {
            assertCurrent?.();
            const stored = readBindingValueOrThrow(raw, key);
            if (!stored || stored.state !== "compaction-transition") {
              outcome = "resolved";
              return undefined;
            }
            if (
              stored.transitionId !== transitionId ||
              (sessionId !== stored.fromSessionId && sessionId !== stored.toSessionId)
            ) {
              outcome = "conflict";
              return undefined;
            }
            const now = Date.now();
            if (stored.lease && stored.lease.expiresAt > now) {
              outcome = "busy";
              return undefined;
            }
            outcome = "acquired";
            acquired = withStoredBindingLease(stored, {
              token,
              expiresAt: now + BINDING_LEASE_STALE_MS,
              // SAFETY: The preceding state guard narrowed stored to a transition, and lease replacement preserves it.
            }) as StoredCodexAppServerCompactionTransition;
            return acquired;
          });
          if (outcome === "resolved") {
            return true;
          }
          if (outcome === "conflict") {
            return false;
          }
          if (outcome === "acquired") {
            if (!updated || !acquired) {
              throw bindingLeaseLostError(key);
            }
            current = acquired;
            break;
          }
          if (Date.now() >= deadline) {
            return false;
          }
          await sleep(BINDING_LEASE_RETRY_INTERVAL_MS);
        }
        // The host snapshot must follow marker-lease acquisition. Reading it before
        // a wait could retain P after the live owner commits S and then exits.
        assertCurrent?.();
        const host = readHost();
        assertCurrent?.();
        const resolution =
          host?.sessionId === current.fromSessionId
            ? { resolved: true as const, next: restoreCompactionTransition(current) }
            : host?.sessionId === current.toSessionId &&
                host.previousSessionId === current.fromSessionId
              ? { resolved: true as const, next: completeCompactionTransition(current) }
              : { resolved: false as const };
        assertCurrent?.();
        let applied = false;
        if (!resolution.resolved || resolution.next) {
          const replacement = !resolution.resolved
            ? (withStoredBindingLease(
                current,
                undefined,
                // SAFETY: Current is a parsed transition row, and removing its optional lease preserves that variant.
              ) as StoredCodexAppServerCompactionTransition)
            : (withStoredBindingLease(
                resolution.next,
                undefined,
                // SAFETY: A resolved next row is V1, and removing its optional lease preserves that variant.
              ) as StoredCodexAppServerBindingV1);
          let matched = false;
          const updated = update(key, (raw) => {
            assertCurrent?.();
            if (!isDeepStrictEqual(raw, current)) {
              return undefined;
            }
            matched = true;
            return replacement;
          });
          applied = matched && updated;
        } else {
          const deleteIf = state.deleteIf?.bind(state);
          if (!deleteIf) {
            throw new Error("Codex compaction reconciliation requires conditional deletion");
          }
          applied = deleteIf(key, (raw) => {
            assertCurrent?.();
            return isDeepStrictEqual(raw, current);
          });
        }
        if (!applied) {
          throw new Error("Codex binding changed during compaction transition reconciliation");
        }
        return resolution.resolved;
      });
    },

    async withContextEngineCompactionCommit(identity, previousSessionId, assertCurrent, run) {
      return await runBindingMutation(async () => {
        const key = bindingStoreKey(identity);
        const fromSessionId = previousSessionId.trim();
        const toSessionId = identity.sessionId.trim();
        if (!identity.sessionKey?.trim()) {
          throw new Error("Codex context-engine compaction commit requires a stable session key");
        }
        if (!fromSessionId) {
          throw new Error("Codex context-engine compaction commit requires a session generation");
        }
        assertCurrent();
        const initial = readBindingValueOrThrow(state.lookup(key), key);
        if (initial?.state === "compaction-transition") {
          throw unresolvedCompactionTransitionError(key);
        }
        if (
          initial &&
          (initial.state !== "active" || initial.sessionId !== fromSessionId)
        ) {
          throw new Error("Codex binding changed before compaction transition preparation");
        }
        const previousIdentity = { ...identity, sessionId: fromSessionId };
        return await withBindingLease(
          previousIdentity,
          async () => {
            const owner = leaseContext.getStore()!.get(key)!;
            const leased = readNormalBindingOrThrow(state.lookup(key), key);
            const lease = leased?.lease;
            if (!leased || !lease || lease.token !== owner.token || lease.expiresAt <= Date.now()) {
              throw bindingLeaseLostError(key);
            }
            const replaceExact = (
              expected: StoredCodexAppServerBinding,
              next: StoredCodexAppServerBinding | undefined,
              operation: string,
            ) => {
              assertCurrent();
              if (owner.phase === "closed" || owner.failure) {
                throw owner.failure ?? bindingLeaseLostError(key);
              }
              let applied = false;
              if (next) {
                let matched = false;
                const updated = update(key, (raw) => {
                  assertCurrent();
                  if (!isDeepStrictEqual(raw, expected)) {
                    return undefined;
                  }
                  matched = true;
                  return next;
                });
                applied = matched && updated;
              } else {
                const deleteIf = state.deleteIf?.bind(state);
                if (!deleteIf) {
                  throw new Error(`${operation} requires conditional plugin-state deletion`);
                }
                applied = deleteIf(key, (raw) => {
                  assertCurrent();
                  return isDeepStrictEqual(raw, expected);
                });
              }
              if (!applied) {
                throw new Error(`Codex binding changed before ${operation}`);
              }
            };
            let previous: StoredCodexAppServerCompactionTransition["previous"];
            if (!initial) {
              const absenceFence: StoredCodexAppServerBindingV1 = {
                version: 1,
                state: "cleared",
                sessionId: fromSessionId,
                lease,
              };
              if (!isDeepStrictEqual(leased, absenceFence)) {
                throw new Error("Codex binding appeared during compaction transition preparation");
              }
              previous = { kind: "absent" };
            } else {
              if (leased.state !== "active" || leased.sessionId !== fromSessionId) {
                throw new Error("Codex binding changed before compaction transition preparation");
              }
              const { lease: _initialLease, ...initialValue } = initial;
              const { lease: _leasedLease, ...leasedValue } = leased;
              if (!isDeepStrictEqual(leasedValue, initialValue)) {
                throw new Error("Codex binding changed before compaction transition preparation");
              }
              previous = { kind: "active", value: leased };
            }
            const rotates = fromSessionId !== toSessionId;
            if (!rotates && previous.kind === "absent") {
              // A session without a native thread has no history to synchronize.
              // Remove the lease fence without materializing plugin state.
              try {
                return await run({ commit() {}, rollback() {}, complete() {} });
              } finally {
                replaceExact(leased, undefined, "context-engine compaction absence-fence cleanup");
                owner.phase = "deleted";
              }
            }
            let prepared: StoredCodexAppServerBinding;
            if (rotates) {
              prepared = {
                version: 2,
                state: "compaction-transition",
                transitionId: randomUUID(),
                fromSessionId,
                toSessionId,
                nativeCompactionSyncPending: true,
                previous,
                lease,
              };
            } else {
              if (leased.state !== "active") {
                throw new Error("Codex binding changed before context-engine compaction commit");
              }
              prepared = {
                ...leased,
                binding: {
                  ...leased.binding,
                  nativeCompactionSyncPending: true,
                },
              };
            }
            let phase: "prepared" | "committed" | "rolled-back" | "completed" = "prepared";
            let active = true;
            const assertActive = () => {
              assertCurrent();
              if (!active || owner.phase === "closed" || owner.failure) {
                throw owner.failure ?? bindingLeaseLostError(key);
              }
            };
            try {
              return await run({
                commit() {
                  if (phase === "committed") {
                    return;
                  }
                  if (phase !== "prepared" || owner.phase !== "held") {
                    throw new Error(
                      "Codex context-engine compaction commit cannot commit in its current phase",
                    );
                  }
                  assertActive();
                  replaceExact(leased, prepared, "context-engine compaction commit");
                  phase = "committed";
                  if (prepared.state === "compaction-transition") {
                    owner.phase = "transition";
                    owner.transition = prepared;
                  }
                },
                rollback() {
                  if (phase === "prepared" || phase === "rolled-back") {
                    return;
                  }
                  if (
                    phase !== "committed" ||
                    (rotates ? owner.phase !== "transition" : owner.phase !== "held")
                  ) {
                    throw new Error(
                      "Codex context-engine compaction commit cannot roll back in its current phase",
                    );
                  }
                  assertActive();
                  const committed = rotates ? owner.transition : prepared;
                  if (!committed) {
                    throw bindingLeaseLostError(key);
                  }
                  const restored =
                    committed.state === "compaction-transition"
                      ? restoreCompactionTransition(committed)
                      : leased;
                  replaceExact(committed, restored, "context-engine compaction rollback");
                  phase = "rolled-back";
                  owner.phase = restored ? "held" : "deleted";
                  owner.transition = undefined;
                },
                complete() {
                  if (phase === "completed") {
                    return;
                  }
                  if (
                    phase !== "committed" ||
                    (rotates ? owner.phase !== "transition" : owner.phase !== "held")
                  ) {
                    throw new Error(
                      "Codex context-engine compaction commit cannot complete in its current phase",
                    );
                  }
                  assertActive();
                  const committed = rotates ? owner.transition : prepared;
                  if (!committed) {
                    throw bindingLeaseLostError(key);
                  }
                  const completed =
                    committed.state === "compaction-transition"
                      ? completeCompactionTransition(committed)
                      : committed;
                  replaceExact(committed, completed, "context-engine compaction completion");
                  phase = "completed";
                  owner.phase = completed ? "held" : "deleted";
                  owner.transition = undefined;
                },
              });
            } finally {
              try {
                if (
                  rotates &&
                  phase === "prepared" &&
                  previous.kind === "absent" &&
                  owner.phase === "held"
                ) {
                  const deleteIf = state.deleteIf?.bind(state);
                  if (!deleteIf) {
                    throw new Error(
                      "Codex compaction absence fence requires conditional deletion",
                    );
                  }
                  if (
                    deleteIf(key, (raw) => {
                      assertCurrent();
                      return isDeepStrictEqual(raw, leased);
                    })
                  ) {
                    owner.phase = "deleted";
                  }
                }
              } finally {
                active = false;
              }
            }
          },
          { assertCurrent },
        );
      });
    },

    resetSessionGeneration: (identity) => transitionSessionGeneration(identity, "reset"),
    retireSessionGeneration: (identity) => transitionSessionGeneration(identity, "retire"),

    async withThreadArchiveFence(run) {
      pendingArchives += 1;
      const operation = archiveTail.then(async () => {
        await waitForBindingMutations();
        return await archiveContext.run(true, run);
      });
      archiveTail = operation.then(
        () => undefined,
        () => undefined,
      );
      try {
        return await operation;
      } finally {
        pendingArchives -= 1;
      }
    },

    async withSessionDeletion(identity, assertCurrent, run) {
      const key = bindingStoreKey(identity);
      const deleteIf = state.deleteIf?.bind(state);
      if (!deleteIf) {
        throw new Error("Codex session deletion requires conditional plugin-state deletion");
      }
      return await runBindingMutation(async () => {
        assertCurrent();
        if (state.lookup(key) === undefined) {
          let active = true;
          try {
            return await run(undefined, {
              commit() {
                assertCurrent();
                if (!active || state.lookup(key) !== undefined) {
                  throw new Error("Codex binding changed before session deletion");
                }
              },
              rollback() {},
            });
          } finally {
            active = false;
          }
        }
        return await withBindingLease(
          identity,
          async () => {
            const owner = leaseContext.getStore()!.get(key)!;
            const expected = state.lookup(key);
            const stored = readStoredCodexAppServerBinding(expected);
            if (!stored || !ownsStoredSessionGeneration(identity, stored)) {
              throw new Error("Codex binding generation changed before session deletion");
            }
            const { lease: _lease, ...expectedValue } = stored;
            let deleted: StoredCodexAppServerBindingV1 | undefined;
            let active = true;
            const assertActive = () => {
              assertCurrent();
              if (!active || owner.phase === "closed" || owner.failure) {
                throw owner.failure ?? bindingLeaseLostError(key);
              }
            };
            try {
              return await run(stored.state === "active" ? stored.binding : undefined, {
                commit() {
                  assertActive();
                  if (deleted) {
                    return;
                  }
                  const current = state.lookup(key);
                  const parsed = readStoredCodexAppServerBinding(current);
                  const { lease, ...value } = parsed ?? {};
                  if (
                    !current ||
                    lease?.token !== owner.token ||
                    lease.expiresAt <= Date.now() ||
                    !isDeepStrictEqual(value, expectedValue) ||
                    !deleteIf(key, (raw) => isDeepStrictEqual(raw, current))
                  ) {
                    throw new Error("Codex binding changed before session deletion");
                  }
                  deleted = current;
                  // The agent transaction commits synchronously after this removal. No
                  // heartbeat may recreate the deleted row while artifacts are published.
                  owner.phase = "deleted";
                },
                rollback() {
                  assertActive();
                  if (!deleted) {
                    return;
                  }
                  const restored = {
                    ...deleted,
                    lease: {
                      token: owner.token,
                      expiresAt: Date.now() + BINDING_LEASE_STALE_MS,
                    },
                  };
                  if (!state.registerIfAbsent(key, restored)) {
                    throw new Error("Codex binding changed before session deletion rollback");
                  }
                  deleted = undefined;
                  owner.phase = "held";
                },
              });
            } finally {
              active = false;
            }
          },
          { allowRetired: true, assertCurrent },
        );
      });
    },

    withLease: withBindingLease,
  };
}

function matchesPendingSupervisionBranch(
  binding: CodexAppServerThreadBinding | undefined,
  expected: CodexAppServerPendingSupervisionBranch,
): boolean {
  const pending = binding?.pendingSupervisionBranch;
  if (!pending || binding?.threadId !== expected.sourceThreadId) {
    return false;
  }
  if (
    pending.sourceThreadId !== expected.sourceThreadId ||
    pending.connectionFingerprint !== expected.connectionFingerprint ||
    pending.lastTurnId !== expected.lastTurnId
  ) {
    return false;
  }
  const currentCleanup = pending.cleanupThreadIds ?? [];
  const expectedCleanup = expected.cleanupThreadIds ?? [];
  return (
    currentCleanup.length === expectedCleanup.length &&
    currentCleanup.every((threadId, index) => threadId === expectedCleanup[index])
  );
}

function isSameSupervisionOwner(
  current: CodexAppServerThreadBinding,
  replacement: CodexAppServerThreadBinding,
): boolean {
  return (
    replacement.connectionScope === "supervision" &&
    replacement.threadId === current.threadId &&
    replacement.supervisionSourceThreadId === current.supervisionSourceThreadId
  );
}

function storedSessionGeneration(
  identity: CodexAppServerBindingIdentity,
  current: StoredCodexAppServerBindingV1 | undefined,
): { sessionId?: string } {
  if (identity.kind === "session") {
    return { sessionId: identity.sessionId };
  }
  return current?.sessionId ? { sessionId: current.sessionId } : {};
}

function preservedSessionGeneration(
  identity: CodexAppServerBindingIdentity,
  current: StoredCodexAppServerBindingV1 | undefined,
): { sessionId?: string } {
  if (current?.sessionId) {
    return { sessionId: current.sessionId };
  }
  return storedSessionGeneration(identity, current);
}

function readPluginAppPolicyContext(
  value: unknown,
  bindingSchemaVersion: 1 | 2,
): PluginAppPolicyContext | undefined {
  const record = asOptionalRecord(value);
  if (!record || typeof record.fingerprint !== "string") {
    return undefined;
  }
  const apps = asOptionalRecord(record.apps);
  if (!apps) {
    return undefined;
  }
  const parsedApps: PluginAppPolicyContext["apps"] = {};
  for (const [appId, rawEntry] of Object.entries(apps)) {
    const entry = asOptionalRecord(rawEntry);
    if (!entry) {
      return undefined;
    }
    const destructiveApprovalMode = readDestructiveApprovalMode(
      entry.destructiveApprovalMode,
      bindingSchemaVersion,
    );
    const mcpServerNamesValid =
      Array.isArray(entry.mcpServerNames) &&
      entry.mcpServerNames.every((serverName) => typeof serverName === "string");
    if (entry.source === "account") {
      if (
        "appId" in entry ||
        typeof entry.appName !== "string" ||
        typeof entry.allowDestructiveActions !== "boolean" ||
        (entry.allowOpenWorld !== undefined && typeof entry.allowOpenWorld !== "boolean") ||
        destructiveApprovalMode === "invalid" ||
        !mcpServerNamesValid
      ) {
        return undefined;
      }
      parsedApps[appId] = {
        source: "account",
        appName: entry.appName,
        allowDestructiveActions: entry.allowDestructiveActions,
        ...(typeof entry.allowOpenWorld === "boolean"
          ? { allowOpenWorld: entry.allowOpenWorld }
          : {}),
        ...(destructiveApprovalMode ? { destructiveApprovalMode } : {}),
        mcpServerNames: entry.mcpServerNames as string[],
      };
      continue;
    }
    if (
      "appId" in entry ||
      (entry.source !== undefined && entry.source !== "plugin") ||
      typeof entry.configKey !== "string" ||
      typeof entry.marketplaceName !== "string" ||
      !CODEX_PLUGIN_MARKETPLACE_NAME_PATTERN.test(entry.marketplaceName) ||
      typeof entry.pluginName !== "string" ||
      typeof entry.allowDestructiveActions !== "boolean" ||
      (entry.allowOpenWorld !== undefined && typeof entry.allowOpenWorld !== "boolean") ||
      destructiveApprovalMode === "invalid" ||
      !mcpServerNamesValid
    ) {
      return undefined;
    }
    parsedApps[appId] = {
      configKey: entry.configKey,
      marketplaceName: entry.marketplaceName,
      pluginName: entry.pluginName,
      allowDestructiveActions: entry.allowDestructiveActions,
      ...(typeof entry.allowOpenWorld === "boolean"
        ? { allowOpenWorld: entry.allowOpenWorld }
        : {}),
      ...(destructiveApprovalMode ? { destructiveApprovalMode } : {}),
      mcpServerNames: entry.mcpServerNames as string[],
    };
  }
  const parsedPluginAppIds: PluginAppPolicyContext["pluginAppIds"] = {};
  if (
    record.pluginAppIds !== undefined &&
    (!record.pluginAppIds ||
      typeof record.pluginAppIds !== "object" ||
      Array.isArray(record.pluginAppIds))
  ) {
    return undefined;
  }
  if (record.pluginAppIds && typeof record.pluginAppIds === "object") {
    for (const [configKey, appIds] of Object.entries(record.pluginAppIds)) {
      if (!Array.isArray(appIds) || appIds.some((appId) => typeof appId !== "string")) {
        return undefined;
      }
      parsedPluginAppIds[configKey] = appIds;
    }
  }
  return {
    fingerprint: record.fingerprint,
    apps: parsedApps,
    pluginAppIds: parsedPluginAppIds,
  };
}

function readDestructiveApprovalMode(
  value: unknown,
  bindingSchemaVersion: 1 | 2,
): PluginAppPolicyContext["apps"][string]["destructiveApprovalMode"] | undefined | "invalid" {
  if (value === undefined) {
    return undefined;
  }
  if (value === "allow" || value === "deny") {
    return value;
  }
  if (value === "auto") {
    return bindingSchemaVersion === 1 ? "allow" : "auto";
  }
  if (value === "ask" && bindingSchemaVersion === 2) {
    return "ask";
  }
  if (value === "on-request" && bindingSchemaVersion === 1) {
    return "auto";
  }
  return "invalid";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Returns true when an auth profile uses native Codex/OpenAI app-server auth. */
export function isCodexAppServerNativeAuthProfile(
  lookup: CodexAppServerAuthProfileLookup,
): boolean {
  const authProfileId = lookup.authProfileId?.trim();
  if (!authProfileId) {
    return false;
  }
  try {
    const store =
      lookup.authProfileStore ??
      ensureAuthProfileStore(
        lookup.agentDir?.trim() || resolveDefaultAgentDir(lookup.config ?? {}),
        {
          allowKeychainPrompt: false,
          config: lookup.config,
          externalCliProviderIds: [CODEX_APP_SERVER_NATIVE_AUTH_PROVIDER],
          externalCliProfileIds: [authProfileId],
        },
      );
    const credential = store.profiles[authProfileId];
    if (!credential || credential.type === "api_key") {
      return false;
    }
    const provider = credential.provider?.trim();
    return Boolean(
      provider &&
      resolveProviderIdForAuth(provider, { config: lookup.config }) ===
        CODEX_APP_SERVER_NATIVE_AUTH_PROVIDER,
    );
  } catch (error) {
    embeddedAgentLog.debug("failed to resolve codex app-server auth profile provider", {
      authProfileId,
      error,
    });
    return false;
  }
}

/** Hides redundant OpenAI provider attribution for native Codex auth bindings. */
export function normalizeCodexAppServerBindingModelProvider(params: {
  authProfileId?: string;
  modelProvider?: string;
  authProfileStore?: AuthProfileStore;
  agentDir?: string;
  config?: ProviderAuthAliasConfig;
}): string | undefined {
  const modelProvider = params.modelProvider?.trim();
  if (!modelProvider) {
    return undefined;
  }
  if (
    isCodexAppServerNativeAuthProfile(params) &&
    modelProvider.toLowerCase() === PUBLIC_OPENAI_MODEL_PROVIDER
  ) {
    return undefined;
  }
  return modelProvider;
}

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
