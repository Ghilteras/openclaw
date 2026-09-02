import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGithubIssue,
  createGithubIssueAsync,
  createPrefilledGithubIssueUrl,
} from "./github-issue.js";

const spawnSyncMock = vi.hoisted(() => vi.fn());
const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: spawnMock, spawnSync: spawnSyncMock };
});

describe("createGithubIssue", () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
    spawnMock.mockReset();
    vi.stubEnv("VITEST", undefined);
    vi.stubEnv("NODE_ENV", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("bounds the final encoded prefilled issue URL", () => {
    const url = createPrefilledGithubIssueUrl("Update failed 🦞", "🦞 &=?".repeat(2_000));

    expect(url.length).toBeLessThanOrEqual(16_384);
    expect(new URL(url).searchParams.get("body")).toContain("truncated for URL");
  });

  it.each([
    ["VITEST", "true"],
    ["NODE_ENV", "test"],
  ])("blocks the default async transport when %s marks a test process", async (key, value) => {
    vi.stubEnv(key, value);
    const fallbackUrl = "https://github.com/openclaw/openclaw/issues/new?title=update";

    await expect(
      createGithubIssueAsync({
        body: "sanitized body",
        title: "Update failed",
        url: fallbackUrl,
      }),
    ).resolves.toEqual({
      fallbackUrl,
      message: "External GitHub issue creation is disabled in test processes.",
      ok: false,
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("bounds the async GitHub CLI transport without blocking the process", async () => {
    vi.useFakeTimers();
    const child = new EventEmitter() as EventEmitter & {
      stdin: EventEmitter & { end: ReturnType<typeof vi.fn> };
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdin = Object.assign(new EventEmitter(), { end: vi.fn() });
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn(() => {
      queueMicrotask(() => child.emit("close", null));
      return true;
    });
    spawnMock.mockReturnValue(child);
    const fallbackUrl = "https://github.com/openclaw/openclaw/issues/new?title=update";

    const result = createGithubIssueAsync({
      body: "sanitized body",
      title: "Update failed",
      url: fallbackUrl,
    });
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(result).resolves.toEqual({
      ambiguous: true,
      message: "gh issue creation timed out",
      ok: false,
    });
    expect(spawnMock).toHaveBeenCalledWith(
      "gh",
      [
        "issue",
        "create",
        "--repo",
        "github.com/openclaw/openclaw",
        "--title",
        "Update failed",
        "--body-file",
        "-",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it.each([
    {
      ambiguous: false,
      label: "missing gh",
      result: {
        error: Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }),
        status: null,
        started: false,
        stderr: Buffer.alloc(0),
        stdout: Buffer.alloc(0),
      },
      message: "spawn gh ENOENT",
    },
    {
      ambiguous: true,
      label: "unauthenticated gh",
      result: {
        status: 4,
        started: true,
        stderr: Buffer.from("To get started with GitHub CLI, run: gh auth login"),
        stdout: Buffer.alloc(0),
      },
      message: "To get started with GitHub CLI, run: gh auth login",
    },
  ])("classifies the async transport for $label", async ({ ambiguous, result, message }) => {
    const fallbackUrl = "https://github.com/openclaw/openclaw/issues/new?title=update";

    await expect(
      createGithubIssueAsync(
        { body: "sanitized body", title: "Update failed", url: fallbackUrl },
        async () => result,
      ),
    ).resolves.toEqual({
      ...(ambiguous ? { ambiguous: true } : {}),
      ...(!ambiguous ? { fallbackUrl } : {}),
      message,
      ok: false,
    });
  });

  it.each([
    ["VITEST", "true"],
    ["NODE_ENV", "test"],
  ])("blocks the default GitHub CLI transport when %s marks a test process", (key, value) => {
    vi.stubEnv(key, value);
    const fallbackUrl = "https://github.com/openclaw/openclaw/issues/new?title=update";

    expect(
      createGithubIssue({
        body: "sanitized body",
        title: "Update failed",
        url: fallbackUrl,
      }),
    ).toEqual({
      fallbackUrl,
      message: "External GitHub issue creation is disabled in test processes.",
      ok: false,
    });
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("returns the issue URL after a successful authenticated CLI submission", () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stderr: Buffer.alloc(0),
      stdout: Buffer.from("https://github.com/openclaw/openclaw/issues/123\n"),
    });

    expect(
      createGithubIssue({
        body: "sanitized body",
        title: "Update failed",
        url: "https://github.com/openclaw/openclaw/issues/new?title=update",
      }),
    ).toEqual({ ok: true, url: "https://github.com/openclaw/openclaw/issues/123" });
  });

  it("keeps a successful exit with malformed output ambiguous", () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stderr: Buffer.alloc(0),
      stdout: Buffer.from("javascript:alert(1)\n"),
    });

    expect(
      createGithubIssue({
        body: "sanitized body",
        title: "Update failed",
        url: "https://github.com/openclaw/openclaw/issues/new?title=update",
      }),
    ).toEqual({
      ambiguous: true,
      message: "gh completed without a validated GitHub issue URL",
      ok: false,
    });
  });

  it("accepts a validated issue URL retained alongside a later transport error", () => {
    const timeoutError = Object.assign(new Error("spawnSync gh ETIMEDOUT"), {
      code: "ETIMEDOUT",
    });
    const issueUrl = "https://github.com/openclaw/openclaw/issues/123";
    expect(
      createGithubIssue(
        {
          body: "sanitized body",
          title: "Update failed",
          url: "https://github.com/openclaw/openclaw/issues/new?title=update",
        },
        () => ({
          error: timeoutError,
          status: null,
          started: true,
          stderr: Buffer.alloc(0),
          stdout: Buffer.from(`${issueUrl}\n`),
        }),
      ),
    ).toEqual({ ok: true, url: issueUrl });
  });

  it.each([
    {
      label: "signal after spawn",
      result: {
        status: null,
        started: true,
        stderr: Buffer.from("gh terminated by signal"),
        stdout: Buffer.alloc(0),
      },
    },
    {
      label: "nonzero after create",
      result: {
        status: 1,
        started: true,
        stderr: Buffer.from("post-create response failed"),
        stdout: Buffer.alloc(0),
      },
    },
    {
      label: "post-spawn EPERM",
      result: {
        error: Object.assign(new Error("kill EPERM"), { code: "EPERM" }),
        status: null,
        started: true,
        stderr: Buffer.alloc(0),
        stdout: Buffer.alloc(0),
      },
    },
  ])("keeps $label ambiguous without a validated issue URL", ({ result }) => {
    const fallbackUrl = "https://github.com/openclaw/openclaw/issues/new?title=update";
    expect(
      createGithubIssue(
        { body: "sanitized body", title: "Update failed", url: fallbackUrl },
        () => result,
      ),
    ).toMatchObject({ ambiguous: true, ok: false });
  });

  it("bounds GitHub CLI issue creation and marks timeout as ambiguous", () => {
    const timeoutError = Object.assign(new Error("spawnSync gh ETIMEDOUT"), {
      code: "ETIMEDOUT",
    });
    spawnSyncMock.mockReturnValue({
      error: timeoutError,
      status: null,
      stderr: Buffer.alloc(0),
      stdout: Buffer.alloc(0),
    });

    const result = createGithubIssue({
      body: "sanitized body",
      title: "Session SQLite migration recovery report",
      url: "https://github.com/openclaw/openclaw/issues/new?title=recovery",
    });

    expect(spawnSyncMock).toHaveBeenCalledWith(
      "gh",
      [
        "issue",
        "create",
        "--repo",
        "github.com/openclaw/openclaw",
        "--title",
        "Session SQLite migration recovery report",
        "--body-file",
        "-",
      ],
      {
        input: "sanitized body",
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024,
        timeout: 30_000,
      },
    );
    expect(result).toEqual({
      ambiguous: true,
      message: "spawnSync gh ETIMEDOUT",
      ok: false,
    });
  });

  it.each([
    {
      ambiguous: false,
      label: "missing gh",
      result: {
        error: Object.assign(new Error("spawnSync gh ENOENT"), { code: "ENOENT" }),
        status: null,
        started: false,
        stderr: Buffer.alloc(0),
        stdout: Buffer.alloc(0),
      },
      message: "spawnSync gh ENOENT",
    },
    {
      ambiguous: false,
      label: "unexecutable gh",
      result: {
        error: Object.assign(new Error("spawnSync gh EACCES"), { code: "EACCES" }),
        status: null,
        started: false,
        stderr: Buffer.alloc(0),
        stdout: Buffer.alloc(0),
      },
      message: "spawnSync gh EACCES",
    },
    {
      ambiguous: false,
      label: "test-blocked gh",
      result: {
        error: Object.assign(new Error("spawnSync gh EPERM"), { code: "EPERM" }),
        status: null,
        started: false,
        stderr: Buffer.alloc(0),
        stdout: Buffer.alloc(0),
      },
      message: "spawnSync gh EPERM",
    },
    {
      ambiguous: true,
      label: "unauthenticated gh",
      result: {
        status: 4,
        started: true,
        stderr: Buffer.from("To get started with GitHub CLI, run: gh auth login"),
        stdout: Buffer.alloc(0),
      },
      message: "To get started with GitHub CLI, run: gh auth login",
    },
  ])("classifies the sync transport for $label", ({ ambiguous, result, message }) => {
    spawnSyncMock.mockReturnValue(result);
    const fallbackUrl = "https://github.com/openclaw/openclaw/issues/new?title=update";

    expect(
      createGithubIssue({ body: "sanitized body", title: "Update failed", url: fallbackUrl }),
    ).toEqual({
      ...(ambiguous ? { ambiguous: true } : {}),
      ...(!ambiguous ? { fallbackUrl } : {}),
      message,
      ok: false,
    });
  });
});
