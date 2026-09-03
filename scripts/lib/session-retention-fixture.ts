// Synthetic retention proof fixtures. Never point this runner at an existing state directory.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { measureSessionPhysicalDiskUsage } from "../../src/config/sessions/disk-budget.js";
import {
  applySessionEntryLifecycleMutation,
  deleteSessionEntryLifecycle,
  loadSessionEntry,
} from "../../src/config/sessions/session-accessor.js";
import { writeSessionEntry } from "../../src/config/sessions/session-accessor.sqlite-entry-store.js";
import { appendTranscriptEventsInTransaction } from "../../src/config/sessions/session-accessor.sqlite-transcript-store.js";
import { enforceSqliteSessionHistoryDiskBudget } from "../../src/config/sessions/session-history-eviction.js";
import type { SessionEntry } from "../../src/config/sessions/types.js";
import { beginSessionWorkAdmission } from "../../src/sessions/session-lifecycle-admission.js";
import { openOpenClawAgentDatabaseReadOnly } from "../../src/state/openclaw-agent-db-readonly.js";
import { runOpenClawAgentWriteTransaction } from "../../src/state/openclaw-agent-db.js";

const RETENTION_DAY_MS = 86_400_000;
export const RETENTION_AGENT_ID = "retention";
export const RETENTION_PROFILES = {
  smoke: { archived: 20, fresh: 40, cap: 32, clients: 4, rounds: 1, deadlineMs: 240_000 },
  scale: {
    archived: 10_000,
    fresh: 6_000,
    cap: 5_000,
    clients: 64,
    rounds: 2,
    deadlineMs: 1_800_000,
  },
  massive: {
    archived: 100_000,
    fresh: 6_000,
    cap: 5_000,
    clients: 64,
    rounds: 4,
    deadlineMs: 3_600_000,
  },
} as const;
export type RetentionProfile = keyof typeof RETENTION_PROFILES;
export type RetentionFixture = {
  key: string;
  entry: SessionEntry;
  disposable?: boolean;
  generations: number;
};
export type RetentionStore = { agentId: string; path: string; storePath: string };
export const retentionSessionKey = (name: string) => `agent:${RETENTION_AGENT_ID}:${name}`;
export const retentionSeedText = (sessionId: string, index: number) =>
  `Synthetic retained history ${sessionId} message ${index}.`;
const padded = (index: number) => String(index).padStart(6, "0");

export function makeRetentionFixtures(profile: RetentionProfile, now: number): RetentionFixture[] {
  const rows: RetentionFixture[] = [];
  const add = (name: string, patch: Partial<SessionEntry>, disposable = false) => {
    rows.push({
      key: retentionSessionKey(name),
      generations: 2,
      disposable,
      entry: {
        sessionId: `retention-${name.replaceAll(":", "-")}`,
        updatedAt: now - 2 * RETENTION_DAY_MS,
        label: `Retention ${name}`,
        ...patch,
      },
    });
  };
  for (let i = 0; i < RETENTION_PROFILES[profile].archived; i++) {
    add(`dashboard:archived-${padded(i)}`, {
      archivedAt: now - RETENTION_DAY_MS,
      archiveReason: ([undefined, "manual", "stale-dashboard", "restart-recovery"] as const)[i % 4],
      updatedAt: now - 90 * RETENTION_DAY_MS,
    });
  }
  for (let i = 0; i < RETENTION_PROFILES[profile].fresh; i++) {
    add(`dashboard:fresh-${padded(i)}`, { updatedAt: now - 2 * RETENTION_DAY_MS + i });
  }
  for (let i = 0; i < 8; i++) {
    add(`aged-${i}`, { updatedAt: now - 40 * RETENTION_DAY_MS });
  }
  const stale = { updatedAt: now - 60 * RETENTION_DAY_MS };
  add("main", stale);
  add("pinned", { ...stale, pinnedAt: now - RETENTION_DAY_MS });
  add("direct:synthetic-peer", stale);
  add("matrix:group:synthetic-room", stale);
  add("conversation:thread:synthetic-thread", stale);
  add("model-locked", { ...stale, modelSelectionLocked: true });
  add("running", { ...stale, status: "running" });
  add("admitted", stale);
  add("recent", { ...stale, lastActivityAt: now });
  for (const name of [
    "cron:synthetic:run:old",
    "hook:expired",
    "acp:expired",
    "subagent:expired",
    "heartbeat",
  ]) {
    add(name, stale, true);
  }
  add(
    "explicit:model-run-00000000-0000-4000-8000-000000000001",
    { updatedAt: now - 2 * RETENTION_DAY_MS },
    true,
  );
  return rows;
}

export function retentionWindowIds(row: RetentionFixture): string[] {
  return Array.from({ length: row.generations }, (_, i) =>
    i === row.generations - 1 ? row.entry.sessionId : `${row.entry.sessionId}-old-${i}`,
  );
}

export async function seedRetentionFixtures(
  store: RetentionStore,
  rows: RetentionFixture[],
  progress: (value: unknown) => void,
): Promise<void> {
  const started = performance.now();
  for (let offset = 0; offset < rows.length; offset += 100) {
    // The canonical writers build all normal projections. Batching amortizes BEGIN/fsync;
    // no per-row public mutation is allowed to kick maintenance while seeding.
    runOpenClawAgentWriteTransaction((database) => {
      for (const row of rows.slice(offset, offset + 100)) {
        for (const sessionId of retentionWindowIds(row)) {
          writeSessionEntry(database, row.key, { ...row.entry, sessionId });
          const header = {
            type: "session",
            version: 3,
            id: sessionId,
            timestamp: new Date(row.entry.updatedAt).toISOString(),
            cwd: "/synthetic-retention",
          };
          const messages = Array.from({ length: 4 }, (_, i) => ({
            type: "message",
            id: `seed-${sessionId}-${i}`,
            parentId: i === 0 ? null : `seed-${sessionId}-${i - 1}`,
            timestamp: new Date(row.entry.updatedAt + i).toISOString(),
            message: {
              role: "user",
              content: [{ type: "text", text: retentionSeedText(sessionId, i) }],
              timestamp: row.entry.updatedAt + i,
            },
          }));
          assert.equal(
            appendTranscriptEventsInTransaction(
              database,
              { ...store, sessionKey: row.key, sessionId },
              [header, ...messages],
            ),
            5,
          );
        }
        // Current entry deliberately omits previous/history IDs: retained-owner protection
        // must find the older normal window through session_windows ownership.
        writeSessionEntry(database, row.key, row.entry);
      }
    }, store);
    if (offset % 5_000 === 0) {
      progress({
        phase: "seed",
        completed: Math.min(offset + 100, rows.length),
        total: rows.length,
        elapsedMs: performance.now() - started,
      });
    }
    await yieldTurn();
  }
}

/** Proof reads never register, migrate, or borrow a writable Gateway handle. */
export function readRetentionDatabase<T>(store: RetentionStore, read: (db: DatabaseSync) => T): T {
  const opened = openOpenClawAgentDatabaseReadOnly(store);
  assert(opened.found, "expected canonical retention database");
  const { db } = opened.database;
  try {
    // One read snapshot binds multi-query invariants even if startup cleanup is already running.
    db.exec("BEGIN");
    const result = read(db);
    db.exec("COMMIT");
    return result;
  } finally {
    opened.database.close();
  }
}

export function readRetentionEntry(store: RetentionStore, key: string): SessionEntry | undefined {
  return readRetentionDatabase(store, (db) => {
    const row = db.prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?").get(key);
    return row ? (JSON.parse(String(row.entry_json)) as SessionEntry) : undefined;
  });
}

export function readRetentionSnapshot(
  store: RetentionStore,
  selectedKeys?: ReadonlySet<string>,
  selectedWindowIds?: ReadonlySet<string>,
) {
  return readRetentionDatabase(store, (db) => {
    const identities = createHash("sha256");
    const windows = createHash("sha256");
    const events = createHash("sha256");
    let nodes = 0,
      active = 0,
      generations = 0,
      eventCount = 0;
    for (const row of db
      .prepare(
        "SELECT session_key, current_session_id, archived_at FROM session_nodes ORDER BY session_key",
      )
      .iterate()) {
      if (selectedKeys && !selectedKeys.has(String(row.session_key))) {
        continue;
      }
      nodes++;
      if (row.archived_at === null) {
        active++;
      }
      identities.update(JSON.stringify([row.session_key, row.current_session_id]) + "\n");
    }
    for (const row of db
      .prepare(
        "SELECT session_key, session_id FROM session_windows ORDER BY session_key, session_id",
      )
      .iterate()) {
      if (selectedKeys && !selectedKeys.has(String(row.session_key))) {
        continue;
      }
      if (selectedWindowIds && !selectedWindowIds.has(String(row.session_id))) {
        continue;
      }
      generations++;
      windows.update(JSON.stringify([row.session_key, row.session_id]) + "\n");
    }
    // Streaming iteration keeps the million-event verification bounded in memory.
    for (const row of db
      .prepare(
        "SELECT w.session_key, e.session_id, e.seq, e.event_json FROM transcript_events e JOIN session_windows w USING (session_id) ORDER BY e.session_id, e.seq",
      )
      .iterate()) {
      if (selectedKeys && !selectedKeys.has(String(row.session_key))) {
        continue;
      }
      if (selectedWindowIds && !selectedWindowIds.has(String(row.session_id))) {
        continue;
      }
      eventCount++;
      events.update(JSON.stringify([row.session_id, row.seq, row.event_json]) + "\n");
    }
    return {
      nodes,
      active,
      archived: nodes - active,
      generations,
      events: eventCount,
      identityHash: identities.digest("hex"),
      windowHash: windows.digest("hex"),
      eventHash: events.digest("hex"),
    };
  });
}

export function checkRetentionIntegrity(store: RetentionStore) {
  return readRetentionDatabase(store, (db) => {
    const check = db.prepare("PRAGMA integrity_check").all();
    const foreignKeys = db.prepare("PRAGMA foreign_key_check").all();
    assert.deepEqual(
      check.map((row) => row.integrity_check),
      ["ok"],
    );
    assert.deepEqual(foreignKeys, []);
    const invalid = db
      .prepare(
        "SELECT COUNT(*) AS count FROM session_nodes WHERE entry_valid != 1 OR current_session_id != json_extract(entry_json, '$.sessionId')",
      )
      .get();
    assert.equal(invalid?.count, 0);
    return { integrity: "ok", foreignKeyViolations: 0, invalidEntries: 0 };
  });
}

function assertRetentionConserved(
  before: ReturnType<typeof readRetentionSnapshot>,
  after: ReturnType<typeof readRetentionSnapshot>,
) {
  for (const field of [
    "nodes",
    "generations",
    "events",
    "identityHash",
    "windowHash",
    "eventHash",
  ] as const) {
    assert.equal(after[field], before[field], `retention conservation: ${field}`);
  }
}

export async function proveRetentionOwners(
  store: RetentionStore,
  rows: RetentionFixture[],
  profile: RetentionProfile,
) {
  const durable = new Set(rows.filter((row) => !row.disposable).map((row) => row.key));
  const before = readRetentionSnapshot(store, durable);
  const admission = await beginSessionWorkAdmission({
    scope: store.storePath,
    identities: [retentionSessionKey("admitted")],
    assertAllowed: () => {},
  });
  try {
    const cleanup = await applySessionEntryLifecycleMutation({
      ...store,
      maintenanceOverride: {
        mode: "enforce",
        maxEntries: RETENTION_PROFILES[profile].cap,
        preserveRecentMs: 3_600_000,
      },
    });
    const after = readRetentionSnapshot(store, durable);
    assertRetentionConserved(before, after);
    assert.equal(after.active, RETENTION_PROFILES[profile].cap);
    assert.equal(cleanup.modelRunPruned, 1);
    assert.equal(cleanup.pruned, 5);
    const capArchives = RETENTION_PROFILES[profile].fresh + 9 - RETENTION_PROFILES[profile].cap;
    assert.equal(cleanup.capArchived, capArchives);
    assert.equal(cleanup.capped, capArchives);
    assert.equal(cleanup.archived, capArchives + 8);
    for (const row of rows) {
      const entry = loadSessionEntry({ ...store, sessionKey: row.key });
      if (row.disposable) {
        assert.equal(entry, undefined, row.key);
        continue;
      }
      assert.equal(entry?.sessionId, row.entry.sessionId);
      if (row.entry.archivedAt !== undefined) {
        assert.equal(entry?.archivedAt, row.entry.archivedAt);
        assert.equal(entry?.archiveReason, row.entry.archiveReason);
      }
      if (row.key.includes(":dashboard:fresh-") && entry?.archivedAt !== undefined) {
        assert.equal(entry.archiveReason, "active-session-cap");
      }
      if (row.key.includes(":aged-")) {
        assert(entry?.archivedAt, `30-day archive ${row.key}`);
        assert.equal(entry.archiveReason, "age-retention");
      }
      if (!row.key.includes(":dashboard:") && !row.key.includes(":aged-")) {
        assert.equal(entry?.archivedAt, undefined, `protected ${row.key}`);
      }
    }
    const repeated = await applySessionEntryLifecycleMutation({
      ...store,
      maintenanceOverride: {
        mode: "enforce",
        maxEntries: RETENTION_PROFILES[profile].cap,
        preserveRecentMs: 3_600_000,
      },
    });
    assert.equal(
      repeated.archived + repeated.pruned + repeated.modelRunPruned + repeated.capped,
      0,
    );
    assert.deepEqual(readRetentionSnapshot(store, durable), after);
    return {
      execution: "source-owner",
      before,
      after,
      cleanup,
      repeated,
      integrity: checkRetentionIntegrity(store),
      admittedLeaseObservedActive: admission.isActive(),
    };
  } finally {
    admission.release();
  }
}

export async function proveRetentionHighWater(store: RetentionStore) {
  const now = Date.now();
  const updatedAt = now - 2 * RETENTION_DAY_MS;
  const rows = Array.from({ length: 5_999 }, (_, i) => ({
    key: `agent:${store.agentId}:threshold-${i}`,
    entry: { sessionId: `threshold-${i}`, updatedAt, ...(i < 500 ? { archivedAt: now } : {}) },
    generations: 0,
  }));
  for (let offset = 0; offset < rows.length; offset += 100) {
    runOpenClawAgentWriteTransaction((database) => {
      for (const row of rows.slice(offset, offset + 100)) {
        writeSessionEntry(database, row.key, row.entry);
      }
    }, store);
    await yieldTurn();
  }
  const seeded = readRetentionSnapshot(store);
  assert.equal(seeded.nodes, 5_999);
  assert.equal(seeded.archived, 500);
  const below = await applySessionEntryLifecycleMutation(store);
  assert.equal(below.archived, 0);
  assert.deepEqual(readRetentionSnapshot(store), seeded);
  assert.equal(seeded.active, 5_499);
  const reached = await applySessionEntryLifecycleMutation({
    ...store,
    upserts: [
      {
        sessionKey: `agent:${store.agentId}:threshold-final`,
        entry: { sessionId: "threshold-final", updatedAt: now + 1 },
      },
    ],
  });
  assert.equal(reached.archived, 500);
  const after = readRetentionSnapshot(store);
  assert.equal(after.nodes, 6_000);
  assert.equal(after.active, 5_000);
  assert.equal(after.archived, 1_000);
  assert.equal(
    readRetentionEntry(store, `agent:${store.agentId}:threshold-final`)?.archivedAt,
    undefined,
  );
  return {
    execution: "source-owner",
    thresholdRowAgeMs: now - updatedAt,
    seeded,
    below,
    beforeActive: 5_499,
    existingArchives: 500,
    reachedActive: 5_500,
    after,
    archived: reached.archived,
  };
}

// Only call while the owned Gateway is stopped. Both execution modes share this seed
// and the read-only assertions below; only the mutation owners differ.
export async function prepareRetentionDiskFixtures(store: RetentionStore) {
  const candidate: RetentionFixture = {
    key: retentionSessionKey("disk-candidate"),
    entry: { sessionId: "retention-disk-candidate", updatedAt: Date.now() - 10 * RETENTION_DAY_MS },
    generations: 2,
  };
  const explicit: RetentionFixture = {
    key: retentionSessionKey("explicit-delete"),
    entry: {
      sessionId: "retention-explicit-delete",
      updatedAt: Date.now(),
      archivedAt: Date.now(),
    },
    generations: 3,
  };
  await seedRetentionFixtures(store, [candidate, explicit], () => {});
  // Independent fixture oracle: only ordinary dashboard cap archives are disposable.
  // Legacy/manual/dashboard-age/recovery/age archives and pins retain every window.
  const expected = readRetentionDatabase(store, (db) => {
    const retainedKeys = new Set<string>();
    const survivingKeys = new Set<string>();
    const capKeys = new Set<string>();
    const currentIds = new Set<string>();
    for (const row of db
      .prepare("SELECT session_key, current_session_id, entry_json FROM session_nodes")
      .iterate()) {
      const key = String(row.session_key);
      const entry = JSON.parse(String(row.entry_json)) as SessionEntry;
      if (entry.archivedAt !== undefined && entry.archiveReason === "active-session-cap") {
        assert(
          key.startsWith(retentionSessionKey("dashboard:fresh-")),
          "unexpected cap archive fixture",
        );
        assert.equal(entry.pinnedAt, undefined);
        assert.notEqual(entry.status, "running");
        assert.notEqual(entry.modelSelectionLocked, true);
        assert.notEqual(entry.delivery?.kind, "external");
        capKeys.add(key);
      } else {
        survivingKeys.add(key);
        currentIds.add(String(row.current_session_id));
        if (entry.archivedAt !== undefined || entry.pinnedAt !== undefined) {
          retainedKeys.add(key);
        }
      }
    }
    const expectedWindowIds = new Set<string>();
    for (const row of db.prepare("SELECT session_key, session_id FROM session_windows").iterate()) {
      if (retainedKeys.has(String(row.session_key)) || currentIds.has(String(row.session_id))) {
        expectedWindowIds.add(String(row.session_id));
      }
    }
    retainedKeys.delete(explicit.key);
    assert(capKeys.size > 0, "disk proof must exercise the cap-archive last tier");
    return { retainedKeys, survivingKeys, expectedWindowIds, capKeys };
  });
  const protectedBefore = readRetentionSnapshot(store, expected.retainedKeys);
  assert(protectedBefore.nodes > 0 && protectedBefore.events > 0);
  return {
    candidate,
    explicit,
    retainedKeys: expected.retainedKeys,
    protectedBefore,
    allBefore: readRetentionSnapshot(store),
    expectedAfter: readRetentionSnapshot(store, expected.survivingKeys, expected.expectedWindowIds),
    capKeys: expected.capKeys,
  };
}

export async function proveRetentionDiskScenario(
  store: RetentionStore,
  prepared: Awaited<ReturnType<typeof prepareRetentionDiskFixtures>>,
  mutations: {
    execution: "source-owner" | "built-gateway-rpc";
    cleanup: () => Promise<unknown>;
    deleteExplicit: () => Promise<unknown>;
  },
) {
  const { candidate, explicit, retainedKeys, protectedBefore, allBefore } = prepared;
  const cleanup = await mutations.cleanup();
  const afterSweep = readRetentionSnapshot(store);
  // Startup may kick the budget before the RPC arrives. Authoritative state deltas,
  // not the RPC's individual removed count, own reclamation and preservation proof.
  assert(afterSweep.generations < allBefore.generations, "unprotected history must reclaim");
  assert.deepEqual(
    afterSweep,
    prepared.expectedAfter,
    "exact disk-tier survivor identities and history bytes",
  );
  assert.equal(afterSweep.nodes, allBefore.nodes - prepared.capKeys.size);
  for (const key of prepared.capKeys) {
    assert.equal(readRetentionEntry(store, key), undefined, "cap archive last-tier deletion");
  }
  assertRetentionConserved(protectedBefore, readRetentionSnapshot(store, retainedKeys));
  const candidateAfter = readRetentionSnapshot(store, new Set([candidate.key]));
  assert.equal(candidateAfter.generations, 1);
  assert.equal(candidateAfter.events, 5);
  assert.equal(readRetentionEntry(store, candidate.key)?.sessionId, candidate.entry.sessionId);
  assert.equal(
    readRetentionEntry(store, candidate.key)?.archivedAt,
    undefined,
    "count/age pressure contaminated disk scenario",
  );
  const explicitBeforeDelete = readRetentionSnapshot(store, new Set([explicit.key]));
  assert.equal(explicitBeforeDelete.generations, 3);
  assert.equal(explicitBeforeDelete.events, 15);
  const disk = await measureSessionPhysicalDiskUsage(store.storePath);
  assert(disk.totalBytes > 1, "protected data legitimately keeps disk above target");
  const repeated = await mutations.cleanup();
  assert.deepEqual(readRetentionSnapshot(store), afterSweep);
  const deleted = await mutations.deleteExplicit();
  const explicitAfter = readRetentionSnapshot(store, new Set([explicit.key]));
  assert.equal(explicitAfter.nodes, 0);
  assert.equal(explicitAfter.generations, 0);
  assert.equal(explicitAfter.events, 0);
  const afterDelete = readRetentionSnapshot(store);
  assert.equal(afterDelete.nodes, afterSweep.nodes - 1);
  assert.equal(afterDelete.generations, afterSweep.generations - 3);
  assert.equal(afterDelete.events, afterSweep.events - 15);
  assertRetentionConserved(protectedBefore, readRetentionSnapshot(store, retainedKeys));
  return {
    execution: mutations.execution,
    protected: protectedBefore,
    before: allBefore,
    afterSweep,
    afterDelete,
    reclaimedGenerations: allBefore.generations - afterSweep.generations,
    reclaimedCapArchives: prepared.capKeys.size,
    expectedAfter: prepared.expectedAfter,
    disk,
    cleanup,
    repeated,
    deleted,
    explicitDeleteGenerations: 3,
    integrity: checkRetentionIntegrity(store),
  };
}

export async function proveSourceRetentionDisk(store: RetentionStore) {
  const prepared = await prepareRetentionDiskFixtures(store);
  return await proveRetentionDiskScenario(store, prepared, {
    execution: "source-owner",
    cleanup: () =>
      enforceSqliteSessionHistoryDiskBudget({
        storePath: store.storePath,
        mode: "enforce",
        maintenance: { maxDiskBytes: 1, highWaterBytes: 1 },
      }),
    deleteExplicit: async () => {
      const deleted = await deleteSessionEntryLifecycle({
        storePath: store.storePath,
        target: { canonicalKey: prepared.explicit.key, storeKeys: [prepared.explicit.key] },
        expectedSessionId: prepared.explicit.entry.sessionId,
        archiveTranscript: false,
        deleteTranscriptWithoutArchive: true,
      });
      assert.equal(deleted.deleted, true);
      return deleted;
    },
  });
}
