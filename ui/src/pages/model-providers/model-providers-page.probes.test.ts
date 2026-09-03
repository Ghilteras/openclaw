/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelsProbeResult } from "../../api/types.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { appendPage, createHarness, deferred } from "./model-providers-page.test-support.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("ModelProvidersPage credential probes", () => {
  it("probes credentials in the selected agent scope", async () => {
    const { context, request } = createHarness("writer");
    const page = appendPage(context);
    await waitForFast(() => expect(page.data?.config).toEqual({}));
    request.mockClear();

    await page.probe("openai", ["openai"]);

    expect(request).toHaveBeenCalledWith("models.probe", {
      provider: "openai",
      agentId: "writer",
    });
  });

  it("stops queued provider probes after switching away from and back to the selected agent", async () => {
    const { agentSelection, context, notifySelection, request } = createHarness("main");
    const page = appendPage(context);
    await waitForFast(() => expect(page.data?.config).toEqual({}));
    request.mockClear();
    const firstProbe = deferred<ModelsProbeResult>();
    request.mockImplementationOnce(() => firstProbe.promise);

    const probing = page.probe("anthropic", ["anthropic", "claude-cli"]);
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("models.probe", {
        provider: "anthropic",
        agentId: "main",
      }),
    );
    agentSelection.state.selectedId = "writer";
    agentSelection.state.scopeId = "writer";
    notifySelection();
    await vi.waitFor(() => expect(page.selectedAgentId).toBe("writer"));
    agentSelection.state.selectedId = "main";
    agentSelection.state.scopeId = "main";
    notifySelection();
    await vi.waitFor(() => expect(page.selectedAgentId).toBe("main"));
    firstProbe.resolve({ provider: "anthropic", status: "ok", results: [] });
    await probing;

    expect(request.mock.calls.filter(([method]) => method === "models.probe")).toHaveLength(1);
    expect(page.probeResults).toEqual({});
    expect(page.busy).toEqual({});
  });

  it("discards an in-flight probe result after the selected agent changes", async () => {
    const { agentSelection, context, notifySelection, request } = createHarness("main");
    const page = appendPage(context);
    await waitForFast(() => expect(page.data?.config).toEqual({}));
    const pending = deferred<ModelsProbeResult>();
    request.mockImplementationOnce(() => pending.promise);

    const probing = page.probe("openai", ["openai"]);
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("models.probe", {
        provider: "openai",
        agentId: "main",
      }),
    );
    agentSelection.state.selectedId = "writer";
    agentSelection.state.scopeId = "writer";
    notifySelection();
    await vi.waitFor(() => expect(page.selectedAgentId).toBe("writer"));
    pending.resolve({ provider: "openai", status: "ok", results: [] });
    await probing;

    expect(page.probeResults).toEqual({});
    expect(page.busy).toEqual({});
  });
});
