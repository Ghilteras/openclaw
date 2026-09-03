import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, iterateSqliteQuerySync } from "../../infra/kysely-sync.js";
import {
  deferOpenClawAgentPostCommitPublication,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { hasSqliteSessionOwnerColumns } from "./session-accessor.sqlite-owner-projection.js";
import {
  projectSqliteSessionParticipants,
  projectSqliteSessionParticipantsBatch,
} from "./session-accessor.sqlite-participant-projection.js";
import { collectSessionStateIdsForEntry } from "./session-accessor.sqlite-references.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import {
  parseSessionEntryJson,
  selectSessionEntryRows,
  sessionEntryMetadataJson,
} from "./session-accessor.sqlite-status.js";
import type { SessionEntry } from "./types.js";

type SessionEntryCacheDatabase = Pick<OpenClawAgentDatabase, "agentId" | "db">;

export type SessionEntryCacheSnapshot = {
  entries: Map<string, SessionEntry>;
  keys: string[];
};

type CachedProjection<T> = T & {
  validityToken: SqliteSessionEntryCacheValidityToken;
};

type SessionNodeReferences = {
  byOwner: Map<string, readonly string[]>;
  ownersById: Map<string, Set<string>>;
};

type SqliteSessionEntryCache = {
  listing?: CachedProjection<SessionEntryCacheSnapshot>;
  references?: CachedProjection<SessionNodeReferences>;
};

type SqliteSessionEntryCacheValidityToken = {
  dataVersion: number;
  sessionNodesGeneration: number;
};

type SqliteSessionEntryCacheWriteGeneration = {
  after: number;
  before: number;
};

// Listing metadata and node references are lazy, independently validated projections;
// complete prompt snapshots belong to the caller's full read.
// Weak connection ownership lets closed read-only and evicted database handles release their
// snapshots. The connection-local validity token plus tracked-write invalidation keeps live
// snapshots current; narrow tracked upserts patch one authoritative row after commit, while
// structural/unknown writes invalidate. Without both, every read would re-query and re-parse
// every entry_json document.
const sessionEntryCaches = new WeakMap<DatabaseSync, SqliteSessionEntryCache>();
const sessionNodesGenerationTrackerSchemaVersions = new WeakMap<DatabaseSync, number>();

function readDataVersion(database: DatabaseSync): number {
  const row = database.prepare("PRAGMA data_version").get() as { data_version?: unknown };
  if (typeof row.data_version !== "number") {
    throw new Error("SQLite did not return a numeric PRAGMA data_version");
  }
  return row.data_version;
}

function ensureSessionNodesGenerationTracker(database: DatabaseSync): boolean {
  const schemaRow = database.prepare("PRAGMA schema_version").get() as {
    schema_version?: unknown;
  };
  if (typeof schemaRow.schema_version !== "number") {
    throw new Error("SQLite did not return a numeric PRAGMA schema_version");
  }
  const trackedSchemaVersion = sessionNodesGenerationTrackerSchemaVersions.get(database);
  if (trackedSchemaVersion === schemaRow.schema_version) {
    return true;
  }
  // A transaction may inspect fresh rows, but must not install or publish a tracker
  // whose DDL/generation could roll back. Warm it only outside the commit boundary.
  if (database.isTransaction) {
    return false;
  }
  // sqlite-allow-raw -- TEMP triggers are the connection-local ownership boundary: they
  // observe unpublished raw DML. A main-schema change bumps the generation before reinstalling
  // them, so dropping/recreating session_nodes cannot make an old snapshot look current.
  database.exec(`
    CREATE TEMP TABLE IF NOT EXISTS openclaw_session_nodes_cache_generation (id INTEGER NOT NULL PRIMARY KEY CHECK (id = 1), generation INTEGER NOT NULL) STRICT;
    INSERT OR IGNORE INTO openclaw_session_nodes_cache_generation (id, generation) VALUES (1, 0);
    ${trackedSchemaVersion === undefined ? "" : "UPDATE openclaw_session_nodes_cache_generation SET generation = generation + 1 WHERE id = 1;"}
    DROP TRIGGER IF EXISTS openclaw_session_nodes_cache_generation_insert;
    DROP TRIGGER IF EXISTS openclaw_session_nodes_cache_generation_update;
    DROP TRIGGER IF EXISTS openclaw_session_nodes_cache_generation_delete;
    CREATE TEMP TRIGGER openclaw_session_nodes_cache_generation_insert
      AFTER INSERT ON main.session_nodes BEGIN UPDATE openclaw_session_nodes_cache_generation SET generation = generation + 1 WHERE id = 1; END;
    CREATE TEMP TRIGGER openclaw_session_nodes_cache_generation_update
      AFTER UPDATE ON main.session_nodes BEGIN UPDATE openclaw_session_nodes_cache_generation SET generation = generation + 1 WHERE id = 1; END;
    CREATE TEMP TRIGGER openclaw_session_nodes_cache_generation_delete
      AFTER DELETE ON main.session_nodes BEGIN UPDATE openclaw_session_nodes_cache_generation SET generation = generation + 1 WHERE id = 1; END;
  `);
  sessionNodesGenerationTrackerSchemaVersions.set(database, schemaRow.schema_version);
  return true;
}

function readSessionNodesGeneration(database: DatabaseSync): number | undefined {
  if (!ensureSessionNodesGenerationTracker(database)) {
    return undefined;
  }
  const row = database
    .prepare("SELECT generation FROM temp.openclaw_session_nodes_cache_generation WHERE id = 1")
    .get() as { generation?: unknown };
  if (typeof row.generation !== "number") {
    throw new Error("SQLite session_nodes cache generation is unavailable");
  }
  return row.generation;
}

function readCacheValidityToken(
  database: DatabaseSync,
): SqliteSessionEntryCacheValidityToken | undefined {
  const sessionNodesGeneration = readSessionNodesGeneration(database);
  if (sessionNodesGeneration === undefined) {
    return undefined;
  }
  return {
    dataVersion: readDataVersion(database),
    sessionNodesGeneration,
  };
}

function cacheValidityTokensEqual(
  left: SqliteSessionEntryCacheValidityToken,
  right: SqliteSessionEntryCacheValidityToken,
): boolean {
  return (
    left.dataVersion === right.dataVersion &&
    left.sessionNodesGeneration === right.sessionNodesGeneration
  );
}

/** Bracket one accessor-owned row write so its publication cannot hide earlier raw DML. */
export function trackSessionEntryCacheWrite(
  database: OpenClawAgentDatabase,
  write: () => void,
): SqliteSessionEntryCacheWriteGeneration | undefined {
  const before = sessionEntryCaches.has(database.db)
    ? readSessionNodesGeneration(database.db)
    : undefined;
  write();
  const after = before === undefined ? undefined : readSessionNodesGeneration(database.db);
  return before === undefined || after === undefined ? undefined : { before, after };
}

function selectSessionNodeReferences(database: SessionEntryCacheDatabase) {
  return getSessionKysely(database.db)
    .selectFrom("session_nodes")
    .select([sessionEntryMetadataJson, "current_session_id", "session_key"]);
}

function collectSessionNodeReferences(row: { current_session_id: string; entry_json: string }) {
  const entry = parseSessionEntryJson(row);
  // Raw current ids protect even malformed nodes; listing identity checks differ.
  return [
    ...new Set([row.current_session_id, ...(entry ? collectSessionStateIdsForEntry(entry) : [])]),
  ];
}

function replaceSessionNodeReferences(
  references: SessionNodeReferences,
  sessionKey: string,
  sessionIds: readonly string[],
): void {
  for (const id of references.byOwner.get(sessionKey) ?? []) {
    const owners = references.ownersById.get(id)!;
    owners.delete(sessionKey);
    if (owners.size === 0) {
      references.ownersById.delete(id);
    }
  }
  references.byOwner.set(sessionKey, sessionIds);
  for (const id of sessionIds) {
    const owners = references.ownersById.get(id) ?? new Set<string>();
    owners.add(sessionKey);
    references.ownersById.set(id, owners);
  }
}

/** Node-only protection. Window ownership, admissions and recency are always read live. */
export function readSessionNodeReferences(
  database: SessionEntryCacheDatabase,
  excludedSessionKeys: ReadonlySet<string>,
  candidateSessionIds?: readonly string[],
): Set<string> {
  const validityToken = readCacheValidityToken(database.db);
  const cache = sessionEntryCaches.get(database.db) ?? {};
  const references = cache.references;
  if (
    !references ||
    !validityToken ||
    !cacheValidityTokensEqual(references.validityToken, validityToken)
  ) {
    const loaded: SessionNodeReferences = { byOwner: new Map(), ownersById: new Map() };
    for (const row of iterateSqliteQuerySync(database.db, selectSessionNodeReferences(database))) {
      if (excludedSessionKeys.has(row.session_key)) {
        continue;
      }
      replaceSessionNodeReferences(loaded, row.session_key, collectSessionNodeReferences(row));
    }
    // Capture the pre-read token: an external commit during the scan must invalidate
    // the next use. Neither uncommitted nor owner-excluding scans certify a full projection.
    if (validityToken && !database.db.isTransaction && excludedSessionKeys.size === 0) {
      cache.references = { ...loaded, validityToken };
      sessionEntryCaches.set(database.db, cache);
    }
    return selectReferencedSessionIds(loaded, excludedSessionKeys, candidateSessionIds);
  }
  return selectReferencedSessionIds(references, excludedSessionKeys, candidateSessionIds);
}

function selectReferencedSessionIds(
  references: SessionNodeReferences,
  excludedSessionKeys: ReadonlySet<string>,
  candidateSessionIds?: readonly string[],
): Set<string> {
  const sessionIds = new Set<string>();
  for (const id of candidateSessionIds ?? references.ownersById.keys()) {
    for (const owner of references.ownersById.get(id) ?? []) {
      if (!excludedSessionKeys.has(owner)) {
        sessionIds.add(id);
        break;
      }
    }
  }
  return sessionIds;
}

function loadSessionEntrySnapshot(
  database: SessionEntryCacheDatabase,
  projection: "full" | "list" = "list",
): SessionEntryCacheSnapshot {
  const rows = iterateSqliteQuerySync(
    database.db,
    selectSessionEntryRows(database, projection).select("updated_at").orderBy("session_key"),
  );
  const parsedEntries = new Map<string, SessionEntry>();
  const keys: string[] = [];
  // Stream raw JSON so a full read never holds both serialized and parsed store-wide payloads.
  for (const row of rows) {
    keys.push(row.session_key);
    const entry = parseSessionEntryJson(row, projection);
    if (!entry) {
      continue;
    }
    parsedEntries.set(row.session_key, entry);
  }
  const entries = projectSqliteSessionParticipantsBatch(database.db, parsedEntries);
  return {
    entries,
    keys,
  };
}

export function readSessionEntryCache(
  database: SessionEntryCacheDatabase,
  options: { cache: boolean; latest?: boolean; projection?: "full" | "list" },
): SessionEntryCacheSnapshot {
  if (
    !options.cache ||
    options.latest ||
    options.projection === "full" ||
    database.db.isTransaction
  ) {
    return loadSessionEntrySnapshot(database, options.projection);
  }
  const validityToken = readCacheValidityToken(database.db);
  const cache = sessionEntryCaches.get(database.db) ?? {};
  const cached = cache.listing;
  if (cached && validityToken && cacheValidityTokensEqual(cached.validityToken, validityToken)) {
    return cached;
  }
  // Only tracked publications identify changed rows. A generation gap can contain
  // same-timestamp or owner-only edits; updated_at cannot validate a partial reload.
  const loaded = loadSessionEntrySnapshot(database);
  if (!validityToken) {
    return loaded;
  }
  const next = { ...loaded, validityToken };
  cache.listing = next;
  sessionEntryCaches.set(database.db, cache);
  return next;
}

function publishTrackedCacheUpdate(database: OpenClawAgentDatabase, publish: () => void): void {
  if (deferOpenClawAgentPostCommitPublication(database, publish)) {
    return;
  }
  if (database.db.isTransaction) {
    throw new Error(
      "SQLite session entry writes must use runOpenClawAgentWriteTransaction for cache publication",
    );
  }
  publish();
}

function publishSqliteSessionEntryCacheUpsert(
  database: OpenClawAgentDatabase,
  update: { sessionKey: string; entry: SessionEntry },
  writeGeneration: SqliteSessionEntryCacheWriteGeneration,
): void {
  const { sessionKey } = update;
  // Carry the writer's canonical metadata forward, but own detached nested values.
  // Saved prompts are caller-owned and must never be serialized into the listing cache.
  const { skillsSnapshot: _skills, systemPromptReport: _report, ...metadata } = update.entry;
  const ownerRow = hasSqliteSessionOwnerColumns(database.db)
    ? executeSqliteQuerySync(
        database.db,
        getSessionKysely(database.db)
          .selectFrom("session_nodes")
          .select([
            "owner_actor_type",
            "owner_actor_id",
            "owner_assigned_by_type",
            "owner_assigned_by_id",
            "owner_assigned_at",
          ])
          .where("session_key", "=", sessionKey)
          .limit(1),
      ).rows[0]
    : undefined;
  const parsedEntry = parseSessionEntryJson({ entry_json: JSON.stringify(metadata), ...ownerRow });
  if (!parsedEntry) {
    publishTrackedCacheUpdate(database, () => sessionEntryCaches.delete(database.db));
    return;
  }
  const entry = projectSqliteSessionParticipants(database.db, sessionKey, parsedEntry);
  publishTrackedCacheUpdate(database, () => {
    const cached = sessionEntryCaches.get(database.db)?.listing;
    if (!cached) {
      return;
    }
    const generationIsContinuous =
      cached.validityToken.sessionNodesGeneration === writeGeneration.before;
    // Borrowed cache views are synchronous, so the commit owner can update one
    // row in place without cloning every session map on each active-run write.
    if (!cached.entries.has(sessionKey) && !cached.keys.includes(sessionKey)) {
      cached.keys = [...cached.keys, sessionKey].toSorted();
    }
    cached.entries.set(sessionKey, entry);
    // Advance only across the bracketed row write. A raw write before/after this bracket leaves
    // a generation gap, while the retained data_version still exposes external commits.
    if (generationIsContinuous) {
      cached.validityToken = {
        ...cached.validityToken,
        sessionNodesGeneration: writeGeneration.after,
      };
    }
  });
}

export function publishSessionEntryCacheInvalidation(
  database: OpenClawAgentDatabase,
  update?: { sessionKey: string; entry: SessionEntry },
  writeGeneration?: SqliteSessionEntryCacheWriteGeneration,
): void {
  if (update && writeGeneration) {
    if (sessionEntryCaches.get(database.db)?.listing) {
      publishSqliteSessionEntryCacheUpsert(database, update, writeGeneration);
    }
    if (sessionEntryCaches.get(database.db)?.references) {
      const row = executeSqliteQuerySync(
        database.db,
        selectSessionNodeReferences(database).where("session_key", "=", update.sessionKey),
      ).rows[0];
      const sessionIds = row ? collectSessionNodeReferences(row) : [];
      publishTrackedCacheUpdate(database, () => {
        const cached = sessionEntryCaches.get(database.db)?.references;
        if (!cached) {
          return;
        }
        replaceSessionNodeReferences(cached, update.sessionKey, sessionIds);
        if (cached.validityToken.sessionNodesGeneration === writeGeneration.before) {
          cached.validityToken = {
            ...cached.validityToken,
            sessionNodesGeneration: writeGeneration.after,
          };
        }
      });
    }
    return;
  }
  // A cold write has no snapshot to patch; do not hydrate owner/participants or prompt JSON.
  publishTrackedCacheUpdate(database, () => sessionEntryCaches.delete(database.db));
}
