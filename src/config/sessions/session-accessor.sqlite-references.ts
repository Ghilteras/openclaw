import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { iterateSqliteQuerySync } from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { chunkItems } from "../../utils/chunk-items.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import {
  parseSessionEntryJson,
  sessionEntryMetadataJson,
} from "./session-accessor.sqlite-status.js";
import { isSessionEntryDiskBudgetEvictable } from "./store-maintenance.js";
import type { SessionEntry } from "./types.js";

/** Every transcript generation retained by one canonical logical-session record. */
export function collectSessionStateIdsForEntry(entry: SessionEntry): string[] {
  const sessionIds: string[] = [];
  const add = (sessionId: string | undefined) => {
    const normalized = sessionId?.trim();
    if (normalized) {
      sessionIds.push(normalized);
    }
  };
  add(entry.sessionId);
  add(entry.previousSessionId);
  for (const sessionId of entry.usageFamilySessionIds ?? []) {
    add(sessionId);
  }
  for (const checkpoint of entry.compactionCheckpoints ?? []) {
    add(checkpoint.sessionId);
    add(checkpoint.preCompaction.sessionId);
    add(checkpoint.postCompaction.sessionId);
  }
  return uniqueStrings(sessionIds);
}

/** Fresh window ownership complements the independently cached node references. */
export function addRetainedWindowSessionReferences(
  database: OpenClawAgentDatabase,
  sessionIds: Set<string>,
  excludedSessionKeys: ReadonlySet<string>,
  candidateSessionIds?: readonly string[],
  diskBudget?: { preserveRecentMs?: number | null },
): void {
  const db = getSessionKysely(database.db);
  // A retained logical owner protects all its history, even generations omitted from
  // entry references. Explicit reset/delete excludes its target owner; automatic deletion
  // rechecks this relation inside its commit after archive materialization has awaited.
  // Inventory callers need every retained window; deletion only needs its candidates.
  // Bound parameters independently of the number of planned lifecycle generations.
  const batches = candidateSessionIds ? chunkItems(candidateSessionIds, 400) : [undefined];
  for (const batch of batches) {
    let query = db
      .selectFrom("session_windows")
      .innerJoin("session_nodes", "session_nodes.session_key", "session_windows.session_key")
      .select([
        "session_windows.session_id",
        "session_nodes.session_key",
        "session_nodes.current_session_id",
        "session_nodes.updated_at",
        "session_nodes.pinned_at",
      ])
      .$if(diskBudget !== undefined, (projection) => projection.select(sessionEntryMetadataJson))
      .where((eb) =>
        eb.or([
          eb("session_nodes.archived_at", "is not", null),
          eb("session_nodes.pinned_at", "is not", null),
        ]),
      );
    if (batch) {
      query = query.where("session_windows.session_id", "in", batch);
    }
    for (const row of iterateSqliteQuerySync(database.db, query)) {
      if (excludedSessionKeys.has(row.session_key)) {
        continue;
      }
      // Only the physical-budget owner may reclaim cap-created history. Node references
      // (including the current generation) remain protected until its final entry tier.
      if (
        diskBudget &&
        row.pinned_at === null &&
        row.entry_json !== undefined &&
        isSessionEntryDiskBudgetEvictable({
          key: row.session_key,
          entry: parseSessionEntryJson({ ...row, entry_json: row.entry_json }) ?? undefined,
          preserveRecentMs: diskBudget.preserveRecentMs,
        })
      ) {
        continue;
      }
      sessionIds.add(row.session_id);
    }
  }
}
