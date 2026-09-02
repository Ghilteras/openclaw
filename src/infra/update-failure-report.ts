/** Privacy-bounded, consent-gated reporting for one terminal update failure. */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord as isPlainRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveStateDir } from "../config/paths.js";
import { redactSupportString } from "../logging/diagnostic-support-redaction.js";
import { classifyUpdateOutcome } from "../shared/update-outcome.js";
import { truncateUtf8Prefix } from "../utils/utf8-truncate.js";
import { VERSION } from "../version.js";
import {
  createGithubIssueAsync,
  createPrefilledGithubIssueUrl,
  type GithubIssueCreateResult,
  type SanitizedGithubIssue,
} from "./github-issue.js";
import {
  finalizeUpdateFailureReportReceipt,
  readUpdateFailureReportReceipt,
  releaseUpdateFailureReportReceipt,
  reserveUpdateFailureReportReceipt,
  type UpdateFailureReportReceipt,
} from "./restart-sentinel.js";
import type { UpdateRunResult } from "./update-runner.js";

const UPDATE_REPORT_BODY_MAX_BYTES = 16_000;
const UPDATE_REPORT_FIELD_MAX_BYTES = 512;

export type PreparedUpdateFailureReport = SanitizedGithubIssue & {
  attemptId: string;
  previewDigest: string;
  savedReportPath: string;
};

export type UpdateFailureReportSubmitResult =
  | { message?: string; savedReportPath: string; status: "created"; url: string }
  | {
      fallbackUrl: string;
      message: string;
      savedReportPath: string;
      status: "fallback";
    }
  | {
      fallbackUrl?: string;
      message: string;
      savedReportPath: string;
      status: "duplicate";
      url?: string;
    }
  | {
      fallbackUrl?: undefined;
      message: string;
      savedReportPath: string;
      status: "stale";
      url?: undefined;
    };

export type UpdateFailureReportInput = {
  attemptId: string;
  error?: string;
  result: UpdateRunResult;
  target?: string;
};

type UpdateFailureReportContext = {
  env: NodeJS.ProcessEnv;
  stateDir: string;
};

function stripPrivatePaths(value: string): string {
  // An unquoted final path component and trailing prose are grammatically
  // indistinguishable. Treat only the physical line containing a path as
  // private instead of guessing at a filename boundary.
  const privatePathLine =
    /\$OPENCLAW_STATE_DIR[\\/]|(?:^|[^\p{L}\p{N}._~-])(?:\/+|\\\\|[A-Za-z]:[\\/]|~[\\/])/u;
  return value
    .split(/(\r\n|[\n\r\u2028\u2029])/u)
    .map((line) =>
      /^(?:\r\n|[\n\r\u2028\u2029])$/u.test(line)
        ? line
        : privatePathLine.test(line)
          ? "[redacted-path]"
          : line,
    )
    .join("");
}

function stripExecutableRecoveryCommands(value: string): string {
  return value.replace(
    /\b(?:openclaw|pnpm|npm|bun|git|yarn|node|npx|deno|curl|wget|bash|sh|zsh|powershell|pwsh|cmd|brew|apt|apt-get|dnf|yum|docker|systemctl|launchctl)\s+[^\r\n]*/giu,
    "[redacted-command]",
  );
}

function sanitizeReportField(
  value: unknown,
  context: UpdateFailureReportContext,
  maxBytes = UPDATE_REPORT_FIELD_MAX_BYTES,
): string {
  const text =
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
      ? String(value)
      : "unknown";
  const redacted = redactSupportString(text, {
    env: context.env,
    stateDir: context.stateDir,
  });
  return truncateUtf8Prefix(
    stripPrivatePaths(stripExecutableRecoveryCommands(redacted)).trim(),
    maxBytes,
  );
}

function resolveFailedSteps(result: UpdateRunResult) {
  return result.steps.filter(
    (step) =>
      !step.advisory &&
      (step.exitCode !== 0 || step.killed === true || step.termination === "timeout"),
  );
}

function resolveFailedPhase(result: UpdateRunResult, context: UpdateFailureReportContext): string {
  const failed = resolveFailedSteps(result).at(-1);
  return sanitizeReportField(failed?.name ?? result.reason ?? "unknown", context);
}

function resolveUpdateTarget(
  input: UpdateFailureReportInput,
  context: UpdateFailureReportContext,
): string {
  const explicit = input.target?.trim();
  if (explicit) {
    return sanitizeReportField(explicit, context);
  }
  const afterVersion = input.result.after?.version?.trim();
  if (afterVersion) {
    return sanitizeReportField(`version ${afterVersion}`, context);
  }
  const afterSha = input.result.after?.sha?.trim();
  if (afterSha) {
    return sanitizeReportField(`commit ${afterSha}`, context);
  }
  return sanitizeReportField(`${input.result.mode} update (exact target unavailable)`, context);
}

function resolveRollbackOutcome(
  result: UpdateRunResult,
  context: UpdateFailureReportContext,
): string {
  if (result.recovery?.serviceRestartSafe === true) {
    return "verified safe to restart";
  }
  if (result.recovery?.serviceRestartSafe === false) {
    return sanitizeReportField(`not verified (${result.recovery.reason})`, context);
  }
  return "not recorded";
}

function renderBoundedDiagnostics(
  input: UpdateFailureReportInput,
  context: UpdateFailureReportContext,
): string[] {
  const diagnostics = [
    `Result: ${input.result.status}`,
    `Update mode: ${sanitizeReportField(input.result.mode, context)}`,
    `Reason code: ${sanitizeReportField(input.result.reason ?? "unknown", context)}`,
  ];
  for (const step of resolveFailedSteps(input.result).slice(-3)) {
    const phase = sanitizeReportField(step.name, context);
    const termination = step.termination ? `, termination ${step.termination}` : "";
    diagnostics.push(`Failed phase ${phase}: exit ${step.exitCode ?? "unknown"}${termination}`);
  }
  return diagnostics;
}

function resolveReportPaths(
  attemptId: string,
  stateDir: string,
): {
  reportDir: string;
  reportPath: string;
} {
  const key = createHash("sha256").update(attemptId).digest("hex");
  const reportDir = path.join(stateDir, "update-reports");
  return {
    reportDir,
    reportPath: path.join(reportDir, `${key}.md`),
  };
}

/** Builds the exact sanitized body the user must review before submission. */
export async function prepareUpdateFailureReport(
  input: UpdateFailureReportInput,
  options: { env?: NodeJS.ProcessEnv; stateDir?: string } = {},
): Promise<PreparedUpdateFailureReport> {
  if (!input.attemptId.trim()) {
    throw new Error("Update report attempt identity is required.");
  }
  if (classifyUpdateOutcome(input.result) !== "failed") {
    throw new Error("Only a final failed update can be reported.");
  }
  const env = options.env ?? process.env;
  const stateDir = options.stateDir ?? resolveStateDir(env);
  const context = { env, stateDir };
  const version = sanitizeReportField(VERSION, context);
  const platform = sanitizeReportField(`${process.platform}/${process.arch}`, context);
  const target = resolveUpdateTarget(input, context);
  const phase = resolveFailedPhase(input.result, context);
  const rollback = resolveRollbackOutcome(input.result, context);
  const body = truncateUtf8Prefix(
    [
      "# OpenClaw update failure report",
      "",
      "This report was explicitly reviewed and confirmed in OpenClaw.",
      "",
      `- OpenClaw version: ${version}`,
      `- Platform: ${platform}`,
      `- Update target: ${target}`,
      `- Failed phase: ${phase}`,
      `- Rollback outcome: ${rollback}`,
      "",
      "## Bounded diagnostics",
      "",
      ...renderBoundedDiagnostics(input, context).map((line) => `- ${line}`),
      "",
    ].join("\n"),
    UPDATE_REPORT_BODY_MAX_BYTES,
  );
  const title = sanitizeReportField(`Update failure: ${phase} (${version})`, context, 200).replace(
    /\s+/gu,
    " ",
  );
  const url = createPrefilledGithubIssueUrl(title, body);
  const { reportPath } = resolveReportPaths(input.attemptId, stateDir);
  return {
    attemptId: input.attemptId,
    body,
    previewDigest: createHash("sha256").update(body).digest("hex"),
    savedReportPath: reportPath,
    title,
    url,
  };
}

type SavedUpdateFailureReport = {
  reportCreated: boolean;
  reportDirCreated: boolean;
};

type CreatedUpdateFailureReportRecovery = {
  reservationId: string;
  status: "created";
  url: string;
};

function hasErrorCode(error: unknown, ...codes: string[]): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    codes.includes(error.code)
  );
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

async function discardSavedUpdateFailureReport(
  prepared: PreparedUpdateFailureReport,
  saved: SavedUpdateFailureReport,
  removeExistingReport = false,
): Promise<void> {
  if (saved.reportCreated || removeExistingReport) {
    await fs.rm(prepared.savedReportPath, { force: true });
  }
  if (saved.reportDirCreated || removeExistingReport) {
    await fs.rmdir(path.dirname(prepared.savedReportPath)).catch((error: unknown) => {
      if (!hasErrorCode(error, "ENOENT", "ENOTEMPTY")) {
        throw error;
      }
    });
  }
}

async function discardSavedUpdateFailureReportBestEffort(
  prepared: PreparedUpdateFailureReport,
  saved: SavedUpdateFailureReport,
  removeExistingReport = false,
): Promise<void> {
  await discardSavedUpdateFailureReport(prepared, saved, removeExistingReport).catch(() => {});
}

function terminalRecoveryPath(prepared: PreparedUpdateFailureReport): string {
  return `${prepared.savedReportPath}.result.json`;
}

function isSafeCreatedIssueUrl(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname === "github.com" &&
      /^\/openclaw\/openclaw\/issues(?:\/\d+)?$/u.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

async function readCreatedReportRecovery(
  prepared: PreparedUpdateFailureReport,
): Promise<CreatedUpdateFailureReportRecovery | null> {
  let raw: string;
  try {
    raw = await fs.readFile(terminalRecoveryPath(prepared), "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
  const value: unknown = JSON.parse(raw);
  if (
    !isPlainRecord(value) ||
    value.status !== "created" ||
    typeof value.reservationId !== "string" ||
    !isSafeCreatedIssueUrl(value.url)
  ) {
    throw new Error("Saved update report recovery is invalid.");
  }
  return { reservationId: value.reservationId, status: "created", url: value.url };
}

async function writeCreatedReportRecovery(
  prepared: PreparedUpdateFailureReport,
  recovery: CreatedUpdateFailureReportRecovery,
): Promise<boolean> {
  const recoveryPath = terminalRecoveryPath(prepared);
  const temporaryPath = `${recoveryPath}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(JSON.stringify(recovery), "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.link(temporaryPath, recoveryPath);
    await fs.rm(temporaryPath, { force: true });
    if (process.platform !== "win32") {
      const directory = await fs.open(path.dirname(recoveryPath), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
    return true;
  } catch (error) {
    if (hasErrorCode(error, "EEXIST")) {
      const existing = await readCreatedReportRecovery(prepared).catch(() => null);
      if (existing?.reservationId === recovery.reservationId && existing.url === recovery.url) {
        return true;
      }
    }
    return false;
  } finally {
    await handle?.close().catch(() => {});
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

async function discardCreatedReportRecoveryBestEffort(
  prepared: PreparedUpdateFailureReport,
): Promise<void> {
  await fs.rm(terminalRecoveryPath(prepared), { force: true }).catch(() => {});
}

/** Persists one reviewed body while rechecking the caller's live authority around every write. */
async function savePreparedUpdateFailureReport(
  prepared: PreparedUpdateFailureReport,
  hasCurrentAuthority?: () => boolean,
): Promise<SavedUpdateFailureReport> {
  const ensureCurrentAuthority = () => {
    if (hasCurrentAuthority && !hasCurrentAuthority()) {
      throw new Error("Update report persistence requires a current authenticated client.");
    }
  };
  const reportDir = path.dirname(prepared.savedReportPath);
  ensureCurrentAuthority();
  const reportDirExisted = await pathExists(reportDir);
  ensureCurrentAuthority();
  await fs.mkdir(reportDir, { mode: 0o700, recursive: true });
  const saved: SavedUpdateFailureReport = {
    reportCreated: false,
    reportDirCreated: !reportDirExisted,
  };
  try {
    ensureCurrentAuthority();
    try {
      await fs.writeFile(prepared.savedReportPath, prepared.body, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      saved.reportCreated = true;
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) {
        throw error;
      }
      const existing = await fs
        .readFile(prepared.savedReportPath, "utf8")
        .catch((readError: unknown) => {
          if (hasErrorCode(readError, "ENOENT")) {
            return undefined;
          }
          throw readError;
        });
      if (existing !== undefined && existing !== prepared.body) {
        throw new Error("The saved update report does not match the reviewed preview.", {
          cause: error,
        });
      }
    }
    ensureCurrentAuthority();
    if (saved.reportCreated) {
      await fs.chmod(prepared.savedReportPath, 0o600);
    }
    ensureCurrentAuthority();
    return saved;
  } catch (error) {
    await discardSavedUpdateFailureReport(prepared, saved);
    throw error;
  }
}

function resultFromExistingReceipt(
  receipt: UpdateFailureReportReceipt | null,
  savedReportPath: string,
): UpdateFailureReportSubmitResult {
  return {
    status: "duplicate",
    savedReportPath,
    ...(receipt?.url ? { url: receipt.url } : {}),
    ...(receipt?.fallbackUrl ? { fallbackUrl: receipt.fallbackUrl } : {}),
    message:
      receipt?.status === "pending"
        ? "This update attempt already has a report submission in progress."
        : receipt
          ? "This update attempt was already reported."
          : "This update attempt already has a report reservation.",
  };
}

function finalizeReceiptWithRetry(
  finalizeReceipt: typeof finalizeUpdateFailureReportReceipt,
  attemptId: string,
  receipt: UpdateFailureReportReceipt,
  env: NodeJS.ProcessEnv,
): boolean {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      if (finalizeReceipt(attemptId, receipt, env)) {
        return true;
      }
    } catch {
      // A transient state-database failure gets one retry before preserving the local fallback.
    }
  }
  return false;
}

/** Consumes one reviewed preview and invokes the shared GitHub issue creator at most once. */
export async function submitUpdateFailureReport(
  prepared: PreparedUpdateFailureReport,
  previewDigest: string,
  options: {
    createIssue?: (
      issue: SanitizedGithubIssue,
    ) => GithubIssueCreateResult | Promise<GithubIssueCreateResult>;
    env?: NodeJS.ProcessEnv;
    finalizeReceipt?: typeof finalizeUpdateFailureReportReceipt;
    hasCurrentAuthority?: () => boolean;
    readReceipt?: typeof readUpdateFailureReportReceipt;
    releaseReceipt?: typeof releaseUpdateFailureReportReceipt;
    stateDir?: string;
    validateCurrentAttempt?: () => boolean | Promise<boolean>;
  } = {},
): Promise<UpdateFailureReportSubmitResult> {
  if (previewDigest !== prepared.previewDigest) {
    throw new Error("The update report preview is stale. Review it again before submitting.");
  }
  const env = options.env ?? process.env;
  const stateDir = options.stateDir ?? resolveStateDir(env);
  const context = { env, stateDir };
  const stateEnv = { ...env, OPENCLAW_STATE_DIR: stateDir };
  if (options.hasCurrentAuthority && !options.hasCurrentAuthority()) {
    throw new Error("Update report submission requires a current authenticated client.");
  }
  const finalizeReceipt = options.finalizeReceipt ?? finalizeUpdateFailureReportReceipt;
  const recovered = await readCreatedReportRecovery(prepared);
  if (recovered) {
    const finalized = finalizeReceiptWithRetry(
      finalizeReceipt,
      prepared.attemptId,
      recovered,
      stateEnv,
    );
    if (finalized) {
      await discardCreatedReportRecoveryBestEffort(prepared);
    }
    await discardSavedUpdateFailureReportBestEffort(
      prepared,
      { reportCreated: false, reportDirCreated: false },
      true,
    );
    return {
      savedReportPath: prepared.savedReportPath,
      status: "created",
      url: recovered.url,
    };
  }
  const existingReceipt = (options.readReceipt ?? readUpdateFailureReportReceipt)(
    prepared.attemptId,
    stateEnv,
  );
  if (existingReceipt) {
    if (existingReceipt.status === "created") {
      await discardSavedUpdateFailureReportBestEffort(
        prepared,
        { reportCreated: false, reportDirCreated: false },
        true,
      );
    }
    return resultFromExistingReceipt(existingReceipt, prepared.savedReportPath);
  }
  if (options.validateCurrentAttempt && !(await options.validateCurrentAttempt())) {
    return {
      message: "This failed update attempt is stale or unavailable.",
      savedReportPath: prepared.savedReportPath,
      status: "stale",
    };
  }

  const reservationId = randomUUID();
  const reservation = reserveUpdateFailureReportReceipt(
    prepared.attemptId,
    reservationId,
    stateEnv,
  );
  if (!reservation.reserved) {
    if (reservation.receipt?.status === "created") {
      await discardSavedUpdateFailureReportBestEffort(
        prepared,
        { reportCreated: false, reportDirCreated: false },
        true,
      );
    }
    return resultFromExistingReceipt(reservation.receipt, prepared.savedReportPath);
  }

  const releaseReceipt = options.releaseReceipt ?? releaseUpdateFailureReportReceipt;
  let saved: SavedUpdateFailureReport | undefined;
  try {
    saved = await savePreparedUpdateFailureReport(prepared, options.hasCurrentAuthority);
    if (options.validateCurrentAttempt && !(await options.validateCurrentAttempt())) {
      await discardSavedUpdateFailureReport(prepared, saved);
      if (!releaseReceipt(prepared.attemptId, reservationId, stateEnv)) {
        throw new Error("Stale update report reservation could not be released.");
      }
      return {
        message: "This failed update attempt is stale or unavailable.",
        savedReportPath: prepared.savedReportPath,
        status: "stale",
      };
    }
    if (options.hasCurrentAuthority && !options.hasCurrentAuthority()) {
      throw new Error("Update report submission requires a current authenticated client.");
    }
  } catch (error) {
    if (saved) {
      await discardSavedUpdateFailureReportBestEffort(prepared, saved);
    }
    try {
      releaseReceipt(prepared.attemptId, reservationId, stateEnv);
    } catch {
      // The original preparation or authority failure remains actionable.
    }
    throw error;
  }
  if (!saved) {
    throw new Error("Update report was not saved by its reservation owner.");
  }

  const created = await (options.createIssue ?? createGithubIssueAsync)(prepared);
  if (created.ok) {
    const receipt: CreatedUpdateFailureReportRecovery = {
      reservationId,
      status: "created",
      url: created.url,
    };
    const finalized = finalizeReceiptWithRetry(
      finalizeReceipt,
      prepared.attemptId,
      receipt,
      stateEnv,
    );
    if (finalized) {
      await discardCreatedReportRecoveryBestEffort(prepared);
      await discardSavedUpdateFailureReportBestEffort(prepared, saved, true);
    } else {
      const recoverySaved = await writeCreatedReportRecovery(prepared, receipt);
      if (recoverySaved) {
        await discardSavedUpdateFailureReportBestEffort(prepared, saved, true);
      } else {
        return {
          message:
            "GitHub issue was created, but its local receipt could not be saved. Do not submit this report again.",
          savedReportPath: prepared.savedReportPath,
          status: "created",
          url: created.url,
        };
      }
    }
    return { savedReportPath: prepared.savedReportPath, status: "created", url: created.url };
  }
  const message = sanitizeReportField(created.message, context);
  const receipt: UpdateFailureReportReceipt = {
    fallbackUrl: created.fallbackUrl,
    reservationId,
    status: "fallback",
  };
  finalizeReceiptWithRetry(finalizeReceipt, prepared.attemptId, receipt, stateEnv);
  return {
    fallbackUrl: created.fallbackUrl,
    message,
    savedReportPath: prepared.savedReportPath,
    status: "fallback",
  };
}
