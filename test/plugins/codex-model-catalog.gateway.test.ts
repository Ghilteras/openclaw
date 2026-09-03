import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import codexPlugin from "../../extensions/codex/index.js";
import type { PreparedProviderAuth } from "../../src/agents/agent-auth-credential-modes.js";
import type { AgentHarness } from "../../src/agents/harness/types.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import {
  buildModelsListResult,
  createGatewayAgentModelCatalogProjector,
} from "../../src/gateway/server-methods/models-list-result.js";
import {
  listModels,
  WITHOUT_OPENAI_ENV_AUTH,
} from "../../src/gateway/server-methods/models-list-result.openai-routes.test-support.js";
import type { GatewayRequestContext } from "../../src/gateway/server-methods/types.js";
import { loadManifestMetadataSnapshot } from "../../src/plugins/manifest-contract-eligibility.js";
import { createEmptyPluginRegistry } from "../../src/plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../src/plugins/runtime.js";
import { withEnvAsync } from "../../src/test-utils/env.js";
import { withOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";

vi.mock("openclaw/plugin-sdk/simple-completion-runtime", () => ({
  runHostPreparedIsolatedCompletion: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/agent-harness-runtime", () => ({
  AgentHarnessPreflightError: class extends Error {},
  embeddedAgentLog: { debug: vi.fn(), warn: vi.fn() },
  formatErrorMessage: String,
  OPENCLAW_VERSION: "test",
}));

describe("models.list native account catalog", () => {
  afterEach(() => vi.restoreAllMocks());

  it("makes a native user-home API-key catalog selectable without a ChatGPT route", async (ctx) => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "native-catalog-" },
      async (state) => {
        await withEnvAsync(
          {
            ...WITHOUT_OPENAI_ENV_AUTH,
            CODEX_HOME: `${state.home}/codex`,
            SYNTHETIC_ABSENT_KEY: undefined,
          },
          async () => {
            // macOS Unix sockets have a short path limit; keep them outside the state fixture.
            const socketDir = await mkdtemp(
              path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "oc-catalog-"),
            );
            const socketPath =
              process.platform === "win32"
                ? `\\\\.\\pipe\\${path.basename(socketDir)}`
                : path.join(socketDir, "s");
            const httpServer = createServer();
            const server = new WebSocketServer({ server: httpServer });
            ctx.onTestFinished(async () => {
              for (const socket of server.clients) {
                socket.terminate();
              }
              await new Promise<void>((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
              });
              await new Promise<void>((resolve) => {
                httpServer.close(() => resolve());
              });
              await rm(socketDir, { recursive: true, force: true });
            });
            const requests: string[] = [];
            server.on("connection", (socket) => {
              socket.on("message", (data) => {
                const encoded = Array.isArray(data)
                  ? Buffer.concat(data)
                  : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
                const request = JSON.parse(encoded.toString("utf8")) as {
                  id?: number;
                  method: string;
                };
                requests.push(request.method);
                if (request.id === undefined) {
                  return;
                }
                const result =
                  request.method === "initialize"
                    ? { userAgent: "openclaw/0.149.1 (test)" }
                    : request.method === "model/list"
                      ? {
                          data: [
                            {
                              id: "synthetic-opaque",
                              model: "synthetic-opaque",
                              displayName: "Synthetic name",
                              description: "Synthetic model",
                              supportsPersonality: false,
                              inputModalities: ["text"],
                              supportedReasoningEfforts: [
                                { reasoningEffort: "low", description: "Low" },
                              ],
                              defaultReasoningEffort: "low",
                              hidden: false,
                              isDefault: true,
                            },
                          ],
                          nextCursor: null,
                        }
                      : {};
                socket.send(JSON.stringify({ id: request.id, result }));
              });
            });
            httpServer.listen(socketPath);
            await once(server, "listening");
            const config: OpenClawConfig = {
              agents: {
                defaults: {
                  workspace: state.workspaceDir,
                  model: "openai/synthetic-opaque",
                  models: { "openai/synthetic-opaque": { agentRuntime: { id: "codex" } } },
                },
              },
              plugins: {
                entries: {
                  codex: {
                    enabled: true,
                    config: {
                      appServer: {
                        transport: "unix",
                        url: `unix://${socketPath}`,
                        homeScope: "user",
                        approvalPolicy: "on-request",
                        sandbox: "workspace-write",
                      },
                      computerUse: { enabled: false },
                    },
                  },
                },
              },
            };
            const harnesses: AgentHarness[] = [];
            codexPlugin.register(
              createTestPluginApi({
                id: "codex",
                rootDir: fileURLToPath(new URL("../../extensions/codex/", import.meta.url)),
                config,
                pluginConfig: config.plugins?.entries?.codex?.config,
                runtime: { config: { current: () => config } } as never,
                registerAgentHarness: (harness) => harnesses.push(harness),
              }),
            );
            const harness = harnesses.find((entry) => entry.id === "codex");
            if (!harness) {
              throw new Error("Codex plugin did not register its harness");
            }
            const scope = {
              agentId: "main",
              agentDir: state.agentDir(),
              workspaceDir: state.workspaceDir,
            };
            const registry = createEmptyPluginRegistry();
            registry.agentHarnesses.push({ pluginId: "codex", source: "test", harness });
            const previous = captureActivePluginRegistrySnapshot();
            setActivePluginRegistry(registry);
            try {
              // Discovery reads the operator's native Codex home; account state is not
              // part of the catalog and stays with the owner's provider-auth facts.
              const rows = [...(await harness.loadModelCatalog!({ ...scope, config }))];
              expect(requests).toContain("model/list");
              expect(requests).not.toContain("account/read");
              expect(requests).not.toContain("account/login/start");
              expect(rows[0]).toMatchObject({
                id: "synthetic-opaque",
                nativeRuntime: "codex",
                name: "Synthetic name",
                reasoning: true,
              });
              expect(rows[0]).not.toHaveProperty("api");
              expect(rows[0]).not.toHaveProperty("baseUrl");

              const configured = (preparedProviderAuth: PreparedProviderAuth) =>
                listModels({
                  ...scope,
                  cfg: config,
                  catalog: structuredClone(rows),
                  view: "all",
                  preparedOnly: true,
                  catalogComplete: true,
                  preparedProviderAuth,
                });
              const nativeApiKey = { openai: { mode: "api_key", runtime: "codex" } } as const;
              const selectable = await configured(nativeApiKey);
              expect(selectable.models).toEqual([
                expect.objectContaining({
                  id: "synthetic-opaque",
                  name: "Synthetic name",
                  available: true,
                  reasoning: true,
                }),
              ]);
              expect(selectable.models[0]).not.toHaveProperty("nativeRuntime");
              expect((await configured({})).models[0]?.available).toBe(false);

              // A rejected explicit session lock cannot borrow native account readiness.
              const snapshot = { entries: rows, routeVariants: rows };
              const projector = createGatewayAgentModelCatalogProjector({
                cfg: config,
                agentId: "main",
                snapshot,
                metadataSnapshot: loadManifestMetadataSnapshot({ config, env: process.env }),
                preparedAuthStore: { version: 1, profiles: {} },
                preparedProviderAuth: nativeApiKey,
                lockedProfileId: "openai:missing",
              });
              const locked = await buildModelsListResult({
                source: {
                  kind: "published",
                  context: {
                    getRuntimeConfig: () => config,
                    loadGatewayModelCatalogSnapshot: vi.fn(),
                    logGateway: { debug: vi.fn() },
                  } as unknown as GatewayRequestContext,
                  config,
                  snapshot,
                  projector,
                },
                agentId: "main",
                params: { view: "configured" },
              });
              expect(locked.models[0]?.available).toBe(false);
            } finally {
              await harness.dispose?.();
              restoreActivePluginRegistrySnapshot(previous);
            }
          },
        );
      },
    );
  });
});
