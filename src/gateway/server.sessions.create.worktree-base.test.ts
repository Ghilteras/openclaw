import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, expect, test, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import type { ChatAbortControllerEntry } from "./chat-abort.js";
import {
  controlUiClient,
  initializeRepository,
  settleWorkspaceRuns,
} from "./server.sessions.create.projects.test-support.js";
import { dispatchInboundMessageMock, testState } from "./test-helpers.js";
import {
  directSessionReq,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();
const execFileAsync = promisify(execFile);

afterEach(() => {
  dispatchInboundMessageMock.mockReset();
  closeOpenClawStateDatabaseForTest();
  testState.agentConfig = undefined;
});

test("sessions.create rejects an invalid worktree base before persisting the session", async () => {
  const root = tempDirs.make("openclaw-session-invalid-worktree-base-");
  const workspace = await initializeRepository(root, "workspace");
  testState.agentConfig = { workspace };
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:dashboard:invalid-worktree-base";

  const created = await directSessionReq(
    "sessions.create",
    {
      agentId: "main",
      key: sessionKey,
      message: "Start from the requested change",
      worktree: true,
      worktreeBaseRef: "126887",
    },
    controlUiClient,
  );

  expect(created).toMatchObject({
    ok: false,
    error: {
      code: "INVALID_REQUEST",
      message: expect.stringContaining("does not resolve to a commit"),
    },
  });
  expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).toBeUndefined();
  expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
});

test("chat.send resumes a session with a legacy invalid worktree base from the default", async () => {
  const root = tempDirs.make("openclaw-session-recover-worktree-base-");
  const workspace = await initializeRepository(root, "workspace");
  testState.agentConfig = { workspace };
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:dashboard:recover-worktree-base";
  const created = await directSessionReq<{ key: string }>(
    "sessions.create",
    { agentId: "main", key: sessionKey },
    controlUiClient,
  );
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  const entry = loadSessionEntry({ agentId: "main", sessionKey, storePath });
  expect(entry).toBeDefined();
  await replaceSessionEntry(
    { agentId: "main", sessionKey, storePath },
    {
      ...entry!,
      pendingWorktree: {
        workspace,
        name: "recovered-base",
        baseRef: "126887",
        titleSource: "Recover the saved worktree",
      },
    },
  );
  dispatchInboundMessageMock.mockResolvedValue({
    queuedFinal: false,
    counts: { block: 0, final: 0, tool: 0 },
  });
  const broadcast = vi.fn();
  const context = { broadcast, chatAbortControllers: new Map<string, ChatAbortControllerEntry>() };

  try {
    const sent = await directSessionReq(
      "chat.send",
      {
        agentId: "main",
        sessionKey,
        message: "Retry without changing the saved session",
        idempotencyKey: "recover-worktree-base",
      },
      { ...controlUiClient, context },
    );

    expect(sent.ok, JSON.stringify(sent.error)).toBe(true);
    await settleWorkspaceRuns(context, storePath, sessionKey);
    expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
    expect(
      broadcast.mock.calls.filter(
        ([event, payload]) => event === "chat" && payload.state === "error",
      ),
    ).toEqual([]);
    const recovered = loadSessionEntry({ agentId: "main", sessionKey, storePath });
    expect(recovered).not.toHaveProperty("pendingWorktree");
    expect(managedWorktrees.findLiveByOwner("session", sessionKey)?.baseRef).toBe("HEAD");
  } finally {
    await settleWorkspaceRuns(context, storePath, sessionKey, true);
    const owned = managedWorktrees.findLiveByOwner("session", sessionKey);
    if (owned) {
      await managedWorktrees.remove({
        id: owned.id,
        reason: "test-cleanup",
        allowSnapshotLoss: true,
      });
    }
  }
});

test("chat.send keeps a validated worktree base pending when the ref disappears", async () => {
  const root = tempDirs.make("openclaw-session-missing-validated-worktree-base-");
  const workspace = await initializeRepository(root, "workspace");
  await execFileAsync("git", ["-C", workspace, "branch", "accepted-base"]);
  testState.agentConfig = { workspace };
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:dashboard:missing-validated-worktree-base";
  const created = await directSessionReq<{ key: string }>(
    "sessions.create",
    { agentId: "main", key: sessionKey },
    controlUiClient,
  );
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  const entry = loadSessionEntry({ agentId: "main", sessionKey, storePath });
  expect(entry).toBeDefined();
  await replaceSessionEntry(
    { agentId: "main", sessionKey, storePath },
    {
      ...entry!,
      pendingWorktree: {
        workspace,
        name: "missing-validated-base",
        baseRef: "accepted-base",
        baseRefPolicy: "strict",
        titleSource: "Keep the selected base pending",
      },
    },
  );
  await execFileAsync("git", ["-C", workspace, "branch", "-D", "accepted-base"]);
  const broadcast = vi.fn();
  const context = { broadcast, chatAbortControllers: new Map<string, ChatAbortControllerEntry>() };

  const sent = await directSessionReq(
    "chat.send",
    {
      agentId: "main",
      sessionKey,
      message: "Retry the accepted worktree",
      idempotencyKey: "missing-validated-worktree-base",
    },
    { ...controlUiClient, context },
  );

  expect(sent.ok, JSON.stringify(sent.error)).toBe(true);
  await settleWorkspaceRuns(context, storePath, sessionKey);
  expect(broadcast).toHaveBeenCalledWith(
    "chat",
    expect.objectContaining({
      runId: "missing-validated-worktree-base",
      sessionKey,
      state: "error",
      errorMessage: expect.stringContaining("does not resolve to a commit"),
    }),
    expect.anything(),
  );
  expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
  expect(
    loadSessionEntry({ agentId: "main", sessionKey, storePath })?.pendingWorktree,
  ).toMatchObject({
    baseRef: "accepted-base",
    baseRefPolicy: "strict",
  });
  expect(managedWorktrees.findLiveByOwner("session", sessionKey)).toBeUndefined();
});
