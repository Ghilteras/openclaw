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
  type GithubIssueCreateAsyncHooks,
  type GithubIssueCreateResult,
  type SanitizedGithubIssue,
} from "./github-issue.js";
import {
  finalizeUpdateFailureReportReceipt,
  markUpdateFailureReportReceiptPending,
  readUpdateFailureReportReceipt,
  refreshUpdateFailureReportReceiptPreparation,
  releaseUpdateFailureReportReceipt,
  reserveUpdateFailureReportReceipt,
  type UpdateFailureReportReceipt,
} from "./restart-sentinel.js";
import {
  assertUpdateReportPreCreateState,
  retryUpdateReportStateWrite,
  UpdateReportPreCreateGuardError,
} from "./update-failure-report-precreate.js";
import {
  discardUpdateFailureReportRecoveryBestEffort,
  readUpdateFailureReportRecovery,
  tryMatchUpdateFailureReportRecovery,
  writeUpdateFailureReportRecovery,
  type UpdateFailureReportRecovery,
} from "./update-failure-report-recovery.js";
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
      status: "pending";
      url?: undefined;
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
  if (receipt?.status === "pending" || receipt?.status === "preparing") {
    return {
      message:
        receipt.status === "pending"
          ? "This update attempt already has a report submission in progress."
          : "This update attempt already has a report preparation in progress.",
      savedReportPath,
      status: "pending",
    };
  }
  return {
    status: "duplicate",
    savedReportPath,
    ...(receipt?.url ? { url: receipt.url } : {}),
    ...(receipt?.fallbackUrl ? { fallbackUrl: receipt.fallbackUrl } : {}),
    message: receipt
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
      hooks: GithubIssueCreateAsyncHooks,
    ) => GithubIssueCreateResult | Promise<GithubIssueCreateResult>;
    env?: NodeJS.ProcessEnv;
    finalizeReceipt?: typeof finalizeUpdateFailureReportReceipt;
    hasCurrentAuthority?: () => boolean;
    markPending?: typeof markUpdateFailureReportReceiptPending;
    readReceipt?: typeof readUpdateFailureReportReceipt;
    refreshPreparation?: typeof refreshUpdateFailureReportReceiptPreparation;
    releaseReceipt?: typeof releaseUpdateFailureReportReceipt;
    stateDir?: string;
    validateCurrentAttempt?: () => boolean | Promise<boolean>;
    writeRecovery?: typeof writeUpdateFailureReportRecovery;
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
  const readReceipt = options.readReceipt ?? readUpdateFailureReportReceipt;
  const recovered = await readUpdateFailureReportRecovery(prepared.savedReportPath);
  if (recovered) {
    if (recovered.status === "fallback" && recovered.fallbackUrl !== prepared.url) {
      throw new Error("Saved update report fallback does not match the reviewed report.");
    }
    let currentReceipt: UpdateFailureReportReceipt | null = null;
    try {
      currentReceipt = readReceipt(prepared.attemptId, stateEnv);
    } catch {
      // A durable terminal record remains authoritative while the state database is unavailable.
    }
    if (currentReceipt && currentReceipt.reservationId !== recovered.reservationId) {
      await discardUpdateFailureReportRecoveryBestEffort(prepared.savedReportPath);
      return resultFromExistingReceipt(currentReceipt, prepared.savedReportPath);
    }
    const finalized = retryUpdateReportStateWrite(() =>
      finalizeReceipt(prepared.attemptId, recovered, stateEnv),
    );
    if (
      finalized ||
      tryMatchUpdateFailureReportRecovery(recovered, () =>
        readReceipt(prepared.attemptId, stateEnv),
      )
    ) {
      await discardUpdateFailureReportRecoveryBestEffort(prepared.savedReportPath);
    }
    if (recovered.status === "fallback") {
      return {
        fallbackUrl: recovered.fallbackUrl,
        message: "A saved prefilled browser report is ready.",
        savedReportPath: prepared.savedReportPath,
        status: "fallback",
      };
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
  const existingReceipt = readReceipt(prepared.attemptId, stateEnv);
  if (existingReceipt && existingReceipt.status !== "preparing") {
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

  const assertCurrentPreCreateState = () => assertUpdateReportPreCreateState(options);
  const afterAuthPreflight = assertCurrentPreCreateState;
  const beforeIssueCreate = async () => {
    await assertCurrentPreCreateState();
    const markPending = options.markPending ?? markUpdateFailureReportReceiptPending;
    if (!markPending(prepared.attemptId, reservationId, stateEnv)) {
      throw new UpdateReportPreCreateGuardError(
        "Update report preparation is no longer owned by this request.",
        "reservation",
      );
    }
  };
  const createIssue =
    options.createIssue ??
    ((issue: SanitizedGithubIssue, hooks: GithubIssueCreateAsyncHooks) =>
      createGithubIssueAsync(issue, undefined, hooks));
  let created: GithubIssueCreateResult;
  try {
    created = await createIssue(prepared, { afterAuthPreflight, beforeIssueCreate });
  } catch (error) {
    if (!(error instanceof UpdateReportPreCreateGuardError)) {
      throw error;
    }
    if (error.reason === "reservation") {
      return resultFromExistingReceipt(
        readReceipt(prepared.attemptId, stateEnv),
        prepared.savedReportPath,
      );
    }
    await discardSavedUpdateFailureReport(prepared, saved);
    if (!releaseReceipt(prepared.attemptId, reservationId, stateEnv)) {
      throw new Error("Cancelled update report reservation could not be released.", {
        cause: error,
      });
    }
    if (error.reason === "stale") {
      return {
        message: error.message,
        savedReportPath: prepared.savedReportPath,
        status: "stale",
      };
    }
    throw error;
  }
  if (created.ok) {
    const receipt: UpdateFailureReportRecovery = {
      reservationId,
      status: "created",
      url: created.url,
    };
    const finalized = retryUpdateReportStateWrite(() =>
      finalizeReceipt(prepared.attemptId, receipt, stateEnv),
    );
    if (finalized) {
      await discardUpdateFailureReportRecoveryBestEffort(prepared.savedReportPath);
      await discardSavedUpdateFailureReportBestEffort(prepared, saved, true);
    } else {
      const recoverySaved = await (options.writeRecovery ?? writeUpdateFailureReportRecovery)(
        prepared.savedReportPath,
        receipt,
      ).catch(() => false);
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
  if (created.ambiguous) {
    return {
      message:
        "GitHub issue submission may have completed, but confirmation was unavailable. Do not submit this report again.",
      savedReportPath: prepared.savedReportPath,
      status: "pending",
    };
  }
  const message = sanitizeReportField(created.message, context);
  const preparationRefreshed = retryUpdateReportStateWrite(() =>
    (options.refreshPreparation ?? refreshUpdateFailureReportReceiptPreparation)(
      prepared.attemptId,
      reservationId,
      stateEnv,
    ),
  );
  if (!preparationRefreshed) {
    let replacement: UpdateFailureReportReceipt | null = null;
    try {
      replacement = readReceipt(prepared.attemptId, stateEnv);
    } catch {
      // Without an authoritative owner, a browser link must not be published or persisted.
    }
    return resultFromExistingReceipt(replacement, prepared.savedReportPath);
  }
  const receipt: UpdateFailureReportRecovery = {
    fallbackUrl: created.fallbackUrl,
    reservationId,
    status: "fallback",
  };
  const fallbackFinalized = retryUpdateReportStateWrite(() =>
    finalizeReceipt(prepared.attemptId, receipt, stateEnv),
  );
  const fallbackRecovered =
    fallbackFinalized ||
    (await (options.writeRecovery ?? writeUpdateFailureReportRecovery)(
      prepared.savedReportPath,
      receipt,
    ).catch(() => false));
  if (!fallbackRecovered) {
    return {
      message:
        "The browser report handoff could not be saved safely. No issue submission was started; retry this action later.",
      savedReportPath: prepared.savedReportPath,
      status: "pending",
    };
  }
  return {
    fallbackUrl: created.fallbackUrl,
    message,
    savedReportPath: prepared.savedReportPath,
    status: "fallback",
  };
}
