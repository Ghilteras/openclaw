import { describe, expect, it } from "vitest";
import { parseNodeWorkerWorkspaceExecInput } from "./node-workspace-protocol.js";
import { WORKER_SKILL_RESOURCE_INPUT_MAX_BYTES } from "./skill-resource-protocol.js";

const request = {
  gatewayNamespace: "gateway-1",
  environmentId: "environment-1",
  sessionId: "session-1",
  generation: 1,
  argv: ["openclaw-internal-workspace-seed"],
};
const key = "a".repeat(64);

describe("node workspace seed protocol", () => {
  const download = {
    direction: "download",
    token: "token",
    manifestRef: `sha256:${key}`,
    seedKey: key,
  };

  it("accepts a prepared seed only as part of a workspace download", () => {
    expect(
      parseNodeWorkerWorkspaceExecInput(JSON.stringify({ ...request, transfer: download }))
        .transfer,
    ).toEqual(download);
  });

  it.each([
    { ...download, seedKey: "../outside" },
    { ...download, seedKey: "A".repeat(64) },
    { ...download, attachments: true },
    { direction: "upload", token: "token", baseManifestRef: download.manifestRef, seedKey: key },
  ])("rejects an invalid prepared seed transfer %#", (transfer) => {
    expect(() =>
      parseNodeWorkerWorkspaceExecInput(JSON.stringify({ ...request, transfer })),
    ).toThrow("INVALID_REQUEST:");
  });

  it.each([
    { action: "apply", key },
    { action: "store", key, maxAgeMs: 0 },
    { action: "store", key, maxAgeMs: Number.MAX_SAFE_INTEGER },
  ])("accepts $action with maxAgeMs=$maxAgeMs", (seed) => {
    expect(parseNodeWorkerWorkspaceExecInput(JSON.stringify({ ...request, seed }))).toEqual({
      ...request,
      seed,
    });
  });

  it.each([
    ["bad key", { seed: { action: "apply", key: "../outside" } }],
    ["uppercase key", { seed: { action: "apply", key: "A".repeat(64) } }],
    ["bad action", { seed: { action: "remove", key } }],
    ["extra apply key", { seed: { action: "apply", key, maxAgeMs: 0 } }],
    ["extra store key", { seed: { action: "store", key, maxAgeMs: 0, extra: true } }],
    ["missing age", { seed: { action: "store", key } }],
    ["negative age", { seed: { action: "store", key, maxAgeMs: -1 } }],
    ["unsafe age", { seed: { action: "store", key, maxAgeMs: Number.MAX_SAFE_INTEGER + 1 } }],
    ["fractional age", { seed: { action: "store", key, maxAgeMs: 0.5 } }],
    ["reset", { seed: { action: "apply", key }, resetWorkspace: true }],
    ["false reset", { seed: { action: "apply", key }, resetWorkspace: false }],
    [
      "transfer",
      {
        seed: { action: "store", key, maxAgeMs: 0 },
        transfer: { direction: "download", token: "transfer-token", manifestRef: `sha256:${key}` },
      },
    ],
  ])("rejects %s", (_name, invalid) => {
    expect(() =>
      parseNodeWorkerWorkspaceExecInput(JSON.stringify({ ...request, ...invalid })),
    ).toThrow("INVALID_REQUEST:");
  });
});

describe("node workspace skill resource protocol", () => {
  const resourceRequest = { ...request, argv: ["openclaw-internal-skill-resources"] };
  const identity = { resourceId: "b".repeat(32), identity: "1:18446744073709551615" };
  const write = {
    operation: "write",
    ...identity,
    path: "0/SKILL.md",
    offset: 0,
    sizeBytes: 3,
    sha256: key,
    executable: false,
  };

  it.each([
    { skillResources: { operation: "init" } },
    { skillResources: { operation: "cleanup", ...identity } },
    { skillResources: write, input: "YWJj" },
    { skillResources: { ...write, sizeBytes: 0 }, input: "" },
  ])("preserves a closed generation-bound operation %#", (operation) => {
    const input = { ...resourceRequest, ...operation };
    expect(parseNodeWorkerWorkspaceExecInput(JSON.stringify(input))).toEqual(input);
  });

  it.each([
    ["caller-selected root", { skillResources: { operation: "init", root: "/tmp/other" } }],
    ["cleanup root", { skillResources: { operation: "cleanup", ...identity, root: "/tmp/other" } }],
    ["traversing resource id", { skillResources: { ...write, resourceId: "../outside" } }],
    ["numeric inode", { skillResources: { ...write, identity: 1 } }],
    ["path traversal", { skillResources: { ...write, path: "0/../outside" } }],
    ["absolute path", { skillResources: { ...write, path: "/outside" } }],
    ["Windows path", { skillResources: { ...write, path: "C:/outside" } }],
    ["deep path", { skillResources: { ...write, path: "a/".repeat(17) + "file" } }],
    ["negative offset", { skillResources: { ...write, offset: -1 } }],
    ["oversize file", { skillResources: { ...write, sizeBytes: 1_048_577 } }],
    ["invalid digest", { skillResources: { ...write, sha256: "A".repeat(64) } }],
    ["extra write field", { skillResources: { ...write, command: ["node"] } }],
    ["ordinary argv", { argv: ["node", "-e", "process.exit()"] }],
    ["extra argv", { argv: [...resourceRequest.argv, "/outside"] }],
    ["missing chunk", { input: undefined }],
    ["noncanonical base64", { input: "YWJj\n" }],
    ["chunk over file bound", { input: "YWJjZA==" }],
    [
      "stdin over transport bound",
      { input: "a".repeat(WORKER_SKILL_RESOURCE_INPUT_MAX_BYTES + 1) },
    ],
    ["init with input", { skillResources: { operation: "init" }, input: "" }],
    ["cleanup with input", { skillResources: { operation: "cleanup", ...identity }, input: "" }],
    ["workspace reset", { resetWorkspace: false }],
    ["workspace seed", { seed: { action: "apply", key } }],
    [
      "workspace transfer",
      { transfer: { direction: "upload", token: "token", baseManifestRef: `sha256:${key}` } },
    ],
  ])("rejects %s before filesystem dispatch", (_label, invalid) => {
    expect(() =>
      parseNodeWorkerWorkspaceExecInput(
        JSON.stringify({
          ...resourceRequest,
          skillResources: write,
          input: "YWJj",
          ...invalid,
        }),
      ),
    ).toThrow("INVALID_REQUEST:");
  });
});
