import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { parseNodeWorkerWorkspaceExecInput } from "../../worker/node-workspace-protocol.js";
import { WORKER_SKILL_RESOURCE_COMMAND } from "../../worker/skill-resource-protocol.js";
import type { NodeWorkerSupervisorTransport } from "../node-registry-private.js";
import { createNodeWorkerTunnelManager } from "./node-worker-tunnel.js";
import {
  environment,
  startRequest,
  transport,
  workspaceCommandPayload,
  workspaceTransfer,
} from "./node-worker-tunnel.test-support.js";
import { serializeWorkerWorkspaceManifest } from "./workspace-manifest.js";
import { readActualWorkspaceManifest } from "./workspace-reconcile.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("node worker workspace resource capability", () => {
  it("requires the capability and exact generation-owned workspace", async () => {
    const localPath = tempDirs.make("node-workspace-resource-capability-");
    const actual = await readActualWorkspaceManifest({ root: localPath, baseCommit: null });
    const rawManifest = serializeWorkerWorkspaceManifest(actual.manifest);
    const nodeTransport = transport();
    const node = (await nodeTransport.listCurrentNodes())[0]!;
    nodeTransport.listCurrentNodes = async () => [node];
    const invoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>(async ({ params }) => {
      const input = parseNodeWorkerWorkspaceExecInput(JSON.stringify(params));
      return {
        ok: true,
        payloadJSON: workspaceCommandPayload("/node/workspace", {
          stdout: input.transfer ? actual.manifestRef : "",
        }),
      };
    });
    nodeTransport.invoke = invoke;
    const transfer = {
      ...workspaceTransfer(),
      prepareSync: vi.fn(async () => ({
        token: "token",
        snapshot: { ...actual, rawManifest, root: localPath },
      })),
    };
    const record = environment();
    const manager = createNodeWorkerTunnelManager({
      gatewayDeviceId: "gateway-device-1",
      getEnvironment: () => record,
      listEnvironments: () => [record],
      getTransport: () => nodeTransport,
      launchNodeWorker: vi.fn(),
      validateWorkerTurn: () => true,
      workspaceTransfer: transfer,
    });
    const handle = await manager.start(startRequest());
    await handle.syncWorkspace({ localPath, sessionId: "session-1", generation: 1 });
    const resources = {
      argv: [WORKER_SKILL_RESOURCE_COMMAND],
      transportRetry: "never" as const,
      assertCurrent: () => {},
      skillResources: {
        workspaceDir: "/node/workspace",
        generation: 2,
        operation: { operation: "init" as const },
      },
    };

    const beforeResources = invoke.mock.calls.length;
    await expect(handle.runWorkspaceCommand(resources)).rejects.toThrow("openclaw update");
    expect(invoke).toHaveBeenCalledTimes(beforeResources);

    node.workerHost.workspaceSkillResources = 1;
    await handle.runWorkspaceCommand(resources);
    expect(invoke.mock.calls.at(-1)?.[0].params).toMatchObject({
      argv: [WORKER_SKILL_RESOURCE_COMMAND],
      skillResources: { operation: "init" },
    });

    for (const changed of [{ workspaceDir: "/other/workspace" }, { generation: 3 }]) {
      await expect(
        handle.runWorkspaceCommand({
          ...resources,
          skillResources: { ...resources.skillResources, ...changed },
        }),
      ).rejects.toThrow("workspace owner");
    }
    await expect(
      handle.runWorkspaceCommand({ ...resources, transportRetry: "idempotent" }),
    ).rejects.toThrow("workspace owner");
    expect(invoke).toHaveBeenCalledTimes(beforeResources + 1);
  });
});
