import { describe, expect, it, vi } from "vitest";
import type { ModelCatalogEntry } from "../../api/types.ts";
import { contextWith, deferred, renderControl } from "./model-control.test-support.ts";
import { NewSessionModelControl } from "./model-control.ts";

const models: ModelCatalogEntry[] = [
  { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "openai" },
];

function catalogCalls(request: ReturnType<typeof vi.fn>) {
  return request.mock.calls.filter(([method]) => method === "sessions.catalog.list");
}

describe("new-session CLI-agent model targets", () => {
  it("ignores a stale response after reconnect replaces its owner", async () => {
    const oldCatalog = deferred<{ catalogs: Array<Record<string, unknown>> }>();
    const { context: oldContext, request: oldRequest } = contextWith(models, "openclaw", [
      "sessions.catalog.list",
    ]);
    oldRequest.mockImplementation((method: string) =>
      method === "sessions.catalog.list" ? oldCatalog.promise : Promise.resolve({ models }),
    );
    const { context: newContext, request: newRequest } = contextWith(models, "openclaw", [
      "sessions.catalog.list",
    ]);
    newRequest.mockImplementation((method: string) =>
      method === "sessions.catalog.list"
        ? Promise.resolve({
            catalogs: [
              {
                id: "new-owner",
                label: "New owner",
                capabilities: { startTerminal: true },
                hosts: [],
              },
            ],
          })
        : Promise.resolve({ models }),
    );
    const control = new NewSessionModelControl(() => undefined);

    control.loadCatalogTargets(oldContext, "main", true);
    await vi.waitFor(() => expect(catalogCalls(oldRequest)).toHaveLength(1));
    control.invalidate(false);
    control.loadCatalogTargets(newContext, "main", true);

    await vi.waitFor(() =>
      expect(
        renderControl(control, newContext).querySelector('[data-chat-model-target="new-owner"]'),
      ).not.toBeNull(),
    );
    oldCatalog.resolve({
      catalogs: [
        {
          id: "stale-owner",
          label: "Stale owner",
          capabilities: { startTerminal: true },
          hosts: [],
        },
      ],
    });
    await Promise.resolve();
    await Promise.resolve();

    const container = renderControl(control, newContext);
    expect(container.querySelector('[data-chat-model-target="new-owner"]')).not.toBeNull();
    expect(container.querySelector('[data-chat-model-target="stale-owner"]')).toBeNull();
  });

  it("ignores a stale response after the same client switches agent owners", async () => {
    const mainCatalog = deferred<{ catalogs: Array<Record<string, unknown>> }>();
    const researchCatalog = deferred<{ catalogs: Array<Record<string, unknown>> }>();
    const { context, request } = contextWith(models, "openclaw", ["sessions.catalog.list"]);
    request.mockImplementation((method: string, params?: { agentId?: string }) => {
      if (method !== "sessions.catalog.list") {
        return Promise.resolve({ models });
      }
      return params?.agentId === "research" ? researchCatalog.promise : mainCatalog.promise;
    });
    const control = new NewSessionModelControl(() => undefined);

    control.loadCatalogTargets(context, "main", true);
    await vi.waitFor(() => expect(catalogCalls(request)).toHaveLength(1));
    control.loadCatalogTargets(context, "research", true);
    await vi.waitFor(() => expect(catalogCalls(request)).toHaveLength(2));

    researchCatalog.resolve({
      catalogs: [
        {
          id: "research-owner",
          label: "Research owner",
          capabilities: { startTerminal: true },
          hosts: [],
        },
      ],
    });
    await vi.waitFor(() =>
      expect(
        renderControl(control, context).querySelector('[data-chat-model-target="research-owner"]'),
      ).not.toBeNull(),
    );

    mainCatalog.resolve({
      catalogs: [
        {
          id: "main-owner",
          label: "Main owner",
          capabilities: { startTerminal: true },
          hosts: [],
        },
      ],
    });
    await Promise.resolve();
    await Promise.resolve();

    const container = renderControl(control, context);
    expect(container.querySelector('[data-chat-model-target="research-owner"]')).not.toBeNull();
    expect(container.querySelector('[data-chat-model-target="main-owner"]')).toBeNull();
  });
});
