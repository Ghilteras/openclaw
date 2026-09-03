import assert from "node:assert/strict";
import { fork, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import net, { type Socket } from "node:net";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { z } from "zod";
import {
  inspectManagedProcessGroup,
  terminateManagedChild,
} from "../../scripts/lib/managed-child-process.mts";

type Step = { name?: string; run?: string; env?: Record<string, string | number> };
const processRecord = z.object({
  pid: z.number().int().positive(),
  role: z.string(),
  attempt: z.number().int().nonnegative(),
  instance: z.string(),
  creationTime: z.string().regex(/^\d+$/u).optional(),
});
const processDiagnostic = z.object({
  command: z.string(),
  code: z.number().nullable(),
  signal: z.string().nullable(),
  stderr: z.string().max(4_096),
});
const reportSchema = z.object({
  code: z.number().nullable(),
  cancelledDuringCleanup: z.boolean(),
  error: z.string().optional(),
  boundaries: z.array(
    z.object({ name: z.string(), alive: z.array(processRecord), sentinelAlive: z.boolean() }),
  ),
  readyAttempts: z.array(z.number()),
  cleanupRemaining: z.array(processRecord).length(0),
  ownedProcesses: z.array(processRecord),
  commands: z.array(
    z.object({
      tool: z.string(),
      cwd: z.string(),
      args: z.array(z.string()),
      configuration: z.array(z.string()).optional(),
      envProbe: z.string().optional(),
    }),
  ),
  output: z.string(),
  processDiagnostics: z.record(z.enum(["censusService", "sentinel"]), processDiagnostic.nullable()),
});
type Report = z.infer<typeof reportSchema>;
type CloseResult = { code: number | null; signal: NodeJS.Signals | null };
type CensusService = {
  env: NodeJS.ProcessEnv;
  token: string;
  connect(payload?: Buffer): Promise<Socket>;
  exchange(payload: Buffer, options?: { end?: boolean; timeoutMs?: number }): Promise<unknown>;
  request(request: { op: string; [key: string]: unknown }, timeoutMs?: number): Promise<unknown>;
  waitForExit(timeoutMs?: number): Promise<CloseResult>;
};

export const ciCheckoutFixture = fileURLToPath(
  new URL("./fixtures/ci-platform-checkout.mjs", import.meta.url),
);
const windowsCensusFixture = fileURLToPath(
  new URL("./fixtures/ci-windows-process-census.py", import.meta.url),
);
const within = <T>(promise: Promise<T>, timeoutMs: number, label: string) =>
  Promise.race([
    promise,
    delay(timeoutMs, undefined, { ref: false }).then(() => {
      throw new Error(`${label} timed out`);
    }),
  ]);
const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8")) as {
  jobs: Record<string, { steps: Step[] }>;
};

export function readCiCheckoutStep(job: string, name = "Checkout"): Step & { run: string } {
  const step = workflow.jobs[job]?.steps.find((entry) => entry.name === name);
  if (!step?.run) {
    throw new Error(`Missing executable workflow step ${job}/${name}`);
  }
  return { ...step, run: step.run };
}

export function renderGitTestClock(
  source: string,
  options: { realClock?: boolean; realDrain?: boolean } = {},
) {
  let rendered = source;
  // Command deadlines and TERM grace are independent. Real-clock callers keep
  // real grace unless they explicitly opt into the fixture's immediate escalation.
  if (!(options.realDrain ?? options.realClock)) {
    rendered = rendered.replace(
      "kill_at = deadline - cleanup_seconds / 2",
      "kill_at = time.monotonic()",
    );
  }
  if (options.realClock) {
    return rendered;
  }
  // Only a ready, deliberately stalled tree advances the fetch clock. Real
  // process startup and teardown retain their independent wall-clock watchdogs.
  return (
    rendered
      .replace(/fetch_timeout_seconds = [^\n]+/u, "fetch_timeout_seconds = 2")
      .replace(
        "def run_git(",
        `def fetch_clock():
    return 2 * sum(name.startswith("fetch-tick-") and name.endswith(".json")
                   for name in os.listdir(os.environ["TMPDIR"]))


def run_git(`,
      )
      .replace("deadline = time.monotonic() + timeout", "deadline = fetch_clock() + timeout")
      .replace(
        "deadline is not None and time.monotonic() >= deadline",
        "deadline is not None and fetch_clock() >= deadline",
      )
      .replace(/\btimeout=(?:30|60|120)(?=[,)])/gu, "timeout=2")
      .replace(
        /retry_at = time\.monotonic\(\) \+ [^\n]+/u,
        'print(f"fixture backoff: {seconds}", flush=True)\n    retry_at = time.monotonic() + 0.05',
      )
      .replace(/--((?:checkout-)?git) 120\b/gu, "--$1 2")
      // Keep pre-fix standalone shell bodies executable for red/green proof.
      .replaceAll("120s git", "2s git")
      .replaceAll("sleep $((attempt * 2))", 'echo "fixture backoff: $((attempt * 2))"')
      .replaceAll("sleep $((attempt * 5))", "sleep 0.05")
      .replaceAll("sleep 5", "sleep 0.05")
  );
}

export function expectCiCheckoutCleanup(report: Report) {
  assert.deepEqual(report.cleanupRemaining, [], "fixture cleanup left owned processes");
  assert.equal(report.boundaries.at(-1)?.name, "exit");
  assert(
    report.boundaries.every((entry) => entry.sentinelAlive),
    "unrelated process killed",
  );
  assert.deepEqual(
    report.boundaries.filter((entry) => entry.alive.length > 0),
    [],
    "Git descendants survived BEFORE deletion, reuse, consumption, or exit",
  );
}

export async function withWindowsCensusService<T>(
  run: (service: CensusService) => T | Promise<T>,
  options: { parentPid?: number } = {},
): Promise<T> {
  assert.equal(process.platform, "win32", "Windows census service requires Windows");
  const token = randomUUID();
  const child = spawn("python", ["-I", "-S", windowsCensusFixture], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      OPENCLAW_CI_CENSUS_TOKEN: token,
      OPENCLAW_CI_CENSUS_PARENT_PID: String(options.parentPid ?? process.pid),
      OPENCLAW_CI_CENSUS_MAX_LIFETIME_MS: "49000",
    },
  });
  let stderr = "";
  child.stderr?.on("data", (data) => (stderr += String(data)));
  const closed = once(child, "close").then(([code, signal]) => ({ code, signal }));
  const stdout = child.stdout;
  assert(stdout);
  const lines = createInterface({ input: stdout });
  const [line] = await within(once(lines, "line"), 5_000, "Census service readiness");
  lines.close();
  const ready = JSON.parse(String(line)) as { v: number; port: number };
  assert.deepEqual(Object.keys(ready).toSorted(), ["port", "v"]);
  assert.equal(ready.v, 1);
  assert(Number.isInteger(ready.port) && ready.port >= 1 && ready.port <= 65_535);

  const connect = async (payload?: Buffer) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: ready.port });
    if (payload) {
      socket.write(payload);
    }
    await within(once(socket, "connect"), 2_000, "Census connection");
    socket.on("error", () => {});
    return socket;
  };
  const exchange = async (
    payload: Buffer,
    { end = true, timeoutMs = 2_000 }: { end?: boolean; timeoutMs?: number } = {},
  ) => {
    const socket = await connect();
    const chunks: Buffer[] = [];
    socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    if (end) {
      socket.end(payload);
    } else {
      socket.write(payload);
    }
    await within(once(socket, "end"), timeoutMs, "Census request");
    const data = Buffer.concat(chunks).toString();
    assert(Buffer.byteLength(data) <= 16_384, "Census response was oversized");
    const [responseLine, tail, extra] = data.split("\n");
    assert(responseLine && tail === "" && extra === undefined, "Census response frame was invalid");
    return JSON.parse(responseLine);
  };
  const waitForExit = (timeoutMs = 2_000) => within(closed, timeoutMs, "Census service exit");
  const service: CensusService = {
    env: {
      OPENCLAW_CI_CENSUS_TOKEN: token,
      OPENCLAW_CI_CENSUS_PORT: String(ready.port),
      OPENCLAW_CI_CENSUS_DEADLINE_MS: String(Date.now() + 45_000),
    },
    token,
    connect,
    exchange,
    request: (request, timeoutMs) =>
      exchange(Buffer.from(`${JSON.stringify({ v: 1, token, ...request })}\n`), { timeoutMs }),
    waitForExit,
  };
  try {
    return await run(service);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        await service.request({ op: "shutdown" }, 1_000);
      } catch {}
    }
    let exit;
    try {
      exit = await waitForExit();
    } catch {
      child.kill("SIGKILL");
      exit = await closed;
    }
    assert.deepEqual(exit, { code: 0, signal: null }, stderr);
    assert.equal(stderr, "");
  }
}

export async function withCiCheckoutFixture<T>(
  scenario: string,
  prepare: (root: string) => NodeJS.ProcessEnv | void,
  inspect: (report: Report, result: CloseResult, stderr: string, root: string) => T | Promise<T>,
): Promise<T> {
  // Detached writers can outlive Vitest's oc-vt TMPDIR. Retained diagnostics must
  // start outside that recursively deleted namespace, including on setup failure.
  const artifacts = fileURLToPath(new URL("../../.artifacts/ci-checkout/", import.meta.url));
  mkdirSync(artifacts, { recursive: true });
  const root = realpathSync(mkdtempSync(path.join(artifacts, "checkout ")));
  let supervisor: ChildProcess;
  try {
    mkdirSync(path.join(root, "workspace"));
    const env = { ...process.env, ...prepare(root) };
    supervisor = fork(ciCheckoutFixture, ["supervise", root, scenario], {
      detached: true,
      execArgv: [],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      env,
    });
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  let stderr = "";
  // An error can precede close, including failed spawn. Never reject this join.
  const closed = new Promise<CloseResult>((resolve) => {
    supervisor.once("close", (code, signal) => {
      resolve({ code, signal });
    });
  });
  supervisor.stderr?.on("data", (data) => (stderr += String(data)));
  supervisor.on("error", (error) => (stderr += `${error}\n`));
  let timer: NodeJS.Timeout | undefined;
  let report: Report | undefined;
  try {
    const completed = await Promise.race([
      closed,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Checkout supervisor did not close within 50000ms")),
          50_000,
        );
      }),
    ]);
    clearTimeout(timer);
    report = reportSchema.parse(JSON.parse(readFileSync(path.join(root, "report.json"), "utf8")));
    return await inspect(report, completed, stderr, root);
  } finally {
    clearTimeout(timer);
    if (report) {
      // A consumer assertion failure does not revoke the producer's release receipt.
      rmSync(root, { recursive: true, force: true });
    } else {
      const deadline = Date.now() + 4_000;
      // Keep IPC attached through termination: explicit disconnect can suppress Node's close.
      // Let lease-bound Git descendants stop even if the supervisor cannot run cleanup.
      rmSync(path.join(root, "lease"), { force: true });
      const termination = terminateManagedChild(supervisor, "SIGKILL", {
        taskkillTimeoutMs: 2_000,
        processGroupFallback: "never",
      });
      const groupDead = () =>
        !supervisor.pid ||
        (process.platform === "win32"
          ? termination?.processTreeState === "terminated"
          : inspectManagedProcessGroup(supervisor, { errorPolicy: "indeterminate" }) === "dead");
      // Join actual close before checking extinction, sharing the original cleanup budget.
      const didClose = await Promise.race([
        closed.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now()));
        }),
      ]);
      clearTimeout(timer);
      while (!groupDead()) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          break;
        }
        await delay(Math.min(10, remaining));
      }
      console.error(
        `Checkout fixture retained at ${root}; no completed report. ` +
          `Supervisor close: ${didClose}; group extinction: ${groupDead()}. ` +
          `Inspect workflow.log and stop remaining owned writers before removing this exact directory.\n${stderr}`,
      );
    }
  }
}
