// Private operational entrypoint; only the benchmark bootstrap supplies this input.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeControlUiBuildInfo } from "../../ui/src/build-info-normalizers.ts";
import { BUILD_STAMP_FILE, RUNTIME_POSTBUILD_STAMP_FILE } from "./local-build-metadata-paths.mts";
import type { RetentionProfile } from "./session-retention-fixture.js";

export type SessionRetentionWorkerInput = {
  profile: RetentionProfile;
  mode: "owner" | "live";
  output: string;
  browserExecutable?: string;
};

assert.equal(process.argv.length, 3, "Private retention worker requires bootstrap input");
const values: SessionRetentionWorkerInput = JSON.parse(process.argv[2]!);
const { output, browserExecutable } = values;
const repo = process.cwd();
const runtime = path.resolve(output, "runtime");
// This process was spawned with the bootstrap allowlist, before runtime imports.
const cleanEnvKeys = new Set(Object.keys(process.env));
const report: Record<string, unknown> = {
  status: "running",
  profile: values.profile,
  mode: values.mode,
  output,
  startedAt: new Date().toISOString(),
  capturesInspected: false,
  cleanupComplete: false,
  phases: {},
  failures: [],
  limits: [
    "Synthetic provider only; no real-provider credentials",
    "Owner admission proof is process-local; real running admission is additionally exercised in live mode",
    "Crash proves issued/in-flight requests, not an instrumented mid-SQLite-commit crash",
    "Smoke uses an explicit cap of 32; scale/massive use the product default 5000",
    "UI media requires parent inspection before publication",
  ],
};
const save = () =>
  fs.writeFileSync(path.join(output, "summary.json"), JSON.stringify(report, null, 2) + "\n");
let cleanup: (() => Promise<void>) | undefined;
const teardowns: (() => Promise<void>)[] = [];
const registerCleanup = (work: () => Promise<void>) => {
  let completion: Promise<void> | undefined;
  const once = () => (completion ??= work());
  teardowns.push(once);
  return once;
};
let watchdog: NodeJS.Timeout | undefined;
let aborting = false;
let cleanupCompletion: Promise<void> | undefined;
const cleanupOwnedResources = () =>
  (cleanupCompletion ??= (async () => {
    const stopped = await Promise.allSettled(teardowns.map((work) => work()));
    stopped.push(...(await Promise.allSettled([cleanup?.()])));
    assert.deepEqual(
      stopped.filter((result) => result.status === "rejected"),
      [],
      "owned resource teardown failed",
    );
    // An interrupted phase may still be unwinding; only settled work proves release.
    report.cleanupComplete = !aborting;
  })());
const abort = async () => {
  if (aborting) {
    return;
  }
  aborting = true;
  report.status = "failed";
  (report.failures as unknown[]).push(
    `Interrupted or profile deadline exceeded during ${String(report.currentPhase)}`,
  );
  save();
  // Teardown signals only processes acquired by this invocation; a final exit also
  // stops source archive Worker threads that may still be doing bounded I/O.
  const forcedExit = setTimeout(() => process.exit(1), 10_000);
  try {
    await cleanupOwnedResources();
  } catch (error) {
    (report.failures as unknown[]).push(String(error));
  }
  report.finishedAt = new Date().toISOString();
  save();
  clearTimeout(forcedExit);
  console.error("[session-retention] FAILED (exit 1)");
  process.exit(1);
};
const onSignal = () => {
  void abort();
};
process.once("SIGTERM", onSignal);
process.once("SIGINT", onSignal);
try {
  const {
    RETENTION_PROFILES,
    RETENTION_AGENT_ID,
    makeRetentionFixtures,
    seedRetentionFixtures,
    readRetentionSnapshot,
    checkRetentionIntegrity,
    proveRetentionOwners,
    proveRetentionHighWater,
    proveSourceRetentionDisk,
  } = await import("./session-retention-fixture.js");
  const { createOpenClawTestInstance } =
    await import("../../test/helpers/openclaw-test-instance.js");
  const { openOpenClawAgentDatabase, closeOpenClawAgentDatabasesForTest } =
    await import("../../src/state/openclaw-agent-db.js");
  const { closeOpenClawStateDatabaseForTest } =
    await import("../../src/state/openclaw-state-db.js");
  const profile = values.profile;
  report.requested = RETENTION_PROFILES[profile];
  const deadline = Date.now() + RETENTION_PROFILES[profile].deadlineMs;
  watchdog = setTimeout(() => {
    void abort();
  }, RETENTION_PROFILES[profile].deadlineMs);
  const progress = (value: unknown) => {
    assert(!aborting, "profile interrupted");
    assert(Date.now() < deadline, "profile total deadline exceeded");
    console.log(JSON.stringify(value));
  };
  const phase = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
    progress({ phase: name, status: "started" });
    report.currentPhase = name;
    save();
    const started = performance.now();
    const result = await work();
    (report.phases as Record<string, unknown>)[name] = {
      elapsedMs: performance.now() - started,
      result,
    };
    progress({ phase: name, status: "passed", elapsedMs: performance.now() - started });
    save();
    return result;
  };
  const { resolveLoadedCommitHash } = await import("../../src/infra/git-commit.js");
  const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  report.identity = {
    sourceCommitPrefix: resolveLoadedCommitHash({ moduleUrl: import.meta.url }),
    sourceToBuildBinding:
      "Parent must verify the materialized candidate tree and build it immediately before proof; metadata and hashes alone do not attest dirty/synced source bytes",
    node: process.version,
    platform: process.platform,
    proofFiles: Object.fromEntries(
      [
        "scripts/bench-session-retention.ts",
        "scripts/lib/session-retention-worker.ts",
        "scripts/lib/session-retention-fixture.ts",
        "scripts/lib/session-retention-live.ts",
        "scripts/lib/session-retention-ui.ts",
      ].map((file) => [file, hash(fs.readFileSync(file))]),
    ),
  };
  let expectedBuildId: string | undefined;
  let assertBuildUnchanged = () => {};
  if (values.mode === "live") {
    assert(
      browserExecutable && fs.existsSync(browserExecutable),
      "Missing Playwright Chromium; run node_modules/.bin/playwright install --with-deps chromium before live proof",
    );
    const files = [
      "dist/index.js",
      `dist/${BUILD_STAMP_FILE}`,
      `dist/${RUNTIME_POSTBUILD_STAMP_FILE}`,
      "dist/build-info.json",
      "dist/control-ui/index.html",
    ];
    for (const file of files) {
      assert(
        fs.existsSync(file),
        `Missing ${file}; parent must build this exact candidate before live proof`,
      );
    }
    const metadata = normalizeControlUiBuildInfo(
      JSON.parse(fs.readFileSync("dist/build-info.json", "utf8")),
    );
    const buildStamp = JSON.parse(fs.readFileSync(`dist/${BUILD_STAMP_FILE}`, "utf8"));
    const postbuildStamp = JSON.parse(
      fs.readFileSync(`dist/${RUNTIME_POSTBUILD_STAMP_FILE}`, "utf8"),
    );
    const { readBuildIdFromBuildInfoForModuleUrl } = await import("../../src/version.js");
    expectedBuildId =
      readBuildIdFromBuildInfoForModuleUrl(pathToFileURL(path.resolve("dist/index.js")).href) ??
      undefined;
    assert(
      expectedBuildId && expectedBuildId !== "dev",
      "build-info must identify the candidate build",
    );
    assert.equal(expectedBuildId, metadata.buildId);
    const recordedHeads = [metadata.commit, buildStamp.head, postbuildStamp.head].filter(
      (head): head is string => typeof head === "string",
    );
    assert(
      recordedHeads.every((head) => head === recordedHeads[0]),
      "build metadata records conflicting commits",
    );
    const hashes = Object.fromEntries(files.map((file) => [file, hash(fs.readFileSync(file))]));
    assertBuildUnchanged = () => {
      for (const file of files) {
        assert.equal(hash(fs.readFileSync(file)), hashes[file], `built artifact changed: ${file}`);
      }
    };
    report.build = {
      metadata,
      buildStamp,
      postbuildStamp,
      hashes,
      checks: [
        "recorded commit agreement where present",
        "normal runtime build-id resolver agrees with normalized build-info",
        "artifact hashes unchanged before every Gateway start and after live proof",
        "authenticated hello build ID equals expected build ID",
        "served UI entry asset equals bundled bytes",
      ],
      materializedSourceTreeVerifiedByRunner: false,
    };
  }
  const workspace = path.join(runtime, "workspace");
  fs.mkdirSync(workspace);
  const instance = await createOpenClawTestInstance({
    name: "session-retention",
    cwd: repo,
    config: {
      env: { shellEnv: { enabled: false } },
      gateway: { mode: "local", controlUi: { enabled: true }, tailscale: { mode: "off" } },
      agents: {
        ownership: "explicit",
        defaults: {
          workspace,
          skipBootstrap: true,
          model: { primary: "retention-proof/synthetic-retention" },
          heartbeat: { every: "0m" },
        },
        entries: { [RETENTION_AGENT_ID]: { name: "Retention proof", workspace } },
      },
      session: {
        maintenance: { preserveRecent: "1h", ...(profile === "smoke" ? { maxEntries: 32 } : {}) },
      },
      hooks: { enabled: false },
      browser: { enabled: false },
      cron: { enabled: false },
      discovery: { mdns: { mode: "off" } },
      plugins: { enabled: false },
      models: { mode: "replace", providers: {} },
      update: { checkOnStart: false, auto: { enabled: false } },
      logging: {
        level: "info",
        consoleLevel: "info",
        consoleStyle: "json",
        file: path.resolve(output, "gateway.jsonl"),
      },
    },
  });
  // Undo the harness's fast-test settings: exercise the normal built Gateway, not minimal mode.
  for (const name of Object.keys(instance.env)) {
    if (
      !cleanEnvKeys.has(name) &&
      ![
        "OPENCLAW_CONFIG_PATH",
        "OPENCLAW_STATE_DIR",
        "OPENCLAW_HOME",
        "HOME",
        "USERPROFILE",
      ].includes(name)
    ) {
      delete instance.env[name];
    }
  }
  cleanup = async () => {
    try {
      await instance.stopGateway();
    } finally {
      fs.writeFileSync(path.join(output, "gateway-tail.log"), instance.logs());
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      instance.state.restoreEnv();
    }
  };
  instance.state.applyEnv();
  const store = {
    agentId: RETENTION_AGENT_ID,
    path: openOpenClawAgentDatabase({ agentId: RETENTION_AGENT_ID }).path,
    storePath: path.join(instance.state.sessionsDir(RETENTION_AGENT_ID), "sessions.json"),
  };
  const rows = makeRetentionFixtures(profile, Date.now());
  await phase("seed", async () => {
    await seedRetentionFixtures(store, rows, progress);
    const current = readRetentionSnapshot(store);
    assert.equal(current.nodes, rows.length);
    assert.equal(current.events, rows.length * 10);
    assert.equal(current.generations, rows.length * 2);
    return {
      ...current,
      integrity: checkRetentionIntegrity(store),
      provenance:
        "writeSessionEntry + appendTranscriptEventsInTransaction inside runOpenClawAgentWriteTransaction; 100 logical rows per transaction; two windows/10 events per row; no explicit old-window references",
      disposable: rows.filter((row) => row.disposable).length,
    };
  });
  await phase("owner-retention", () => proveRetentionOwners(store, rows, profile));
  if (profile !== "smoke") {
    const threshold = {
      agentId: "threshold",
      path: openOpenClawAgentDatabase({ agentId: "threshold" }).path,
      storePath: path.join(instance.state.sessionsDir("threshold"), "sessions.json"),
    };
    await phase("default-high-water", () => proveRetentionHighWater(threshold));
  } else {
    report.highWaterLimit =
      "Not run in cheap smoke; scale/massive run real 5499→5500 default boundary";
  }
  if (values.mode === "live") {
    const { proveBuiltRetentionLive } = await import("./session-retention-live.js");
    await phase("live", () =>
      proveBuiltRetentionLive({
        instance,
        store,
        rows,
        profile,
        output: path.resolve(output),
        deadline,
        phase,
        registerCleanup,
        browserExecutable: browserExecutable!,
        expectedBuildId: expectedBuildId!,
        assertBuildUnchanged,
      }),
    );
  } else {
    await phase("source-disk-pressure", () => proveSourceRetentionDisk(store));
  }
  report.final = readRetentionSnapshot(store);
  report.integrity = checkRetentionIntegrity(store);
  assert(!aborting);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  (report.failures as unknown[]).push(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
} finally {
  if (watchdog) {
    clearTimeout(watchdog);
  }
  process.off("SIGTERM", onSignal);
  process.off("SIGINT", onSignal);
  try {
    await cleanupOwnedResources();
  } catch (error) {
    report.status = "failed";
    (report.failures as unknown[]).push(String(error));
    process.exitCode = 1;
  }
  report.finishedAt = new Date().toISOString();
  save();
  console.log(
    JSON.stringify({ status: report.status, summary: path.join(output, "summary.json") }),
  );
  if (process.exitCode) {
    console.error(`[session-retention] FAILED (exit ${process.exitCode})`);
  }
}
