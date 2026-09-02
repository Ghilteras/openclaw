// Reproducible, synthetic-only retention stress proof; see scripts/e2e/session-retention.md.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { normalizeControlUiBuildInfo } from "../ui/src/build-info-normalizers.ts";
import {
  BUILD_STAMP_FILE,
  RUNTIME_POSTBUILD_STAMP_FILE,
} from "./lib/local-build-metadata-paths.mts";

const { values } = parseArgs({
  options: {
    profile: { type: "string", default: "smoke" },
    mode: { type: "string", default: "owner" },
    "output-dir": { type: "string", default: ".artifacts/session-retention" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  console.log(
    "node --import tsx scripts/bench-session-retention.ts --profile smoke|scale|massive --mode owner|live --output-dir .artifacts/session-retention\nowner: seed, retention, threshold, disk; live additionally runs real Gateway/UI, concurrent RPCs and restart/crash recovery. No credentials; requires built dist for live. See scripts/e2e/session-retention.md.",
  );
} else {
  assert(["smoke", "scale", "massive"].includes(values.profile));
  assert(["owner", "live"].includes(values.mode));
  const repo = process.cwd();
  const outputParent = values["output-dir"];
  assert(
    !path.isAbsolute(outputParent) && !outputParent.split(/[\\/]/u).includes(".."),
    "output-dir must be repo-relative",
  );
  fs.mkdirSync(outputParent, { recursive: true });
  const output = fs.mkdtempSync(path.join(outputParent, `${values.profile}-`));
  const runtime = path.resolve(output, "runtime");
  // Resolve installed browser bytes before HOME isolation; profiles remain invocation-owned.
  const browserExecutable =
    values.mode === "live" ? (await import("playwright")).chromium.executablePath() : undefined;
  const home = path.join(runtime, "home");
  // Chromium creates Unix sockets in TMPDIR; nested artifact paths exceed their
  // platform limit. Retain a link to the invocation-owned short temp tree.
  const tmpParent = process.platform === "win32" ? os.tmpdir() : fs.realpathSync("/tmp");
  const tmp = fs.mkdtempSync(path.join(tmpParent, "oc-retention-"));
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.symlinkSync(tmp, path.join(runtime, "tmp"), process.platform === "win32" ? "junction" : "dir");
  // Empty-by-construction environment precedes imports that may initialize runtime owners.
  // Never hydrate provider auth, copy operator state, or retain inherited OPENCLAW_* overrides.
  const cleanEnv = {
    PATH: process.env.PATH,
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
    HOME: home,
    OPENCLAW_HOME: home,
    OPENCLAW_STATE_DIR: path.join(runtime, "bootstrap-state"),
    OPENCLAW_CONFIG_PATH: path.join(runtime, "bootstrap.json"),
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    NO_COLOR: "1",
    LANG: "C.UTF-8",
  };
  for (const name of Object.keys(process.env)) {
    delete process.env[name];
  }
  for (const [name, value] of Object.entries(cleanEnv)) {
    if (value !== undefined) {
      process.env[name] = value;
    }
  }
  const report: Record<string, unknown> = {
    status: "running",
    profile: values.profile,
    mode: values.mode,
    output,
    startedAt: new Date().toISOString(),
    capturesInspected: false,
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
    await Promise.allSettled([...teardowns.map((work) => work()), cleanup?.()]);
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
    } = await import("./lib/session-retention-fixture.js");
    const { createOpenClawTestInstance } =
      await import("../test/helpers/openclaw-test-instance.js");
    const { openOpenClawAgentDatabase, closeOpenClawAgentDatabasesForTest } =
      await import("../src/state/openclaw-agent-db.js");
    const { closeOpenClawStateDatabaseForTest } = await import("../src/state/openclaw-state-db.js");
    const profile = values.profile as keyof typeof RETENTION_PROFILES;
    report.requested = RETENTION_PROFILES[profile];
    const deadline = Date.now() + RETENTION_PROFILES[profile].deadlineMs;
    watchdog = setTimeout(() => {
      void abort();
    }, RETENTION_PROFILES[profile].deadlineMs);
    const progress = (value: unknown) => {
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
    const { resolveLoadedCommitHash } = await import("../src/infra/git-commit.js");
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
      const { readBuildIdFromBuildInfoForModuleUrl } = await import("../src/version.js");
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
          assert.equal(
            hash(fs.readFileSync(file)),
            hashes[file],
            `built artifact changed: ${file}`,
          );
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
        !(name in cleanEnv) &&
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
    instance.state.applyEnv();
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
      const { proveBuiltRetentionLive } = await import("./lib/session-retention-live.js");
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
    report.failures = [error instanceof Error ? error.stack : String(error)];
    process.exitCode = 1;
  } finally {
    if (watchdog) {
      clearTimeout(watchdog);
    }
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
    try {
      const stopped = await Promise.allSettled(teardowns.map((work) => work()));
      const failed = stopped.filter((result) => result.status === "rejected");
      assert.deepEqual(failed, [], "owned process teardown failed");
      await cleanup?.();
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
}
