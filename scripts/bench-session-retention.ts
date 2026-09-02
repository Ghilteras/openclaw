// Reproducible, synthetic-only retention stress proof; see scripts/e2e/session-retention.md.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { resolveTestBrowserCache } from "../test/test-home-context.mts";
import { runManagedCommand } from "./lib/managed-child-process.mts";
import type { SessionRetentionWorkerInput } from "./lib/session-retention-worker.js";

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
  assert(values.profile === "smoke" || values.profile === "scale" || values.profile === "massive");
  assert(values.mode === "owner" || values.mode === "live");
  const repo = process.cwd();
  const outputParent = values["output-dir"];
  assert(
    !path.isAbsolute(outputParent) && !outputParent.split(/[\\/]/u).includes(".."),
    "output-dir must be repo-relative",
  );
  fs.mkdirSync(outputParent, { recursive: true });
  const output = fs.mkdtempSync(path.join(outputParent, `${values.profile}-`));
  const runtime = path.resolve(output, "runtime");
  const summary = path.join(output, "summary.json");
  const startedAt = new Date().toISOString();
  const failures: string[] = [];
  let temporaryPath: string | undefined;
  let retainedPath: string | undefined;
  let workerStarted = false;
  let workerJoined = false;
  try {
    // Chromium and the video encoder share this tooling cache. Preserve its
    // location across HOME isolation; browser profiles stay invocation-owned.
    const browserCache = resolveTestBrowserCache(process.env, os.homedir());
    const browserExecutable =
      values.mode === "live" ? (await import("playwright")).chromium.executablePath() : undefined;
    const home = path.join(runtime, "home");
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    // Chromium's Unix sockets cannot use the deeply nested artifact path.
    const tmpParent = process.platform === "win32" ? os.tmpdir() : fs.realpathSync("/tmp");
    temporaryPath = fs.mkdtempSync(path.join(tmpParent, "oc-retention-"));
    retainedPath = temporaryPath;
    fs.symlinkSync(
      temporaryPath,
      path.join(runtime, "tmp"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const input: SessionRetentionWorkerInput = {
      profile: values.profile,
      mode: values.mode,
      output,
      browserExecutable,
    };
    process.exitCode = await runManagedCommand({
      bin: process.execPath,
      args: [
        "--import",
        pathToFileURL(path.join(repo, "scripts/tsx.mjs")).href,
        path.join(repo, "scripts/lib/session-retention-worker.ts"),
        JSON.stringify(input),
      ],
      cwd: repo,
      shell: false,
      requireProcessTreeExit: process.platform !== "win32",
      onReady: (child) => {
        workerStarted = child.pid !== undefined;
      },
      // Isolation is established at spawn, before loaders and runtime owners initialize.
      env: {
        PATH: process.env.PATH,
        PLAYWRIGHT_BROWSERS_PATH: browserCache,
        HOME: home,
        USERPROFILE: home,
        OPENCLAW_HOME: home,
        OPENCLAW_STATE_DIR: path.join(runtime, "bootstrap-state"),
        OPENCLAW_CONFIG_PATH: path.join(runtime, "bootstrap.json"),
        TMPDIR: temporaryPath,
        TMP: temporaryPath,
        TEMP: temporaryPath,
        XDG_CONFIG_HOME: path.join(home, ".config"),
        XDG_CACHE_HOME: path.join(home, ".cache"),
        NO_COLOR: "1",
        LANG: "C.UTF-8",
      },
    });
    workerJoined = true;
  } catch (error) {
    failures.push(String(error));
    process.exitCode = 1;
  }
  const report: Record<string, unknown> = fs.existsSync(summary)
    ? JSON.parse(fs.readFileSync(summary, "utf8"))
    : {
        status: "failed",
        profile: values.profile,
        mode: values.mode,
        output,
        startedAt,
        capturesInspected: false,
        phases: {},
        failures: [],
      };
  try {
    if (temporaryPath && (!workerStarted || (workerJoined && report.cleanupComplete === true))) {
      // The temp tree contains raw fixture databases, not just browser scratch.
      // Relocate it only after cleanup; cross-device copies must finish before removing it.
      const destination = path.join(runtime, "tmp");
      fs.unlinkSync(destination);
      try {
        let copied = false;
        try {
          fs.renameSync(temporaryPath, destination);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EXDEV") {
            throw error;
          }
          const staging = path.join(runtime, "retained-tmp");
          fs.cpSync(temporaryPath, staging, {
            recursive: true,
            force: false,
            errorOnExist: true,
            verbatimSymlinks: true,
          });
          fs.renameSync(staging, destination);
          copied = true;
        }
        retainedPath = destination;
        if (copied) {
          fs.rmSync(temporaryPath, { recursive: true });
        }
      } catch (error) {
        // Failed relocation keeps the original evidence reachable, never a dangling link.
        if (!fs.existsSync(destination)) {
          fs.symlinkSync(
            temporaryPath,
            destination,
            process.platform === "win32" ? "junction" : "dir",
          );
        }
        throw error;
      }
    } else if (temporaryPath) {
      failures.push("Worker cleanup was not verified; raw temporary state retained in place");
    }
  } catch (error) {
    failures.push(`Temporary evidence retention failed: ${String(error)}`);
  }
  if (process.exitCode || failures.length > 0) {
    report.status = "failed";
    process.exitCode ||= 1;
  }
  report.failures = [...((report.failures as unknown[] | undefined) ?? []), ...failures];
  report.bootstrap = {
    exitCode: process.exitCode ?? 0,
    workerStarted,
    workerJoined,
    temporaryPath,
    retainedPath,
    relocated: retainedPath !== temporaryPath,
  };
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(summary, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ status: report.status, summary, retainedPath }));
  if (process.exitCode) {
    console.error(`[session-retention] FAILED (exit ${process.exitCode})`);
  }
}
