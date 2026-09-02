/** Privacy-bounded, consent-gated reporting for one terminal update failure. */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
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
  reserveUpdateFailureReportReceipt,
  type UpdateFailureReportReceipt,
} from "./restart-sentinel.js";
import type { UpdateRunResult } from "./update-runner.js";

const UPDATE_REPORT_BODY_MAX_BYTES = 16_000;
const UPDATE_REPORT_FIELD_MAX_BYTES = 512;
const UPDATE_REPORT_DIAGNOSTIC_MAX_BYTES = 1_024;

export type PreparedUpdateFailureReport = SanitizedGithubIssue & {
  attemptId: string;
  previewDigest: string;
  savedReportPath: string;
};

export type UpdateFailureReportSubmitResult =
  | { savedReportPath: string; status: "created"; url: string }
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
  return value
    .replace(/(^|[\s("'`])\/(?:[^\s"'`<>]|\/(?!\/))+/gmu, "$1[redacted-path]")
    .replace(/\\\\[^\s"'`<>]+/gu, "[redacted-path]")
    .replace(/\b[A-Za-z]:\\[^\s"'`<>]+/gu, "[redacted-path]");
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
    stripExecutableRecoveryCommands(stripPrivatePaths(redacted)).trim(),
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
  if (input.error?.trim()) {
    diagnostics.push(
      `Error summary: ${sanitizeReportField(
        input.error,
        context,
        UPDATE_REPORT_DIAGNOSTIC_MAX_BYTES,
      )}`,
    );
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
  const saved = await savePreparedUpdateFailureReport(prepared, options.hasCurrentAuthority);
  if (options.validateCurrentAttempt && !(await options.validateCurrentAttempt())) {
    await discardSavedUpdateFailureReport(prepared, saved);
    return {
      message: "This failed update attempt is stale or unavailable.",
      savedReportPath: prepared.savedReportPath,
      status: "stale",
    };
  }
  if (options.hasCurrentAuthority && !options.hasCurrentAuthority()) {
    await discardSavedUpdateFailureReport(prepared, saved);
    throw new Error("Update report submission requires a current authenticated client.");
  }
  const reservationId = randomUUID();
  const reservation = reserveUpdateFailureReportReceipt(
    prepared.attemptId,
    reservationId,
    stateEnv,
  );
  if (!reservation.reserved) {
    if (
      reservation.receipt?.status === "created" ||
      (reservation.receipt?.status === "pending" && saved.reportCreated)
    ) {
      await discardSavedUpdateFailureReport(prepared, saved, true);
    }
    return resultFromExistingReceipt(reservation.receipt, prepared.savedReportPath);
  }

  const created = await (options.createIssue ?? createGithubIssueAsync)(prepared);
  if (created.ok) {
    const receipt: UpdateFailureReportReceipt = {
      reservationId,
      status: "created",
      url: created.url,
    };
    try {
      (options.finalizeReceipt ?? finalizeUpdateFailureReportReceipt)(
        prepared.attemptId,
        receipt,
        stateEnv,
      );
    } catch {
      // The external issue already exists; the pending reservation remains the no-retry fence.
    }
    await discardSavedUpdateFailureReport(prepared, saved, true);
    return { savedReportPath: prepared.savedReportPath, status: "created", url: created.url };
  }
  const message = sanitizeReportField(created.message, context);
  const receipt: UpdateFailureReportReceipt = {
    fallbackUrl: created.fallbackUrl,
    reservationId,
    status: "fallback",
  };
  if (!finalizeUpdateFailureReportReceipt(prepared.attemptId, receipt, stateEnv)) {
    throw new Error("Update failure report reservation could not be finalized.");
  }
  return {
    fallbackUrl: created.fallbackUrl,
    message,
    savedReportPath: prepared.savedReportPath,
    status: "fallback",
  };
}
