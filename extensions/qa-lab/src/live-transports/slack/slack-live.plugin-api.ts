// QA Lab loads Slack test-only operations from the owning bundled plugin.
export type SlackQaPluginTestApi = typeof import("@openclaw/slack/test-api.js");

export async function loadSlackQaPluginTestApi(): Promise<SlackQaPluginTestApi> {
  const { loadQaRunnerBundledPluginTestApi } =
    await import("openclaw/plugin-sdk/qa-runner-runtime");
  return loadQaRunnerBundledPluginTestApi<SlackQaPluginTestApi>("slack");
}
