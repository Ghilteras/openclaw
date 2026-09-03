import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import { getSessionKysely, type ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import {
  rotateTranscriptGenerationInTransaction,
  touchTranscriptMutationInTransaction,
} from "./session-accessor.sqlite-transcript-state.js";
import {
  canonicalizeTranscriptEventMedia,
  createTranscriptEventInserter,
  createTranscriptIdentityInserter,
  readEventTimestamp,
  readTranscriptEventIdentity,
} from "./session-accessor.sqlite-transcript-store.js";
import {
  replaceSessionTranscriptIndexSuffixInTransaction,
  type SessionTranscriptProjectionState,
} from "./session-transcript-index.js";
import {
  extractTranscriptIndexEntry,
  hasTranscriptMessage,
  shouldProjectActiveEvent,
  transcriptEventContextEligibility,
} from "./session-transcript-projection-rebuild.js";
import {
  scanSessionTranscriptTree,
  selectSessionTranscriptTreePathNodes,
} from "./transcript-tree.js";

type PreparedTranscriptRow = {
  event: TranscriptEvent;
  eventJson: string;
  identity: ReturnType<typeof readTranscriptEventIdentity>;
  seq: number;
};

type PreparedActiveProjection = {
  activeRows: PreparedTranscriptRow[];
  leafEventId: string | null;
  messageCount: number;
};

export type PreparedTranscriptSuffixReplacement = {
  activeMessagePrefixCount: number;
  activePrefixCount: number;
  expectedProjection: Omit<SessionTranscriptProjectionState, "needsRebuild">;
  ftsMessageIdsToDelete: string[];
  nextActiveSuffix: PreparedTranscriptRow[];
  nextProjection: Omit<SessionTranscriptProjectionState, "needsRebuild">;
  nextSuffix: PreparedTranscriptRow[];
  previousSuffix: PreparedTranscriptRow[];
  suffixStart: number;
};

function prepareTranscriptRows(events: readonly TranscriptEvent[]): PreparedTranscriptRow[] {
  const rows: PreparedTranscriptRow[] = [];
  const seenEventIds = new Set<string>();
  const seenMessageIdempotencyKeys = new Set<string>();
  for (const event of events) {
    const persistedEvent = canonicalizeTranscriptEventMedia(event);
    const identity = readTranscriptEventIdentity(persistedEvent);
    if (identity && seenEventIds.has(identity.eventId)) {
      continue;
    }
    if (identity) {
      seenEventIds.add(identity.eventId);
      if (identity.messageIdempotencyKey) {
        if (seenMessageIdempotencyKeys.has(identity.messageIdempotencyKey)) {
          identity.messageIdempotencyKey = null;
        } else {
          seenMessageIdempotencyKeys.add(identity.messageIdempotencyKey);
        }
      }
    }
    rows.push({
      event: persistedEvent,
      eventJson: JSON.stringify(persistedEvent),
      identity,
      seq: rows.length,
    });
  }
  return rows;
}

function prepareActiveProjection(rows: readonly PreparedTranscriptRow[]): PreparedActiveProjection {
  const tree = scanSessionTranscriptTree(rows.map((row) => row.event));
  const selected = selectSessionTranscriptTreePathNodes(tree, tree.leafId);
  const indexes =
    selected.length > 0
      ? selected.map((node) => node.index)
      : tree.hasLeafControl
        ? []
        : rows.map((_, index) => index);
  const activeRows = indexes.flatMap((index) => {
    const row = rows[index];
    return row && shouldProjectActiveEvent(row.event) ? [row] : [];
  });
  return {
    activeRows,
    leafEventId: tree.appendParentId,
    messageCount: activeRows.filter((row) => hasTranscriptMessage(row.event)).length,
  };
}

/** Prepares all full-history branch resolution before entering the SQLite write transaction. */
export function prepareTranscriptSuffixReplacement(
  previousEvents: readonly TranscriptEvent[],
  nextEvents: readonly TranscriptEvent[],
): PreparedTranscriptSuffixReplacement | undefined {
  const previous = prepareTranscriptRows(previousEvents);
  const next = prepareTranscriptRows(nextEvents);
  let suffixStart = 0;
  while (
    suffixStart < previous.length &&
    suffixStart < next.length &&
    previous[suffixStart]?.eventJson === next[suffixStart]?.eventJson
  ) {
    suffixStart += 1;
  }
  if (suffixStart === previous.length && suffixStart === next.length) {
    return undefined;
  }

  const previousProjection = prepareActiveProjection(previous);
  const nextProjection = prepareActiveProjection(next);
  let activePrefixCount = 0;
  while (
    activePrefixCount < previousProjection.activeRows.length &&
    activePrefixCount < nextProjection.activeRows.length
  ) {
    const previousRow = previousProjection.activeRows[activePrefixCount]!;
    const nextRow = nextProjection.activeRows[activePrefixCount]!;
    if (previousRow.seq !== nextRow.seq || previousRow.eventJson !== nextRow.eventJson) {
      break;
    }
    activePrefixCount += 1;
  }

  const previousActiveSuffix = previousProjection.activeRows.slice(activePrefixCount);
  return {
    activeMessagePrefixCount: nextProjection.activeRows
      .slice(0, activePrefixCount)
      .filter((row) => hasTranscriptMessage(row.event)).length,
    activePrefixCount,
    expectedProjection: {
      activeEventCount: previousProjection.activeRows.length,
      activeMessageCount: previousProjection.messageCount,
      indexedSeq: previous.length - 1,
      leafEventId: previousProjection.leafEventId,
    },
    ftsMessageIdsToDelete: previousActiveSuffix.flatMap((row) => {
      const indexed = extractTranscriptIndexEntry(row.event, 0);
      return indexed ? [indexed.messageId] : [];
    }),
    nextActiveSuffix: nextProjection.activeRows.slice(activePrefixCount),
    nextProjection: {
      activeEventCount: nextProjection.activeRows.length,
      activeMessageCount: nextProjection.messageCount,
      indexedSeq: next.length - 1,
      leafEventId: nextProjection.leafEventId,
    },
    nextSuffix: next.slice(suffixStart),
    previousSuffix: previous.slice(suffixStart),
    suffixStart,
  };
}

/** Applies one prepared suffix replacement while its transcript and projection snapshots match. */
export function replaceSqliteTranscriptSuffixInTransaction(
  database: OpenClawAgentDatabase,
  resolved: ResolvedTranscriptScope,
  plan: PreparedTranscriptSuffixReplacement,
): void {
  const db = getSessionKysely(database.db);
  const storedSuffix = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("transcript_events")
      .select(["created_at", "event_json", "seq"])
      .where("session_id", "=", resolved.sessionId)
      .where("seq", ">=", plan.suffixStart)
      .orderBy("seq", "asc"),
  ).rows;
  const latest = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("transcript_events")
      .select((eb) => eb.fn.max<number>("seq").as("seq"))
      .where("session_id", "=", resolved.sessionId),
  );
  if (
    (latest?.seq ?? -1) !== plan.expectedProjection.indexedSeq ||
    storedSuffix.length !== plan.previousSuffix.length ||
    storedSuffix.some(
      (row, index) =>
        row.seq !== plan.suffixStart + index ||
        row.event_json !== plan.previousSuffix[index]?.eventJson,
    )
  ) {
    throw new Error(`Transcript changed before suffix rewrite: ${resolved.sessionId}`);
  }

  const createdAtByEventId = new Map<string, number>();
  const createdAtByJson = new Map<string, number[]>();
  for (const [index, row] of storedSuffix.entries()) {
    const prepared = plan.previousSuffix[index];
    if (prepared?.identity) {
      createdAtByEventId.set(prepared.identity.eventId, row.created_at);
    } else {
      const timestamps = createdAtByJson.get(row.event_json) ?? [];
      timestamps.push(row.created_at);
      createdAtByJson.set(row.event_json, timestamps);
    }
  }
  const createdAtBySeq = new Map(
    plan.nextSuffix.map((row) => [
      row.seq,
      (row.identity ? createdAtByEventId.get(row.identity.eventId) : undefined) ??
        createdAtByJson.get(row.eventJson)?.shift() ??
        readEventTimestamp(row.event) ??
        Date.now(),
    ]),
  );

  executeSqliteQuerySync(
    database.db,
    db
      .deleteFrom("transcript_event_identities")
      .where("session_id", "=", resolved.sessionId)
      .where("seq", ">=", plan.suffixStart),
  );
  executeSqliteQuerySync(
    database.db,
    db
      .deleteFrom("transcript_events")
      .where("session_id", "=", resolved.sessionId)
      .where("seq", ">=", plan.suffixStart),
  );
  const insertEvent = createTranscriptEventInserter(database, resolved.sessionId);
  const insertIdentity = createTranscriptIdentityInserter(database, resolved.sessionId, false);
  for (const row of plan.nextSuffix) {
    const createdAt = createdAtBySeq.get(row.seq) ?? Date.now();
    insertEvent({ seq: row.seq, eventJson: row.eventJson, createdAt });
    if (row.identity) {
      insertIdentity({ ...row.identity, seq: row.seq, createdAt });
    }
  }

  let activeMessageCount = plan.activeMessagePrefixCount;
  const activeRows = plan.nextActiveSuffix.map((row, offset) => {
    const projectsMessage = hasTranscriptMessage(row.event);
    return {
      activePosition: plan.activePrefixCount + offset,
      contextEligible: transcriptEventContextEligibility(row.event),
      eventSeq: row.seq,
      messagePosition: projectsMessage ? activeMessageCount++ : null,
    };
  });
  const ftsRows = plan.nextActiveSuffix.flatMap((row) => {
    const indexed = extractTranscriptIndexEntry(
      row.event,
      createdAtBySeq.get(row.seq) ?? Date.now(),
    );
    return indexed ? [indexed] : [];
  });
  replaceSessionTranscriptIndexSuffixInTransaction(database.db, {
    activePrefixCount: plan.activePrefixCount,
    expected: plan.expectedProjection,
    ftsMessageIdsToDelete: plan.ftsMessageIdsToDelete,
    next: { ...plan.nextProjection, activeRows, ftsRows },
    sessionId: resolved.sessionId,
  });
  rotateTranscriptGenerationInTransaction(database, resolved.sessionId);
  touchTranscriptMutationInTransaction(database, resolved.sessionId);
}
