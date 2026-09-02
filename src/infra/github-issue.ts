/** Creates sanitized OpenClaw GitHub issues through the installed GitHub CLI. */
import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { truncateUtf8Prefix } from "../utils/utf8-truncate.js";

export type SanitizedGithubIssue = {
  body: string;
  title: string;
  url: string;
};

export type GithubIssueCreateResult =
  | { ok: true; url: string }
  | { fallbackUrl: string; message: string; ok: false };

type SpawnGh = (
  args: readonly string[],
  options: { input: string },
) => Pick<SpawnSyncReturns<Buffer>, "error" | "status" | "stderr" | "stdout">;

type GithubCliResult = Pick<SpawnSyncReturns<Buffer>, "error" | "status" | "stderr" | "stdout">;
type RunGhAsync = (args: readonly string[], options: { input: string }) => Promise<GithubCliResult>;

const GITHUB_ISSUE_CREATE_TIMEOUT_MS = 30_000;
const GITHUB_PREFILL_BODY_MAX_BYTES = 6_000;
const GITHUB_PREFILL_TITLE_MAX_BYTES = 512;
const GITHUB_PREFILL_URL_MAX_CHARS = 16_384;
const GITHUB_PREFILL_TRUNCATED_SUFFIX =
  "\n\n...(truncated for URL; see the saved sanitized report for the complete body)";
const REPOSITORY_ISSUES_URL = "https://github.com/openclaw/openclaw/issues";

function buildPrefilledGithubIssueUrl(title: string, body: string): string {
  const params = new URLSearchParams({ body, title });
  return `https://github.com/openclaw/openclaw/issues/new?${params.toString()}`;
}

/** Builds the browser handoff used when the authenticated GitHub CLI is unavailable. */
export function createPrefilledGithubIssueUrl(title: string, body: string): string {
  const boundedTitle = truncateUtf8Prefix(title, GITHUB_PREFILL_TITLE_MAX_BYTES);
  const fullUrl = buildPrefilledGithubIssueUrl(boundedTitle, body);
  if (
    Buffer.byteLength(body, "utf8") <= GITHUB_PREFILL_BODY_MAX_BYTES &&
    fullUrl.length <= GITHUB_PREFILL_URL_MAX_CHARS
  ) {
    return fullUrl;
  }

  let low = 0;
  let high = Math.min(Buffer.byteLength(body, "utf8"), GITHUB_PREFILL_BODY_MAX_BYTES);
  let boundedUrl = buildPrefilledGithubIssueUrl(boundedTitle, GITHUB_PREFILL_TRUNCATED_SUFFIX);
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = buildPrefilledGithubIssueUrl(
      boundedTitle,
      `${truncateUtf8Prefix(body, middle)}${GITHUB_PREFILL_TRUNCATED_SUFFIX}`,
    );
    if (candidate.length <= GITHUB_PREFILL_URL_MAX_CHARS) {
      boundedUrl = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return boundedUrl;
}

/** Creates an openclaw/openclaw issue through the GitHub CLI using sanitized stdin. */
export function createGithubIssue(
  issue: SanitizedGithubIssue,
  spawnGh: SpawnGh = defaultSpawnGh,
): GithubIssueCreateResult {
  return resolveGithubIssueCreateResult(
    issue,
    spawnGh(
      [
        "issue",
        "create",
        "--repo",
        "openclaw/openclaw",
        "--title",
        issue.title,
        "--body-file",
        "-",
      ],
      { input: issue.body },
    ),
  );
}

/** Async issue creation for Gateway request paths; never blocks the event loop on `gh`. */
export async function createGithubIssueAsync(
  issue: SanitizedGithubIssue,
  runGh: RunGhAsync = defaultRunGhAsync,
): Promise<GithubIssueCreateResult> {
  return resolveGithubIssueCreateResult(
    issue,
    await runGh(
      [
        "issue",
        "create",
        "--repo",
        "openclaw/openclaw",
        "--title",
        issue.title,
        "--body-file",
        "-",
      ],
      { input: issue.body },
    ),
  );
}

function resolveGithubIssueCreateResult(
  issue: SanitizedGithubIssue,
  result: GithubCliResult,
): GithubIssueCreateResult {
  if (!result.error && result.status === 0) {
    const outputUrl = String(result.stdout).trim().split(/\r?\n/).at(-1);
    let url = REPOSITORY_ISSUES_URL;
    try {
      const parsed = new URL(outputUrl ?? "");
      if (
        parsed.protocol === "https:" &&
        parsed.hostname === "github.com" &&
        /^\/openclaw\/openclaw\/issues\/\d+$/u.test(parsed.pathname)
      ) {
        url = parsed.toString();
      }
    } catch {
      // A successful gh exit without its normal issue URL still means the issue was created.
    }
    return { ok: true, url };
  }
  const stderr = String(result.stderr).trim();
  const error = result.error
    ? result.error.message
    : stderr || `gh exited ${result.status ?? "unknown"}`;
  return {
    fallbackUrl: issue.url,
    message: error,
    ok: false,
  };
}

function testProcessBlockResult(): GithubCliResult {
  return {
    error: Object.assign(
      new Error("External GitHub issue creation is disabled in test processes."),
      { code: "EPERM" },
    ),
    status: null,
    stderr: Buffer.alloc(0),
    stdout: Buffer.alloc(0),
  };
}

async function defaultRunGhAsync(
  args: readonly string[],
  options: { input: string },
): Promise<GithubCliResult> {
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return testProcessBlockResult();
  }
  return await new Promise<GithubCliResult>((resolve) => {
    const child = spawn("gh", [...args], { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let error: Error | undefined;
    let settled = false;
    const appendBounded = (chunks: Buffer[], chunk: Buffer, currentBytes: number): number => {
      const remaining = 1024 * 1024 - currentBytes;
      if (remaining <= 0) {
        return currentBytes;
      }
      chunks.push(chunk.subarray(0, remaining));
      return currentBytes + Math.min(chunk.byteLength, remaining);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes = appendBounded(stdout, chunk, stdoutBytes);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes = appendBounded(stderr, chunk, stderrBytes);
    });
    child.on("error", (spawnError) => {
      error = spawnError;
    });
    const timeout = setTimeout(() => {
      error = Object.assign(new Error("gh issue creation timed out"), { code: "ETIMEDOUT" });
      child.kill("SIGKILL");
    }, GITHUB_ISSUE_CREATE_TIMEOUT_MS);
    timeout.unref?.();
    child.on("close", (status) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({
        ...(error ? { error } : {}),
        status,
        stderr: Buffer.concat(stderr),
        stdout: Buffer.concat(stdout),
      });
    });
    child.stdin.on("error", () => {
      // The process result owns the actionable error and fallback.
    });
    child.stdin.end(options.input);
  });
}

function defaultSpawnGh(
  args: readonly string[],
  options: { input: string },
): Pick<SpawnSyncReturns<Buffer>, "error" | "status" | "stderr" | "stdout"> {
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return testProcessBlockResult();
  }
  return spawnSync("gh", [...args], {
    input: options.input,
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
    timeout: GITHUB_ISSUE_CREATE_TIMEOUT_MS,
  });
}
