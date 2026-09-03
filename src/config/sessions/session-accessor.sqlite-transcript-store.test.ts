import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { cleanupTempDirs, makeTempDir } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { readSessionTranscriptActiveStats } from "./session-accessor.sqlite-active-events.js";
import {
  readTranscriptGenerationInTransaction,
  readTranscriptMutationStateInTransaction,
} from "./session-accessor.sqlite-transcript-state.js";
import {
  appendTranscriptEventInTransaction,
  appendTranscriptEventsInTransaction,
  rewriteSqliteTranscriptEventRowsInTransaction,
  updateSqliteTranscriptEventJsonInTransaction,
} from "./session-accessor.sqlite-transcript-store.js";
import { replaceSqliteTranscriptSuffixInTransaction } from "./session-accessor.sqlite-transcript-suffix.js";
import {
  SYNC_REBUILD_MAX_BYTES,
  sessionTranscriptIndexNeedsReconcile,
} from "./session-transcript-index.js";
import { SessionTranscriptProjectionUnavailableError } from "./session-transcript-projection-error.js";
import {
  prepareSessionTranscriptProjection,
  claimPreparedSessionTranscriptProjectionInTransaction,
  finalizePreparedSessionTranscriptProjectionInTransaction,
  appendPreparedSessionTranscriptProjectionChunkInTransaction,
} from "./session-transcript-projection-rebuild.js";
import { waitForSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";
import { searchSessionTranscripts } from "./session-transcript-search.js";

const tempDirs: string[] = [];

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  cleanupTempDirs(tempDirs);
});

describe("SQLite transcript append", () => {
  it("canonicalizes assistant media at the generic transcript append owner", async () => {
    const stateDir = makeTempDir(tempDirs, "media-persistence-append-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    runOpenClawAgentWriteTransaction(
      (database) => {
        expect(
          appendTranscriptEventInTransaction(
            database,
            {
              agentId: "main",
              env,
              sessionId: "append-session",
              sessionKey: "agent:main:append-session",
            },
            {
              type: "message",
              id: "event-1",
              parentId: null,
              timestamp: 1000,
              message: {
                role: "assistant",
                content: "append",
                MediaPaths: ["/media/a.png"],
                MediaTypes: ["image/png"],
              },
            },
          ),
        ).toBe(true);
      },
      { agentId: "main", env },
    );
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const row = database.db
      .prepare("SELECT event_json FROM transcript_events WHERE session_id = ? AND seq = 0")
      .get("append-session") as { event_json: string };
    const message = (JSON.parse(row.event_json) as { message: Record<string, unknown> }).message;
    expect(message).toMatchObject({ role: "assistant", content: "append" });
    expect(message).not.toHaveProperty("MediaPaths");
    expect(message).not.toHaveProperty("MediaTypes");
    expect(message["__openclaw"]).toMatchObject({
      media: [expect.objectContaining({ path: "/media/a.png", contentType: "image/png" })],
    });
  });
});

const rewriteEvents = [
  { type: "custom", id: "root", parentId: null },
  { type: "message", id: "user", parentId: "root", message: { role: "user", content: "question" } },
  {
    type: "message",
    id: "answer",
    parentId: "user",
    message: { role: "assistant", content: "answer" },
  },
] as const;

async function withRewriteFixture(
  run: (f: {
    db: DatabaseSync;
    snapshot: () => {
      raw: Array<Record<string, unknown>>;
      identities: unknown[];
      active: unknown[];
      search: unknown[];
      generation: string | undefined;
      updatedAt: number | null;
    };
    rewrite: (event: unknown, seq?: number) => void;
    scope: { agentId: string; sessionId: string; sessionKey: string; env: NodeJS.ProcessEnv };
  }) => void | Promise<void>,
  events: readonly unknown[] = rewriteEvents,
) {
  await withOpenClawTestState({ label: "exact-rewrite" }, async (state) => {
    const scope = {
      agentId: "main",
      sessionId: "rewrite",
      sessionKey: "agent:main:rewrite",
      env: state.env,
    };
    const owner = openOpenClawAgentDatabase(scope);
    const { db } = owner;
    runOpenClawAgentWriteTransaction((database) => {
      appendTranscriptEventsInTransaction(database, scope, events);
    }, scope);
    const snapshot = () => ({
      raw: db
        .prepare("SELECT * FROM transcript_events WHERE session_id = ? ORDER BY seq")
        .all(scope.sessionId),
      identities: db
        .prepare("SELECT * FROM transcript_event_identities WHERE session_id = ? ORDER BY seq")
        .all(scope.sessionId),
      active: db
        .prepare(
          "SELECT * FROM session_transcript_active_events WHERE session_id = ? ORDER BY active_position",
        )
        .all(scope.sessionId),
      search: db
        .prepare("SELECT * FROM session_transcript_fts WHERE session_id = ? ORDER BY message_id")
        .all(scope.sessionId),
      generation: readTranscriptGenerationInTransaction(owner, scope.sessionId),
      updatedAt: readTranscriptMutationStateInTransaction(owner, scope.sessionId).updatedAt,
    });
    const rewrite = (event: unknown, seq = 1) => {
      const row = db
        .prepare("SELECT event_json FROM transcript_events WHERE session_id = ? AND seq = ?")
        .get(scope.sessionId, seq);
      if (typeof row?.event_json !== "string") {
        throw new Error("missing rewrite row");
      }
      const expectedEventJson = row.event_json;
      runOpenClawAgentWriteTransaction((database) => {
        rewriteSqliteTranscriptEventRowsInTransaction(database, scope, [
          { seq, event, expectedEventJson },
        ]);
      }, scope);
    };
    await run({ db, snapshot, rewrite, scope });
  });
}

describe("SQLite exact transcript rewrite", () => {
  it("preserves healthy derived rows without FTS access or size scans while raw mutation advances", async () => {
    await withRewriteFixture(({ db, snapshot, rewrite, scope }) => {
      const before = snapshot();
      const work = trackSqliteStatementExecutions(db, ["fts", "size"], (sql) =>
        sql.includes("session_transcript_fts")
          ? "fts"
          : sql.includes("octet_length")
            ? "size"
            : null,
      );
      try {
        rewrite({
          ...rewriteEvents[1],
          message: { ...rewriteEvents[1].message, provenance: "new" },
        });
      } finally {
        work.restore();
      }
      const after = snapshot();
      expect(after.generation).not.toBe(before.generation);
      expect(after.updatedAt).toBeGreaterThan(before.updatedAt!);
      expect(after.active).toEqual(before.active);
      expect(after.search).toEqual(before.search);
      expect(after.raw[0]).toEqual(before.raw[0]);
      expect(after.raw[2]).toEqual(before.raw[2]);
      expect(after.raw[1]).toEqual({ ...before.raw[1], event_json: expect.any(String) });
      expect(after.raw[1]?.event_json).not.toBe(before.raw[1]?.event_json);
      expect(after.identities).toEqual(before.identities);
      expect(sessionTranscriptIndexNeedsReconcile(db, scope.sessionId)).toBe(false);
      expect(work.counts).toEqual({ fts: 0, size: 0 });
    });
  });

  it("keeps oversized metadata current but hides changed text until the real worker reconciles", async () => {
    await withRewriteFixture(async ({ db, rewrite, scope }) => {
      const message = {
        ...rewriteEvents[1].message,
        provenance: "x".repeat(SYNC_REBUILD_MAX_BYTES + 1),
      };
      rewrite({ ...rewriteEvents[1], message });
      expect(sessionTranscriptIndexNeedsReconcile(db, scope.sessionId)).toBe(false);
      const before = prepareSessionTranscriptProjection(db, scope.sessionId)!;
      const work = trackSqliteStatementExecutions(db, ["fts"], (sql) =>
        sql.includes("session_transcript_fts") ? "fts" : null,
      );
      try {
        rewrite({ ...rewriteEvents[1], message: { ...message, content: "changed" } });
        expect(work.counts.fts).toBe(0);
      } finally {
        work.restore();
      }
      expect(sessionTranscriptIndexNeedsReconcile(db, scope.sessionId)).toBe(true);
      expect(() => readSessionTranscriptActiveStats(scope)).toThrow(
        SessionTranscriptProjectionUnavailableError,
      );
      expect(searchSessionTranscripts({ ...scope, query: "question" }).hits).toEqual([]);
      expect(claimPreparedSessionTranscriptProjectionInTransaction(db, before, -1)).toBe(false);
      await waitForSessionTranscriptIndexReconcile(scope);
      expect(sessionTranscriptIndexNeedsReconcile(db, scope.sessionId)).toBe(false);
      expect(searchSessionTranscripts({ ...scope, query: "changed" }).hits).toMatchObject([
        { messageId: "user" },
      ]);
      expect(readSessionTranscriptActiveStats(scope).eventCount).toBe(3);
    });
  });

  it("rolls back all exact writes and mutation state when a later expected row conflicts", async () => {
    await withRewriteFixture(({ snapshot, scope }) => {
      const before = snapshot();
      expect(() =>
        runOpenClawAgentWriteTransaction((database) => {
          rewriteSqliteTranscriptEventRowsInTransaction(database, scope, [
            {
              seq: 1,
              expectedEventJson: JSON.stringify(rewriteEvents[1]),
              event: { ...rewriteEvents[1], message: { role: "user", content: "edited" } },
            },
            { seq: 2, expectedEventJson: "stale", event: rewriteEvents[2] },
          ]);
        }, scope),
      ).toThrow("changed before exact rewrite");
      expect(snapshot()).toEqual(before);
    });
  });

  it.each(["dirty", "missing", "lagging", "unclassified", "claimed"] as const)(
    "recovers %s projections on metadata rewrite and fences stale publication",
    async (kind) => {
      await withRewriteFixture(({ db, rewrite, snapshot, scope }) => {
        const before = snapshot();
        const plan = prepareSessionTranscriptProjection(db, scope.sessionId)!;
        if (kind === "missing") {
          db.prepare("DELETE FROM session_transcript_index_state").run();
        } else if (kind === "unclassified") {
          db.prepare("UPDATE session_transcript_active_events SET context_eligible = NULL").run();
        } else if (kind === "lagging") {
          db.prepare("UPDATE session_transcript_index_state SET indexed_seq = -1").run();
        } else {
          db.prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1").run();
        }
        if (kind === "claimed") {
          expect(claimPreparedSessionTranscriptProjectionInTransaction(db, plan, -1)).toBe(true);
          db.prepare("DELETE FROM session_transcript_active_events").run();
          db.prepare("DELETE FROM session_transcript_fts").run();
        }
        expect(sessionTranscriptIndexNeedsReconcile(db, scope.sessionId)).toBe(true);
        rewrite({
          ...rewriteEvents[1],
          message: { ...rewriteEvents[1].message, provenance: "new" },
        });
        expect(sessionTranscriptIndexNeedsReconcile(db, scope.sessionId)).toBe(false);
        expect(snapshot().active).toEqual(before.active);
        expect(snapshot().search).toEqual(before.search);
        expect(claimPreparedSessionTranscriptProjectionInTransaction(db, plan, -2)).toBe(false);
        expect(
          appendPreparedSessionTranscriptProjectionChunkInTransaction(db, {
            sessionId: scope.sessionId,
            claimId: -1,
            ftsRows: plan.ftsRows,
          }),
        ).toBe(false);
        expect(finalizePreparedSessionTranscriptProjectionInTransaction(db, plan, -1)).toBe(false);
      });
    },
  );

  it.each([
    {
      name: "content",
      seq: 1,
      event: { ...rewriteEvents[1], message: { role: "user", content: "changed" } },
      texts: ["answer", "changed"],
      messages: 2,
    },
    {
      name: "role",
      seq: 1,
      event: { ...rewriteEvents[1], message: { role: "toolResult", content: "question" } },
      texts: ["answer"],
      messages: 2,
    },
    {
      name: "timestamp",
      seq: 1,
      event: { ...rewriteEvents[1], timestamp: 99 },
      texts: ["answer", "question"],
      messages: 2,
    },
    {
      name: "message presence",
      seq: 1,
      event: { type: "message", id: "user", parentId: "root" },
      texts: ["answer"],
      messages: 1,
    },
    {
      name: "parent",
      seq: 2,
      event: { ...rewriteEvents[2], parentId: "root" },
      texts: ["answer"],
      messages: 1,
    },
    {
      name: "leaf control",
      seq: 2,
      event: { type: "leaf", id: "answer", parentId: "user", targetId: "user" },
      texts: ["question"],
      messages: 1,
    },
  ])(
    "rebuilds changed $name facts without duplicate FTS invalidation",
    async ({ event, seq, texts, messages, name }) => {
      await withRewriteFixture(({ db, rewrite, scope }) => {
        const work = trackSqliteStatementExecutions(db, ["deletes"], (sql) =>
          /^delete from ["`]?session_transcript_fts["`]? /i.test(sql) ? "deletes" : null,
        );
        try {
          rewrite(event, seq);
        } finally {
          work.restore();
        }
        const search = db
          .prepare("SELECT text, timestamp FROM session_transcript_fts ORDER BY message_id")
          .all();
        expect(search.map((row) => row.text)).toEqual(texts);
        if (name === "timestamp") {
          expect(search[1]?.timestamp).toBe(99);
        }
        expect(
          db
            .prepare(
              "SELECT active_message_count FROM session_transcript_index_state WHERE session_id = ?",
            )
            .get(scope.sessionId)?.active_message_count,
        ).toBe(messages);
        expect(work.counts.deletes).toBeLessThanOrEqual(1);
      });
    },
  );

  it("avoids duplicate FTS invalidation for maintenance text repair and preserves recency", async () => {
    await withRewriteFixture(({ db, scope, snapshot }) => {
      const before = snapshot();
      const work = trackSqliteStatementExecutions(db, ["deletes"], (sql) =>
        /^delete from ["`]?session_transcript_fts["`]? /i.test(sql) ? "deletes" : null,
      );
      try {
        runOpenClawAgentWriteTransaction(
          (database) =>
            updateSqliteTranscriptEventJsonInTransaction(database, scope.sessionId, [
              {
                seq: 1,
                eventJson: JSON.stringify({
                  ...rewriteEvents[1],
                  message: { role: "user", content: "repaired" },
                }),
              },
            ]),
          scope,
        );
      } finally {
        work.restore();
      }
      expect(snapshot().updatedAt).toBe(before.updatedAt! + 1);
      expect(
        db.prepare("SELECT text FROM session_transcript_fts WHERE message_id = 'user'").get()?.text,
      ).toBe("repaired");
      expect(work.counts.deletes).toBeLessThanOrEqual(1);
    });
  });
});

describe("SQLite exact transcript suffix replacement", () => {
  it("replaces a retained suffix without routing rows through forward indexing", async () => {
    await withRewriteFixture(({ db, snapshot, scope }) => {
      const retainedAnswer = {
        ...rewriteEvents[2],
        parentId: "root",
      };
      runOpenClawAgentWriteTransaction((database) => {
        replaceSqliteTranscriptSuffixInTransaction(database, scope, rewriteEvents, [
          rewriteEvents[0],
          retainedAnswer,
        ]);
      }, scope);

      expect(snapshot()).toMatchObject({
        raw: [expect.objectContaining({ seq: 0 }), expect.objectContaining({ seq: 1 })],
        identities: [expect.objectContaining({ seq: 0 }), expect.objectContaining({ seq: 1 })],
        active: [
          expect.objectContaining({ event_seq: 0 }),
          expect.objectContaining({ event_seq: 1 }),
        ],
        search: [expect.objectContaining({ message_id: "answer", text: "answer" })],
      });
      expect(sessionTranscriptIndexNeedsReconcile(db, scope.sessionId)).toBe(false);
    });
  });

  it("preserves the established idempotency owner across retained suffix rows", async () => {
    const duplicateKeyEvents = [
      rewriteEvents[0],
      {
        type: "message",
        id: "first",
        parentId: "root",
        message: { role: "assistant", content: "first", idempotencyKey: "retry" },
      },
      { type: "custom", id: "removed", parentId: "first" },
      {
        type: "message",
        id: "owner",
        parentId: "removed",
        message: { role: "assistant", content: "owner", idempotencyKey: "retry" },
      },
    ] as const;
    await withRewriteFixture(({ db, scope }) => {
      db.prepare(
        "UPDATE transcript_events SET created_at = CASE seq WHEN 1 THEN 101 WHEN 3 THEN 303 ELSE created_at END WHERE session_id = ?",
      ).run(scope.sessionId);
      db.prepare(
        "UPDATE transcript_event_identities SET message_idempotency_key = NULL, created_at = 101 WHERE session_id = ? AND event_id = ?",
      ).run(scope.sessionId, "first");
      db.prepare(
        "UPDATE transcript_event_identities SET message_idempotency_key = ?, created_at = 303 WHERE session_id = ? AND event_id = ?",
      ).run("retry", scope.sessionId, "owner");

      runOpenClawAgentWriteTransaction((database) => {
        replaceSqliteTranscriptSuffixInTransaction(database, scope, duplicateKeyEvents, [
          duplicateKeyEvents[0],
          duplicateKeyEvents[1],
          { ...duplicateKeyEvents[3], parentId: "first" },
        ]);
      }, scope);

      expect(
        db
          .prepare(
            "SELECT event_id, message_idempotency_key, created_at FROM transcript_event_identities WHERE session_id = ? AND event_id IN ('first', 'owner') ORDER BY event_id",
          )
          .all(scope.sessionId),
      ).toEqual([
        { event_id: "first", message_idempotency_key: null, created_at: 101 },
        { event_id: "owner", message_idempotency_key: "retry", created_at: 303 },
      ]);
      expect(
        db
          .prepare(
            "SELECT seq, created_at FROM transcript_events WHERE session_id = ? AND seq IN (1, 2) ORDER BY seq",
          )
          .all(scope.sessionId),
      ).toEqual([
        { seq: 1, created_at: 101 },
        { seq: 2, created_at: 303 },
      ]);
    }, duplicateKeyEvents);
  });

  it("reserves a retained idempotency owner when a new duplicate precedes it", async () => {
    const duplicateKeyEvents = [
      rewriteEvents[0],
      { type: "custom", id: "removed", parentId: "root" },
      {
        type: "message",
        id: "owner",
        parentId: "removed",
        message: { role: "assistant", content: "owner", idempotencyKey: "retry" },
      },
    ] as const;
    await withRewriteFixture(({ db, scope }) => {
      runOpenClawAgentWriteTransaction((database) => {
        replaceSqliteTranscriptSuffixInTransaction(database, scope, duplicateKeyEvents, [
          duplicateKeyEvents[0],
          {
            type: "message",
            id: "new",
            parentId: "root",
            message: { role: "assistant", content: "new", idempotencyKey: "retry" },
          },
          { ...duplicateKeyEvents[2], parentId: "new" },
        ]);
      }, scope);

      expect(
        db
          .prepare(
            "SELECT event_id, message_idempotency_key FROM transcript_event_identities WHERE session_id = ? AND event_id IN ('new', 'owner') ORDER BY event_id",
          )
          .all(scope.sessionId),
      ).toEqual([
        { event_id: "new", message_idempotency_key: null },
        { event_id: "owner", message_idempotency_key: "retry" },
      ]);
    }, duplicateKeyEvents);
  });

  it("promotes a retained duplicate when its prior idempotency owner is removed", async () => {
    const duplicateKeyEvents = [
      rewriteEvents[0],
      {
        type: "message",
        id: "owner",
        parentId: "root",
        message: { role: "assistant", content: "owner", idempotencyKey: "retry" },
      },
      {
        type: "message",
        id: "duplicate",
        parentId: "owner",
        message: { role: "assistant", content: "duplicate", idempotencyKey: "retry" },
      },
    ] as const;
    await withRewriteFixture(({ db, scope }) => {
      runOpenClawAgentWriteTransaction((database) => {
        replaceSqliteTranscriptSuffixInTransaction(database, scope, duplicateKeyEvents, [
          duplicateKeyEvents[0],
          { ...duplicateKeyEvents[2], parentId: "root" },
        ]);
      }, scope);

      expect(
        db
          .prepare(
            "SELECT event_id, message_idempotency_key FROM transcript_event_identities WHERE session_id = ? AND event_id = ?",
          )
          .get(scope.sessionId, "duplicate"),
      ).toEqual({ event_id: "duplicate", message_idempotency_key: "retry" });
    }, duplicateKeyEvents);
  });

  it("preserves generation while updating raw, identity, active, and FTS rows", async () => {
    await withRewriteFixture(({ db, snapshot, scope }) => {
      const before = snapshot();
      runOpenClawAgentWriteTransaction((database) => {
        replaceSqliteTranscriptSuffixInTransaction(
          database,
          scope,
          rewriteEvents,
          rewriteEvents.slice(0, 2),
        );
      }, scope);

      const after = snapshot();
      expect(after.generation).toBe(before.generation);
      expect(after.raw).toHaveLength(2);
      expect(after.identities).toHaveLength(2);
      expect(after.active).toHaveLength(2);
      expect(after.search).toMatchObject([{ message_id: "user", text: "question" }]);
      expect(sessionTranscriptIndexNeedsReconcile(db, scope.sessionId)).toBe(false);
    });
  });

  it("preserves generation when an already-dirty projection needs reconciliation", async () => {
    await withRewriteFixture(async ({ db, snapshot, scope }) => {
      const before = snapshot();
      db.prepare(
        "UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?",
      ).run(scope.sessionId);

      runOpenClawAgentWriteTransaction((database) => {
        replaceSqliteTranscriptSuffixInTransaction(
          database,
          scope,
          rewriteEvents,
          rewriteEvents.slice(0, 2),
        );
      }, scope);

      expect(snapshot().generation).toBe(before.generation);
      await waitForSessionTranscriptIndexReconcile(scope);
      expect(snapshot()).toMatchObject({
        generation: before.generation,
        raw: expect.arrayContaining([expect.objectContaining({ seq: 1 })]),
      });
      expect(snapshot().raw).toHaveLength(2);
      expect(sessionTranscriptIndexNeedsReconcile(db, scope.sessionId)).toBe(false);
    });
  });
});
