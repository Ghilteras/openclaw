import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import type { OpenClawTestInstance } from "../../test/helpers/openclaw-test-instance.js";
import type { GatewaySessionRow } from "../../ui/src/api/types.js";
import { createControlUiE2eArtifactDir } from "../../ui/src/test-helpers/control-ui-e2e-artifacts.js";
import {
  RETENTION_AGENT_ID,
  retentionSeedText,
  type RetentionFixture,
} from "./session-retention-fixture.js";
import type { RetentionRpc } from "./session-retention-live.js";

export async function proveRetentionUi(params: {
  instance: OpenClawTestInstance;
  output: string;
  row: RetentionFixture;
  rpc: RetentionRpc;
  marker: string;
  smoke: boolean;
  registerCleanup: (work: () => Promise<void>) => () => Promise<void>;
  browserExecutable: string;
  expectedBuildId: string;
}) {
  const { instance, row, rpc } = params;
  const lookupLabel = row.entry.label;
  assert(lookupLabel, "retained lookup fixture needs its original label");
  const output = createControlUiE2eArtifactDir(
    "real-gateway",
    path.join(params.output, "captures"),
  );
  const base = `http://127.0.0.1:${instance.port}`;
  const report: {
    status: string;
    screenshots: string[];
    videos: string[];
    observations: unknown[];
    capturesInspected: boolean;
    error?: string;
    pagination?: string;
    lookupSurface: string;
    initialArchivedWindow?: { limit: unknown; returnedRows: number; targetPresent: boolean };
    lookup?: {
      request: Record<string, unknown>;
      ok: boolean;
      returnedRows: number;
      targets: Pick<GatewaySessionRow, "key" | "sessionId" | "label" | "archived">[];
    };
  } = {
    status: "running",
    screenshots: [],
    videos: [],
    observations: [],
    capturesInspected: false,
    lookupSurface: "Activity → Sessions (/activity), All time, global metadata search",
  };
  const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
  const html = await (await fetch(base, { signal: AbortSignal.timeout(10_000) })).text();
  const asset = html.match(/src="(?:\.\/|\/)?(assets\/index-[^"/]+\.js)"/u)?.[1];
  assert(asset, "Normal bundled Control UI index missing");
  const served = Buffer.from(
    await (await fetch(`${base}/${asset}`, { signal: AbortSignal.timeout(10_000) })).arrayBuffer(),
  );
  assert.equal(hash(served), hash(await fs.readFile(path.resolve("dist/control-ui", asset))));
  report.observations.push({ bundledAsset: asset, sha256: hash(served) });
  const browser = await chromium.launch({
    headless: true,
    executablePath: params.browserExecutable,
  });
  const closeBrowser = params.registerCleanup(() => browser.close());
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    recordVideo: { dir: output, size: { width: 1440, height: 1000 } },
    locale: "en-US",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const video = page.video();
  const screenshot = async (name: string) => {
    assert(!new URL(page.url()).hash.includes("token"), "UI did not consume token fragment");
    const file = path.join(output, `${name}.png`);
    await page.screenshot({ path: file, fullPage: true, animations: "disabled" });
    report.screenshots.push(path.relative(process.cwd(), file));
  };
  let helloResolve: () => void = () => {};
  let helloReject: (error: Error) => void = () => {};
  let lookupResolve: () => void = () => {};
  const hello = new Promise<void>((resolve, reject) => {
    helloResolve = resolve;
    helloReject = reject;
  });
  const timer = setTimeout(
    () => helloReject(new Error("Normal UI pairing/hello deadline")),
    30_000,
  );
  page.on("websocket", (socket) => {
    const pending = new Map<string, { method: string; params: Record<string, unknown> }>();
    assert.equal(new URL(socket.url()).host, new URL(base).host);
    socket.on("framesent", ({ payload }) => {
      const frame = JSON.parse(String(payload));
      if (frame.type !== "req") {
        return;
      }
      if (!["connect", "sessions.list", "sessions.patch", "chat.send"].includes(frame.method)) {
        return;
      }
      const safeParams = Object.fromEntries(
        [
          "key",
          "archived",
          "offset",
          "limit",
          "expectedSessionId",
          "search",
          "activeMinutes",
          "involvingProfileId",
        ]
          .filter((key) => frame.params?.[key] !== undefined)
          .map((key) => [key, frame.params[key]]),
      );
      pending.set(frame.id, { method: frame.method, params: safeParams });
    });
    socket.on("framereceived", ({ payload }) => {
      const frame = JSON.parse(String(payload));
      const request = pending.get(frame.id);
      if (frame.type !== "res" || !request) {
        return;
      }
      pending.delete(frame.id);
      if (request.method === "connect") {
        if (!frame.ok) {
          helloReject(new Error(`Normal browser auth failed: ${frame.error?.code}`));
          return;
        }
        try {
          assert.equal(frame.payload.snapshot.stateDir, instance.stateDir);
          assert.equal(frame.payload.server.controlUiBuildSource, "bundled");
          assert.equal(frame.payload.server.buildId, params.expectedBuildId);
          report.observations.push({
            bootId: frame.payload.server.bootId,
            buildId: frame.payload.server.buildId,
          });
          helloResolve();
        } catch (error) {
          helloReject(error as Error);
        }
      } else {
        report.observations.push({ ...request, ok: frame.ok, errorCode: frame.error?.code });
        if (request.method === "sessions.list") {
          const sessions: GatewaySessionRow[] = Array.isArray(frame.payload?.sessions)
            ? frame.payload.sessions
            : [];
          if (
            !report.initialArchivedWindow &&
            frame.ok &&
            request.params.archived === true &&
            !request.params.search &&
            (request.params.offset ?? 0) === 0
          ) {
            report.initialArchivedWindow = {
              limit: request.params.limit,
              returnedRows: sessions.length,
              targetPresent: sessions.some((candidate) => candidate.key === row.key),
            };
          }
          if (request.params.search === lookupLabel && request.params.archived === "all") {
            // Retain only the target identity, not the massive roster or auth envelope.
            report.lookup = {
              request: request.params,
              ok: frame.ok === true,
              returnedRows: sessions.length,
              targets: sessions
                .filter((candidate) => candidate.key === row.key)
                .map(({ key, sessionId, label, archived }) => ({
                  key,
                  sessionId,
                  label,
                  archived,
                })),
            };
            lookupResolve();
          }
        }
      }
    });
  });
  const show = async (state: string) => {
    await page.goto(`${base}/sessions`, { waitUntil: "domcontentloaded" });
    await page
      .locator(`openclaw-sessions-page .sessions-view-segment wa-radio[value="${state}"]`)
      .click();
    await page
      .locator("openclaw-sessions-page tr.session-data-row")
      .first()
      .waitFor({ state: "visible" });
  };
  const paginate = async (name: string) => {
    const table = page.locator("openclaw-sessions-page");
    const first = await table.locator("a.session-link").first().getAttribute("href");
    await table
      .locator(".data-table-pagination")
      .getByRole("button", { name: "Next", exact: true })
      .click();
    await page.waitForFunction((previous) => {
      const current = document
        .querySelector("openclaw-sessions-page a.session-link")
        ?.getAttribute("href");
      return Boolean(current && current !== previous);
    }, first);
    await screenshot(name);
  };
  try {
    // Public token-fragment entry creates and pairs a fresh browser device normally.
    // No WebSocket interception, localStorage writes, app object access, or source injection.
    await page.goto(`${base}/sessions#token=${encodeURIComponent(instance.gatewayToken)}`, {
      waitUntil: "domcontentloaded",
    });
    await hello;
    clearTimeout(timer);
    await show("active");
    await screenshot("01-active-before-cleanup");
    if (!params.smoke) {
      await paginate("02-active-second-page");
    }
    await rpc("sessions.cleanup", { agent: RETENTION_AGENT_ID, enforce: true });
    await show("active");
    await screenshot("03-active-after-cleanup");
    await show("archived");
    await screenshot("04-archive-roster");
    if (!params.smoke) {
      await paginate("05-archive-second-page");
    }
    report.pagination = params.smoke
      ? "smoke skips pagination; scale/massive verify active and archived page changes"
      : "active and archived page changes observed";
    // The lower Sessions filter only searches loaded rows. Activity owns the
    // existing global metadata lookup; keep the same off-window archived target.
    await page.goto(`${base}/activity`, { waitUntil: "domcontentloaded" });
    const activity = page.locator("openclaw-activity-page");
    await activity.getByRole("tab", { name: "Sessions", exact: true }).click();
    await activity.getByRole("button", { name: "All time", exact: true }).click();
    await page.waitForURL((url) => url.searchParams.get("time") === "all");
    assert.equal(new URL(page.url()).searchParams.has("person"), false);
    let lookupTimer: NodeJS.Timeout | undefined;
    const lookupResponse = new Promise<void>((resolve, reject) => {
      lookupResolve = resolve;
      lookupTimer = setTimeout(
        () => reject(new Error("Activity global search response deadline")),
        30_000,
      );
    });
    try {
      // Smoke may already render the target: require the new query's response,
      // not a stale visible row, before accepting the lookup.
      await Promise.all([
        lookupResponse,
        activity.locator(".activity-feed__search input").fill(lookupLabel),
      ]);
    } finally {
      clearTimeout(lookupTimer);
    }
    const selected = activity.locator(`a[data-activity-session="${row.key}"]`);
    await selected.waitFor({ state: "visible" });
    assert.equal(
      await selected.locator(".activity-feed__session-title").textContent(),
      lookupLabel,
    );
    assert(report.lookup, "Activity must issue the actual global sessions.list search");
    assert.equal(report.lookup.ok, true);
    assert.equal(report.lookup.request.search, lookupLabel);
    assert.equal(report.lookup.request.archived, "all");
    assert.equal(report.lookup.request.limit, 100);
    assert.equal(report.lookup.request.activeMinutes, undefined);
    assert.equal(report.lookup.request.involvingProfileId, undefined);
    assert.deepEqual(report.lookup.targets, [
      { key: row.key, sessionId: row.entry.sessionId, label: lookupLabel, archived: true },
    ]);
    if (!params.smoke) {
      assert.deepEqual(
        report.initialArchivedWindow,
        { limit: 50, returnedRows: 50, targetPresent: false },
        "lookup must reach beyond the original archived roster window",
      );
    }
    await screenshot("05b-activity-global-lookup");
    await selected.click();
    const pane = page.locator("openclaw-chat-pane");
    await pane
      .getByText(retentionSeedText(row.entry.sessionId, 0), { exact: true })
      .waitFor({ state: "visible" });
    const banner = pane.getByText(
      "This session is archived. Unarchive it to continue the conversation.",
      { exact: true },
    );
    await banner.waitFor({ state: "visible" });
    await screenshot("06-retained-history");
    await pane.getByRole("button", { name: "Unarchive", exact: true }).click();
    await banner.waitFor({ state: "hidden" });
    await screenshot("07-restored-history");
    await pane
      .locator(".agent-chat__composer-combobox textarea")
      .fill("Please confirm this restored synthetic retention conversation.");
    await pane.getByRole("button", { name: "Send message", exact: true }).click();
    await pane.getByText(params.marker, { exact: true }).waitFor({ state: "visible" });
    await screenshot("08-normal-provider-continuation");
    const history = await rpc("chat.history", {
      sessionKey: row.key,
      agentId: RETENTION_AGENT_ID,
      limit: 200,
    });
    assert.equal(history.sessionId, row.entry.sessionId);
    assert(JSON.stringify(history).includes(retentionSeedText(row.entry.sessionId, 0)));
    assert(JSON.stringify(history).includes(params.marker));
    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    report.error = String(error);
    await screenshot("FAILED").catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
    await context.close();
    if (video) {
      const file = await video.path();
      assert((await fs.stat(file)).size > 0);
      report.videos.push(path.relative(process.cwd(), file));
    }
    await closeBrowser();
    await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  }
  return report;
}
