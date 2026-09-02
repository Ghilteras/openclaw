import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { safeParseJson } from "@openclaw/normalization-core";
import { isRecord as isPlainRecord } from "@openclaw/normalization-core/record-coerce";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import {
  buildRestartSentinelRow,
  nextRevision,
  readRestartSentinelRowForKeySync,
  type RestartSentinel,
  type RestartSentinelPayload,
} from "./restart-sentinel-store.js";

export type UpdateFailureReportReceipt = {
  fallbackUrl?: string;
  reservationId: string;
  status: "pending" | "created" | "fallback";
  url?: string;
};

type GatewayRestartSentinelDatabase = Pick<OpenClawStateKyselyDatabase, "gateway_restart_sentinel">;

const RECEIPT_KEY_PREFIX = "update-failure-report:";

function receiptKey(attemptId: string): string {
  return `${RECEIPT_KEY_PREFIX}${createHash("sha256").update(attemptId).digest("hex")}`;
}

function parseReceipt(sentinel: RestartSentinel | null): UpdateFailureReportReceipt | null {
  if (
    sentinel?.payload.kind !== "update" ||
    sentinel.payload.status !== "skipped" ||
    sentinel.payload.stats?.reason !== "update-failure-report-receipt" ||
    typeof sentinel.payload.message !== "string"
  ) {
    return null;
  }
  const value = safeParseJson(sentinel.payload.message);
  if (
    !isPlainRecord(value) ||
    (value.status !== "pending" && value.status !== "created" && value.status !== "fallback") ||
    typeof value.reservationId !== "string" ||
    (value.url !== undefined && typeof value.url !== "string") ||
    (value.fallbackUrl !== undefined && typeof value.fallbackUrl !== "string")
  ) {
    return null;
  }
  return {
    reservationId: value.reservationId,
    status: value.status,
    ...(typeof value.url === "string" ? { url: value.url } : {}),
    ...(typeof value.fallbackUrl === "string" ? { fallbackUrl: value.fallbackUrl } : {}),
  };
}

function readReceipt(db: DatabaseSync, attemptId: string): UpdateFailureReportReceipt | null {
  const current = readRestartSentinelRowForKeySync(db, receiptKey(attemptId));
  return parseReceipt(current.kind === "valid" ? current.sentinel : null);
}

/** Reads one existing report receipt without creating state. */
export function readUpdateFailureReportReceiptRowSync(
  db: DatabaseSync,
  attemptId: string,
): UpdateFailureReportReceipt | null {
  return readReceipt(db, attemptId);
}

function buildReceiptPayload(receipt: UpdateFailureReportReceipt): RestartSentinelPayload {
  return {
    kind: "update",
    status: "skipped",
    ts: Date.now(),
    message: JSON.stringify(receipt),
    stats: { reason: "update-failure-report-receipt" },
  };
}

/** Atomically owns one report attempt in the canonical state database. */
export function reserveUpdateFailureReportReceiptRowSync(
  db: DatabaseSync,
  attemptId: string,
  reservationId: string,
): { receipt: UpdateFailureReportReceipt | null; reserved: boolean } {
  const sentinelKey = receiptKey(attemptId);
  const stateDb = getNodeSqliteKysely<GatewayRestartSentinelDatabase>(db);
  const receipt: UpdateFailureReportReceipt = { reservationId, status: "pending" };
  const row = buildRestartSentinelRow(buildReceiptPayload(receipt), Date.now(), sentinelKey);
  const result = executeSqliteQuerySync(
    db,
    stateDb
      .insertInto("gateway_restart_sentinel")
      .values(row)
      .onConflict((conflict) => conflict.column("sentinel_key").doNothing()),
  );
  if (result.numAffectedRows === 1n) {
    return { receipt, reserved: true };
  }
  return { receipt: readReceipt(db, attemptId), reserved: false };
}

/** Finalizes only the process-owned pending reservation. */
export function finalizeUpdateFailureReportReceiptRowSync(
  db: DatabaseSync,
  attemptId: string,
  receipt: UpdateFailureReportReceipt,
): boolean {
  const sentinelKey = receiptKey(attemptId);
  const current = readRestartSentinelRowForKeySync(db, sentinelKey);
  const currentReceipt = parseReceipt(current.kind === "valid" ? current.sentinel : null);
  if (
    current.kind !== "valid" ||
    !currentReceipt ||
    currentReceipt.status !== "pending" ||
    currentReceipt.reservationId !== receipt.reservationId
  ) {
    return false;
  }
  const row = buildRestartSentinelRow(
    buildReceiptPayload(receipt),
    nextRevision(current.sentinel.revision),
    sentinelKey,
  );
  const stateDb = getNodeSqliteKysely<GatewayRestartSentinelDatabase>(db);
  const result = executeSqliteQuerySync(
    db,
    stateDb
      .updateTable("gateway_restart_sentinel")
      .set(row)
      .where("sentinel_key", "=", sentinelKey)
      .where("updated_at_ms", "=", current.sentinel.revision),
  );
  return result.numAffectedRows === 1n;
}

/** Releases only the process-owned pending reservation before any external side effect. */
export function releaseUpdateFailureReportReceiptRowSync(
  db: DatabaseSync,
  attemptId: string,
  reservationId: string,
): boolean {
  const sentinelKey = receiptKey(attemptId);
  const current = readRestartSentinelRowForKeySync(db, sentinelKey);
  const currentReceipt = parseReceipt(current.kind === "valid" ? current.sentinel : null);
  if (
    current.kind !== "valid" ||
    !currentReceipt ||
    currentReceipt.status !== "pending" ||
    currentReceipt.reservationId !== reservationId
  ) {
    return false;
  }
  const stateDb = getNodeSqliteKysely<GatewayRestartSentinelDatabase>(db);
  const result = executeSqliteQuerySync(
    db,
    stateDb
      .deleteFrom("gateway_restart_sentinel")
      .where("sentinel_key", "=", sentinelKey)
      .where("updated_at_ms", "=", current.sentinel.revision),
  );
  return result.numAffectedRows === 1n;
}
