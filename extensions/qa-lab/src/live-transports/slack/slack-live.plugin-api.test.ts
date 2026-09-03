// QA Lab tests cover the Slack plugin test API loader boundary.
import { expect, it, vi } from "vitest";
import { loadSlackQaPluginTestApi } from "./slack-live.plugin-api.js";

const { loadQaRunnerBundledPluginTestApi, runtime } = vi.hoisted(() => {
  const runtime = { marker: "slack-test-api" };
  return {
    loadQaRunnerBundledPluginTestApi: vi.fn(() => runtime),
    runtime,
  };
});

vi.mock("openclaw/plugin-sdk/qa-runner-runtime", () => ({
  loadQaRunnerBundledPluginTestApi,
}));

it("loads the Slack test API through the bundled plugin owner", async () => {
  await expect(loadSlackQaPluginTestApi()).resolves.toBe(runtime);
  expect(loadQaRunnerBundledPluginTestApi).toHaveBeenCalledExactlyOnceWith("slack");
});
