import path from "node:path";
import { openFileBackedSessionManagerForTest } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mcpMocks = vi.hoisted(() => ({
  requesterCalls: 0,
  requesterParams: [] as Array<Record<string, unknown>>,
  threadConfigCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness-runtime")>();
  return {
    ...actual,
    materializeRequesterScopedMcpToolsForHarnessRun: async (
      ...args: Parameters<typeof actual.materializeRequesterScopedMcpToolsForHarnessRun>
    ) => {
      mcpMocks.requesterCalls += 1;
      mcpMocks.requesterParams.push(args[0] as Record<string, unknown>);
      return undefined;
    },
    loadCodexBundleMcpThreadConfig: async (
      ...args: Parameters<typeof actual.loadCodexBundleMcpThreadConfig>
    ) => {
      const params = args[0] as Record<string, unknown>;
      mcpMocks.threadConfigCalls.push(params);
      const cfg = params.cfg as
        | { mcp?: { servers?: Record<string, Record<string, unknown>> } }
        | undefined;
      const configuredServers = cfg?.mcp?.servers ?? {};
      const staticServerNames = Object.keys(configuredServers).toSorted();
      return {
        configPatch: staticServerNames.length > 0 ? { mcp_servers: configuredServers } : undefined,
        diagnostics: [],
        evaluated: true,
        fingerprint: staticServerNames.length > 0 ? "configured-mcp-test-fixture" : undefined,
        staticServerNames,
        userStaticServerNames: staticServerNames,
      };
    },
  };
});

import {
  assistantMessage,
  createParams,
  createCodexRuntimePlanFixture,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setCodexTestModelSupportsTools,
  setupRunAttemptTestHooks,
  tempDir,
  userMessage,
} from "./run-attempt-test-harness.js";
import {
  readCodexAppServerBinding,
  registerCodexTestSessionIdentity,
  writeCodexAppServerBinding,
} from "./session-binding.test-helpers.js";

setupRunAttemptTestHooks();

beforeEach(() => {
  mcpMocks.requesterCalls = 0;
  mcpMocks.requesterParams.length = 0;
  mcpMocks.threadConfigCalls.length = 0;
});

function configureFakeMcp(params: ReturnType<typeof createParams>): void {
  setCodexTestModelSupportsTools(params, true);
  params.cleanupBundleMcpOnRunEnd = true;
  params.runtimePlan = createCodexRuntimePlanFixture();
  params.preparedModelRuntime = {
    metadataSnapshot: { manifestRegistry: { plugins: [] }, plugins: [] },
  } as never;
  params.config = {
    ...params.config,
    mcp: {
      servers: {
        fake: {
          command: process.execPath,
          args: [path.resolve("scripts/e2e/mcp-app-conformance-server.mjs")],
          codex: { defaultToolsApprovalMode: "prompt" },
        },
      },
    },
  };
}

describe("configured MCP uses the same ownership for interactive and scheduled work", () => {
  it("does not replace bundle discovery with partial prepared plugin metadata", async () => {
    const sessionFile = path.join(tempDir, "session-partial-manifest-registry.jsonl");
    const params = createParams(sessionFile, path.join(tempDir, "workspace-partial-registry"));
    configureFakeMcp(params);
    const manifestRegistry = { plugins: [] };
    params.preparedModelRuntime = {
      metadataSnapshot: { manifestRegistry, pluginIds: ["codex"], plugins: [] },
    } as never;

    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");

    expect(mcpMocks.threadConfigCalls[0]?.manifestRegistry).toBeUndefined();

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await expect(run).resolves.toBeDefined();
  });

  it.each(["user", "cron"] as const)("keeps configured MCP native for %s runs", async (trigger) => {
    const sessionFile = path.join(tempDir, "session-" + trigger + ".jsonl");
    const params = createParams(sessionFile, path.join(tempDir, "workspace-" + trigger));
    configureFakeMcp(params);
    params.trigger = trigger;
    if (trigger === "cron") params.scheduledToolPolicy = { version: 1, mode: "trusted" };
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    const request = harness.requests.find((request) => request.method === "thread/start");
    const start = request?.params as
      | { config?: Record<string, unknown>; dynamicTools?: unknown }
      | undefined;
    // Scheduling must not move MCP into gateway wrappers or disable the native
    // environment. That changes both authentication and where shell work runs.
    expect(start?.config).toMatchObject({ mcp_servers: { fake: { command: process.execPath } } });
    expect(start?.config?.["features.shell_tool"]).not.toBe(false);
    expect(JSON.stringify(start?.dynamicTools)).not.toContain("fake__show");
    expect(mcpMocks.requesterCalls).toBe(1);
    expect(harness.requests.map((request) => request.method)).not.toContain("mcpServerStatus/list");
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await expect(run).resolves.toBeDefined();
    expect(
      (await readCodexAppServerBinding(sessionFile))?.configuredMcpOwnershipVersion,
    ).toBeUndefined();
  });

  it("still disables native MCP and shell for an actually restricted turn", async () => {
    const sessionFile = path.join(tempDir, "session-restricted.jsonl");
    const params = createParams(sessionFile, path.join(tempDir, "workspace-restricted"));
    configureFakeMcp(params);
    params.toolsAllow = ["cron"];
    params.pluginHarnessToolPolicyRestricted = true;
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "config/read") {
        return { config: { mcp_servers: { fake: { enabled: true } } }, origins: {}, layers: [] };
      }
      if (method === "mcpServerStatus/list") {
        return { data: [{ name: "fake", tools: {}, serverInfo: null }], nextCursor: null };
      }
      return undefined;
    });
    const run = runCodexAppServerAttempt(params);
    await Promise.race([
      harness.waitForMethod("turn/start"),
      run.then((result) => {
        throw new Error(`restricted turn finished before turn/start: ${JSON.stringify(result)}`);
      }),
    ]);
    const request = harness.requests.find((request) => request.method === "thread/start");
    expect((request?.params as { config?: unknown })?.config).toMatchObject({
      "features.shell_tool": false,
      mcp_servers: { fake: { enabled: false } },
    });
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await expect(run).resolves.toBeDefined();
  });

  it("preserves conversation history when a legacy scheduled MCP binding returns to native ownership", async () => {
    const sessionFile = path.join(tempDir, "session-scheduled-mcp-ownership-continuity.jsonl");
    const workspaceDir = path.join(tempDir, "workspace-scheduled-mcp-ownership-continuity");
    const cutoff = Date.now();
    registerCodexTestSessionIdentity(sessionFile, "session-1", "agent:main:session-1");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-scheduled-old",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      dynamicToolsFingerprint: "[]",
      configuredMcpOwnershipVersion: 1,
      historyCoveredThrough: new Date(cutoff).toISOString(),
    });
    const sessionManager = openFileBackedSessionManagerForTest(sessionFile, {
      sessionId: "session-1",
    });
    sessionManager.appendMessage(userMessage("ordinary-thread covered context", cutoff - 1_000));
    for (let index = 0; index < 10; index += 1) {
      sessionManager.appendMessage(
        assistantMessage(
          `scheduled ownership continuity block ${index}: ${"x".repeat(128_000)}`,
          cutoff + 2_000 + index,
        ),
      );
    }
    sessionManager.appendMessage(userMessage("new scheduled ownership question", cutoff + 20_000));
    sessionManager.appendMessage(
      assistantMessage("recent scheduled ownership answer", cutoff + 21_000),
    );

    const params = createParams(sessionFile, workspaceDir);
    configureFakeMcp(params);
    params.prompt = "continue after the scheduled ownership transition";
    params.trigger = "cron";
    params.scheduledToolPolicy = { version: 1, mode: "trusted" };
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "thread/start") {
        await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
          threadId: "thread-scheduled-old",
        });
      }
      return undefined;
    });

    const run = runCodexAppServerAttempt(params, {
      pluginConfig: {
        appServer: { approvalPolicy: "never", sandbox: "danger-full-access" },
      },
    });
    await harness.waitForMethod("turn/start");
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;

    expect(harness.requests.map((request) => request.method)).toContain("thread/start");
    expect(harness.requests.map((request) => request.method)).not.toContain("thread/resume");
    const turnStart = harness.requests.find((request) => request.method === "turn/start");
    const inputText =
      (turnStart?.params as { input?: Array<{ text?: string }> } | undefined)?.input?.[0]?.text ??
      "";
    expect(inputText.length).toBeLessThanOrEqual(1 << 20);
    expect(inputText).toContain("OpenClaw assembled context for this turn:");
    expect(inputText).toContain("new scheduled ownership question");
    expect(inputText).toContain("recent scheduled ownership answer");
    expect(inputText).toContain("Current user request:");
    expect(inputText).toContain("continue after the scheduled ownership transition");
    expect(await readCodexAppServerBinding(sessionFile)).toMatchObject({
      threadId: "thread-1",
    });
    expect(
      (await readCodexAppServerBinding(sessionFile))?.configuredMcpOwnershipVersion,
    ).toBeUndefined();
  });
});
