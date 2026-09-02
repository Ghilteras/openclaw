import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { GithubIssueCreateAsyncHooks, SanitizedGithubIssue } from "./github-issue.js";
import {
  finalizeUpdateFailureReportReceipt,
  readUpdateFailureReportReceipt,
} from "./restart-sentinel.js";
import { prepareUpdateFailureReport, submitUpdateFailureReport } from "./update-failure-report.js";
import type { UpdateRunResult } from "./update-runner.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function failedUpdate(overrides: Partial<UpdateRunResult> = {}): UpdateRunResult {
  return {
    status: "error",
    mode: "git",
    reason: "build-failed",
    before: { sha: "a".repeat(40), version: "2026.8.1" },
    after: { sha: "b".repeat(40), version: "2026.8.2" },
    steps: [
      {
        name: "build",
        command: "pnpm build --token raw-command-secret",
        cwd: "/Users/private/openclaw",
        durationMs: 12,
        exitCode: 1,
        stdoutTail: "raw chat and log output must not be copied",
        stderrTail: "token=raw-log-secret /Users/private/openclaw/build.log",
      },
    ],
    durationMs: 20,
    recovery: { serviceRestartSafe: true, version: "2026.8.1" },
    ...overrides,
  };
}

function mockCreatedIssue(url: string) {
  return vi.fn(async (_issue: SanitizedGithubIssue, hooks: GithubIssueCreateAsyncHooks) => {
    await hooks.afterAuthPreflight?.();
    await hooks.beforeIssueCreate?.();
    return { ok: true as const, url };
  });
}

function mockFallbackIssue(fallbackUrl: string, message = "GitHub CLI unavailable") {
  return vi.fn(async (_issue: SanitizedGithubIssue, hooks: GithubIssueCreateAsyncHooks) => {
    await hooks.afterAuthPreflight?.();
    return { fallbackUrl, message, ok: false as const };
  });
}

function mockAmbiguousIssue(message: string) {
  return vi.fn(async (_issue: SanitizedGithubIssue, hooks: GithubIssueCreateAsyncHooks) => {
    await hooks.afterAuthPreflight?.();
    await hooks.beforeIssueCreate?.();
    return { ambiguous: true as const, message, ok: false as const };
  });
}

describe("update failure report", () => {
  it("saves only allowlisted, redacted, Unicode-safe report facts for fallback", async () => {
    const home = tempDirs.make("openclaw-update-report-");
    const stateDir = path.join(home, ".openclaw");
    const secret = "sk-test-update-report-secret-1234567890";
    const emoji = "🦞".repeat(2_000);
    const prepared = await prepareUpdateFailureReport(
      {
        attemptId: "attempt-redaction",
        error: `opaque raw chat payload token=${secret} ${home}/private/error.log`,
        result: failedUpdate({
          reason:
            "build-failed at /Users/Alice Smith/private/customer list.txt after checksum mismatch",
          steps: [
            {
              ...failedUpdate().steps[0]!,
              name: `Command failed: /usr/local/bin/openclaw doctor --fix ${home}/source token=${secret}`,
            },
          ],
        }),
        target: [
          `origin/main token=${secret}`,
          "windows C:\\Users\\Alice Smith\\private\\project after windows marker",
          "unc \\\\server\\Alice Smith\\private\\project after unc marker",
          'quoted "/Users/Alice Smith/private project" after quoted marker',
          emoji,
        ].join("\n"),
      },
      { env: { HOME: home, OPENCLAW_STATE_DIR: stateDir }, stateDir },
    );
    await expect(fs.stat(prepared.savedReportPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      submitUpdateFailureReport(prepared, prepared.previewDigest, {
        createIssue: mockFallbackIssue(
          "https://github.com/openclaw/openclaw/issues/new?title=update",
        ),
        env: { HOME: home, OPENCLAW_STATE_DIR: stateDir },
        stateDir,
      }),
    ).resolves.toMatchObject({ status: "fallback" });

    const saved = await fs.readFile(prepared.savedReportPath, "utf8");
    expect(saved).toBe(prepared.body);
    expect(Buffer.byteLength(saved, "utf8")).toBeLessThanOrEqual(16_000);
    expect(saved).toContain("Rollback outcome: verified safe to restart");
    expect(saved).toContain("Failed phase:");
    expect(saved).toContain("Update target:");
    expect(saved).toContain("🦞");
    expect(saved).toContain("[redacted-path]");
    expect(saved).not.toContain("�");
    expect(saved).not.toContain(secret);
    expect(saved).not.toContain(home);
    expect(saved).not.toContain("/var/lib/openclaw");
    expect(saved).not.toContain("/Users/alice");
    expect(saved).not.toContain("Alice Smith");
    expect(saved).not.toContain("customer list.txt");
    expect(saved).not.toContain("after checksum mismatch");
    expect(saved).not.toContain("https://example.com/?next=/docs");
    expect(saved).not.toContain("opaque raw chat payload");
    expect(saved).not.toContain("raw-command-secret");
    expect(saved).not.toContain("raw-log-secret");
    expect(saved).not.toContain("raw chat and log output");
    expect(saved).not.toContain("openclaw doctor --fix");
    expect(saved).not.toContain("C:\\Users\\private");
    expect(saved).not.toContain("\\\\server\\private");
    if (process.platform !== "win32") {
      expect((await fs.stat(path.dirname(prepared.savedReportPath))).mode & 0o777).toBe(0o700);
      expect((await fs.stat(prepared.savedReportPath)).mode & 0o777).toBe(0o600);
    }
  });

  it("submits once and rejects a duplicate click for the same attempt", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-once", result: failedUpdate() },
      { stateDir },
    );
    const createIssue = mockCreatedIssue("https://github.com/openclaw/openclaw/issues/123");

    const [first, second] = await Promise.all([
      submitUpdateFailureReport(prepared, prepared.previewDigest, { createIssue, stateDir }),
      submitUpdateFailureReport(prepared, prepared.previewDigest, { createIssue, stateDir }),
    ]);
    const third = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue,
      stateDir,
      validateCurrentAttempt: () => false,
    });

    expect(createIssue).toHaveBeenCalledOnce();
    expect([first.status, second.status].toSorted()).toEqual(["created", "pending"]);
    expect(third).toMatchObject({
      status: "duplicate",
      url: "https://github.com/openclaw/openclaw/issues/123",
    });
    await expect(fs.stat(prepared.savedReportPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cancels preparation when authority closes immediately before issue creation", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-auth-preflight-authority", result: failedUpdate() },
      { stateDir },
    );
    let authorityCurrent = true;
    let issueCreateCalls = 0;
    const createIssue = vi.fn(
      async (_issue: SanitizedGithubIssue, hooks: GithubIssueCreateAsyncHooks) => {
        await hooks.afterAuthPreflight?.();
        authorityCurrent = false;
        await hooks.beforeIssueCreate?.();
        issueCreateCalls += 1;
        return { ok: true as const, url: "https://github.com/openclaw/openclaw/issues/123" };
      },
    );

    await expect(
      submitUpdateFailureReport(prepared, prepared.previewDigest, {
        createIssue,
        hasCurrentAuthority: () => authorityCurrent,
        stateDir,
        validateCurrentAttempt: () => true,
      }),
    ).rejects.toThrow("current authenticated client");
    expect(issueCreateCalls).toBe(0);
    await expect(fs.stat(prepared.savedReportPath)).rejects.toMatchObject({ code: "ENOENT" });

    authorityCurrent = true;
    const retryCreateIssue = vi.fn(
      async (_issue: SanitizedGithubIssue, hooks: GithubIssueCreateAsyncHooks) => {
        await hooks.afterAuthPreflight?.();
        await hooks.beforeIssueCreate?.();
        issueCreateCalls += 1;
        return { ok: true as const, url: "https://github.com/openclaw/openclaw/issues/124" };
      },
    );
    await expect(
      submitUpdateFailureReport(prepared, prepared.previewDigest, {
        createIssue: retryCreateIssue,
        hasCurrentAuthority: () => authorityCurrent,
        stateDir,
        validateCurrentAttempt: () => true,
      }),
    ).resolves.toMatchObject({ status: "created" });
    expect(issueCreateCalls).toBe(1);
  });

  it("cancels preparation when the canonical attempt changes immediately before issue creation", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-auth-preflight-stale", result: failedUpdate() },
      { stateDir },
    );
    let currentAttempt = true;
    let issueCreateCalls = 0;
    const createIssue = vi.fn(
      async (_issue: SanitizedGithubIssue, hooks: GithubIssueCreateAsyncHooks) => {
        await hooks.afterAuthPreflight?.();
        currentAttempt = false;
        await hooks.beforeIssueCreate?.();
        issueCreateCalls += 1;
        return { ok: true as const, url: "https://github.com/openclaw/openclaw/issues/123" };
      },
    );

    await expect(
      submitUpdateFailureReport(prepared, prepared.previewDigest, {
        createIssue,
        stateDir,
        validateCurrentAttempt: () => currentAttempt,
      }),
    ).resolves.toMatchObject({ status: "stale" });
    expect(issueCreateCalls).toBe(0);
    await expect(fs.stat(prepared.savedReportPath)).rejects.toMatchObject({ code: "ENOENT" });

    currentAttempt = true;
    const retryCreateIssue = vi.fn(
      async (_issue: SanitizedGithubIssue, hooks: GithubIssueCreateAsyncHooks) => {
        await hooks.afterAuthPreflight?.();
        await hooks.beforeIssueCreate?.();
        issueCreateCalls += 1;
        return { ok: true as const, url: "https://github.com/openclaw/openclaw/issues/124" };
      },
    );
    await expect(
      submitUpdateFailureReport(prepared, prepared.previewDigest, {
        createIssue: retryCreateIssue,
        stateDir,
        validateCurrentAttempt: () => currentAttempt,
      }),
    ).resolves.toMatchObject({ status: "created" });
    expect(issueCreateCalls).toBe(1);
  });

  it("releases the reservation when the post-preflight attempt refresh throws", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-auth-preflight-refresh-error", result: failedUpdate() },
      { stateDir },
    );
    let issueCreateCalls = 0;
    const validateCurrentAttempt = vi
      .fn<() => boolean>()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockImplementationOnce(() => {
        throw new Error("restart sentinel refresh unavailable");
      });
    const createIssue = vi.fn(
      async (_issue: SanitizedGithubIssue, hooks: GithubIssueCreateAsyncHooks) => {
        await hooks.afterAuthPreflight?.();
        await hooks.beforeIssueCreate?.();
        issueCreateCalls += 1;
        return { ok: true as const, url: "https://github.com/openclaw/openclaw/issues/123" };
      },
    );

    await expect(
      submitUpdateFailureReport(prepared, prepared.previewDigest, {
        createIssue,
        stateDir,
        validateCurrentAttempt,
      }),
    ).rejects.toThrow("could not be rechecked");
    expect(issueCreateCalls).toBe(0);
    await expect(fs.stat(prepared.savedReportPath)).rejects.toMatchObject({ code: "ENOENT" });

    const retryCreateIssue = vi.fn(
      async (_issue: SanitizedGithubIssue, hooks: GithubIssueCreateAsyncHooks) => {
        await hooks.afterAuthPreflight?.();
        await hooks.beforeIssueCreate?.();
        issueCreateCalls += 1;
        return { ok: true as const, url: "https://github.com/openclaw/openclaw/issues/124" };
      },
    );
    await expect(
      submitUpdateFailureReport(prepared, prepared.previewDigest, {
        createIssue: retryCreateIssue,
        stateDir,
        validateCurrentAttempt: () => true,
      }),
    ).resolves.toMatchObject({ status: "created" });
    expect(issueCreateCalls).toBe(1);
  });

  it("does not let a pending-reservation loser delete the winner's fallback report", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-pending-fallback-race", result: failedUpdate() },
      { stateDir },
    );
    let finishValidation!: () => void;
    const validationGate = new Promise<boolean>((resolve) => {
      finishValidation = () => resolve(true);
    });
    const delayedCreateIssue = vi.fn();
    const delayed = submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue: delayedCreateIssue,
      stateDir,
      validateCurrentAttempt: () => validationGate,
    });
    const fallbackUrl = "https://github.com/openclaw/openclaw/issues/new?title=update";
    let finishFallback!: () => void;
    const createIssue = vi.fn(
      async (_issue: SanitizedGithubIssue, hooks: GithubIssueCreateAsyncHooks) => {
        await hooks.afterAuthPreflight?.();
        return await new Promise<{ fallbackUrl: string; message: string; ok: false }>((resolve) => {
          finishFallback = () =>
            resolve({ fallbackUrl, message: "GitHub CLI unavailable", ok: false });
        });
      },
    );
    const winner = submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue,
      stateDir,
    });
    await vi.waitFor(() => expect(createIssue).toHaveBeenCalledOnce());
    expect(await fs.readFile(prepared.savedReportPath, "utf8")).toBe(prepared.body);

    finishValidation();
    const delayedResult = await delayed;
    expect(delayedResult).toMatchObject({ status: "pending" });
    expect(delayedResult).not.toHaveProperty("fallbackUrl");
    expect(delayedCreateIssue).not.toHaveBeenCalled();
    finishFallback();
    await expect(winner).resolves.toMatchObject({ status: "fallback", fallbackUrl });
    expect(await fs.readFile(prepared.savedReportPath, "utf8")).toBe(prepared.body);
  });

  it("reclaims an expired pre-create preparation without letting its old owner submit", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-expired-preparation", result: failedUpdate() },
      { stateDir },
    );
    let nowMs = 1_800_000_000_000;
    const now = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    let releaseOldPreparation!: () => void;
    const oldPreparationGate = new Promise<void>((resolve) => {
      releaseOldPreparation = resolve;
    });
    let issueCreateCalls = 0;
    const oldCreateIssue = vi.fn(
      async (_issue: SanitizedGithubIssue, hooks: GithubIssueCreateAsyncHooks) => {
        await hooks.afterAuthPreflight?.();
        await oldPreparationGate;
        await hooks.beforeIssueCreate?.();
        issueCreateCalls += 1;
        return { ok: true as const, url: "https://github.com/openclaw/openclaw/issues/122" };
      },
    );

    const oldSubmission = submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue: oldCreateIssue,
      stateDir,
    });
    await vi.waitFor(() => expect(oldCreateIssue).toHaveBeenCalledOnce());
    expect(
      readUpdateFailureReportReceipt(prepared.attemptId, {
        OPENCLAW_STATE_DIR: stateDir,
      }),
    ).toMatchObject({ status: "preparing" });

    nowMs += 10 * 60_000;
    const replacement = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue: mockCreatedIssue("https://github.com/openclaw/openclaw/issues/123"),
      stateDir,
    });
    releaseOldPreparation();
    const oldResult = await oldSubmission;
    now.mockRestore();

    expect(replacement).toMatchObject({
      status: "created",
      url: "https://github.com/openclaw/openclaw/issues/123",
    });
    expect(oldResult).toMatchObject({
      status: "duplicate",
      url: "https://github.com/openclaw/openclaw/issues/123",
    });
    expect(issueCreateCalls).toBe(0);
  });

  it.each([
    ["returns false", () => false],
    [
      "throws",
      () => {
        throw new Error("receipt database unavailable");
      },
    ],
  ])("returns a created URL without retrying when receipt finalization %s", async (_, fail) => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-created-finalize-failure", result: failedUpdate() },
      { stateDir },
    );
    const issueUrl = "https://github.com/openclaw/openclaw/issues/123";
    const createIssue = mockCreatedIssue(issueUrl);
    const finalizeReceipt = vi.fn(finalizeUpdateFailureReportReceipt).mockImplementationOnce(fail);

    const first = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue,
      finalizeReceipt,
      stateDir,
    });
    const second = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue,
      stateDir,
    });

    expect(first).toMatchObject({ status: "created", url: issueUrl });
    expect(second).toMatchObject({ status: "duplicate", url: issueUrl });
    expect(createIssue).toHaveBeenCalledOnce();
    expect(finalizeReceipt).toHaveBeenCalledTimes(2);
    await expect(fs.stat(prepared.savedReportPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers a durable created result before rejecting the original attempt as stale", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-created-finalize-unavailable", result: failedUpdate() },
      { stateDir },
    );
    const issueUrl = "https://github.com/openclaw/openclaw/issues/123";
    const createIssue = mockCreatedIssue(issueUrl);
    const finalizeReceipt = vi.fn(() => false);

    const first = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue,
      finalizeReceipt,
      stateDir,
    });
    const recoveryPath = `${prepared.savedReportPath}.result.json`;
    const recovery = JSON.parse(await fs.readFile(recoveryPath, "utf8")) as unknown;
    expect(recovery).toEqual({
      reservationId: expect.any(String),
      status: "created",
      url: issueUrl,
    });
    await expect(fs.stat(prepared.savedReportPath)).rejects.toMatchObject({ code: "ENOENT" });
    if (process.platform !== "win32") {
      expect((await fs.stat(recoveryPath)).mode & 0o777).toBe(0o600);
    }

    const second = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue,
      stateDir,
      validateCurrentAttempt: () => false,
    });

    expect(first).toMatchObject({ status: "created", url: issueUrl });
    expect(second).toMatchObject({ status: "created", url: issueUrl });
    expect(createIssue).toHaveBeenCalledOnce();
    expect(finalizeReceipt).toHaveBeenCalledTimes(2);
    await expect(fs.stat(prepared.savedReportPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(recoveryPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not hide a created result when saved-report cleanup fails", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-created-cleanup-failure", result: failedUpdate() },
      { stateDir },
    );
    const issueUrl = "https://github.com/openclaw/openclaw/issues/123";
    const createIssue = mockCreatedIssue(issueUrl);
    const realRm = fs.rm.bind(fs);
    const rm = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (target === prepared.savedReportPath) {
        throw new Error("simulated saved-report cleanup failure");
      }
      return await realRm(target, options);
    });
    let first: Awaited<ReturnType<typeof submitUpdateFailureReport>>;
    try {
      first = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
        createIssue,
        stateDir,
      });
    } finally {
      rm.mockRestore();
    }

    expect(first).toMatchObject({ status: "created", url: issueUrl });
    expect(await fs.readFile(prepared.savedReportPath, "utf8")).toBe(prepared.body);
    const second = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue,
      stateDir,
    });
    expect(second).toMatchObject({ status: "duplicate", url: issueUrl });
    expect(createIssue).toHaveBeenCalledOnce();
    await expect(fs.stat(prepared.savedReportPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("surfaces durable-recovery failure without replaying a created issue", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-created-recovery-failure", result: failedUpdate() },
      { stateDir },
    );
    const issueUrl = "https://github.com/openclaw/openclaw/issues/123";
    const createIssue = mockCreatedIssue(issueUrl);
    const finalizeReceipt = vi.fn(() => false);
    const recoveryPath = `${prepared.savedReportPath}.result.json`;
    const realLink = fs.link.bind(fs);
    const link = vi.spyOn(fs, "link").mockImplementation(async (existingPath, newPath) => {
      if (newPath === recoveryPath) {
        throw Object.assign(new Error("simulated recovery publication failure"), { code: "EIO" });
      }
      return await realLink(existingPath, newPath);
    });
    let first: Awaited<ReturnType<typeof submitUpdateFailureReport>>;
    try {
      first = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
        createIssue,
        finalizeReceipt,
        stateDir,
      });
    } finally {
      link.mockRestore();
    }

    expect(first).toMatchObject({
      message: expect.stringContaining("local receipt could not be saved"),
      status: "created",
      url: issueUrl,
    });
    expect(await fs.readFile(prepared.savedReportPath, "utf8")).toBe(prepared.body);
    await expect(fs.stat(recoveryPath)).rejects.toMatchObject({ code: "ENOENT" });
    const second = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue,
      stateDir,
    });
    expect(second).toMatchObject({ status: "pending" });
    expect(createIssue).toHaveBeenCalledOnce();
  });

  it("keeps an unresolved fallback receipt from replaying transport", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-fallback-finalize-unavailable", result: failedUpdate() },
      { stateDir },
    );
    const fallbackUrl = "https://github.com/openclaw/openclaw/issues/new?title=update";
    const createIssue = mockFallbackIssue(fallbackUrl);
    const finalizeReceipt = vi.fn(() => false);

    const first = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue,
      finalizeReceipt,
      stateDir,
    });
    const second = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue,
      stateDir,
    });

    expect(first).toMatchObject({ status: "fallback", fallbackUrl });
    expect(second).toMatchObject({ status: "pending" });
    expect(second).not.toHaveProperty("fallbackUrl");
    expect(createIssue).toHaveBeenCalledOnce();
    expect(await fs.readFile(prepared.savedReportPath, "utf8")).toBe(prepared.body);
  });

  it("keeps the event loop responsive while issue creation is pending", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-responsive", result: failedUpdate() },
      { stateDir },
    );
    let resolveIssue!: (result: { ok: true; url: string }) => void;
    const createIssue = vi.fn(
      async (_issue: SanitizedGithubIssue, hooks: GithubIssueCreateAsyncHooks) => {
        await hooks.afterAuthPreflight?.();
        await hooks.beforeIssueCreate?.();
        return await new Promise<{ ok: true; url: string }>((resolve) => {
          resolveIssue = resolve;
        });
      },
    );

    const submission = submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue,
      stateDir,
    });
    await vi.waitFor(() => expect(createIssue).toHaveBeenCalledOnce());
    let timerRan = false;
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        timerRan = true;
        resolve();
      }, 0);
    });
    expect(timerRan).toBe(true);

    resolveIssue({ ok: true, url: "https://github.com/openclaw/openclaw/issues/123" });
    await expect(submission).resolves.toMatchObject({ status: "created" });
  });

  it("keeps timeout ambiguity pending without exposing a replay link", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-timeout", result: failedUpdate() },
      { stateDir },
    );
    const createIssue = mockAmbiguousIssue("spawnSync gh ETIMEDOUT");
    let nowMs = 1_800_000_000_000;
    const now = vi.spyOn(Date, "now").mockImplementation(() => nowMs);

    const first = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue,
      stateDir,
    });
    expect(
      readUpdateFailureReportReceipt(prepared.attemptId, {
        OPENCLAW_STATE_DIR: stateDir,
      }),
    ).toMatchObject({ status: "pending" });
    nowMs += 10 * 60_000;
    const second = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      createIssue,
      stateDir,
    });
    now.mockRestore();

    expect(first).toMatchObject({ status: "pending" });
    expect(first).not.toHaveProperty("fallbackUrl");
    expect(second).toMatchObject({ status: "pending" });
    expect(second).not.toHaveProperty("fallbackUrl");
    expect(createIssue).toHaveBeenCalledOnce();
  });

  it("requires the submitted body to match the reviewed preview", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-stale-preview", result: failedUpdate() },
      { stateDir },
    );
    const createIssue = vi.fn();

    await expect(
      submitUpdateFailureReport(prepared, "stale-digest", { createIssue, stateDir }),
    ).rejects.toThrow("preview is stale");
    expect(createIssue).not.toHaveBeenCalled();
    await expect(fs.stat(prepared.savedReportPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes a newly saved body when the canonical attempt changes before reservation", async () => {
    const stateDir = tempDirs.make("openclaw-update-report-");
    const prepared = await prepareUpdateFailureReport(
      { attemptId: "attempt-replaced", result: failedUpdate() },
      { stateDir },
    );
    const createIssue = vi.fn();

    await expect(
      submitUpdateFailureReport(prepared, prepared.previewDigest, {
        createIssue,
        stateDir,
        validateCurrentAttempt: () => false,
      }),
    ).resolves.toMatchObject({ status: "stale" });

    expect(createIssue).not.toHaveBeenCalled();
    await expect(fs.stat(prepared.savedReportPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
