import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { SessionSchema } from "../../src/config/zod-schema.session.js";
import { GatewayClient, isGatewayProtocolResponseError } from "../../src/gateway/client.js";
import { closeOpenClawAgentDatabasesForTest } from "../../src/state/openclaw-agent-db.js";
import type { OpenClawTestInstance } from "../../test/helpers/openclaw-test-instance.js";
import { applyMockOpenAiModelConfig } from "../e2e/lib/fixtures/mock-openai-config.mjs";
import { stopChild } from "./gateway-bench-child.js";
import { getFreePort, readProcessRssMb } from "./gateway-bench-probes.js";
import { terminateManagedChild } from "./managed-child-process.mts";
import {
  RETENTION_AGENT_ID,
  RETENTION_PROFILES,
  checkRetentionIntegrity,
  readRetentionDatabase,
  readRetentionEntry,
  prepareRetentionDiskFixtures,
  proveRetentionDiskScenario,
  retentionSessionKey,
  readRetentionSnapshot,
  retentionWindowIds,
  type RetentionFixture,
  type RetentionProfile,
  type RetentionStore,
} from "./session-retention-fixture.js";
import { proveRetentionUi } from "./session-retention-ui.js";

type Receipt = {
  method: string;
  key?: string;
  sent: boolean;
  outcome: "pending" | "acknowledged" | "rejected" | "rate-limited" | "unknown";
  errorCode?: string;
  retryAfterMs?: number;
  elapsedMs?: number;
  error?: string;
};
type Roster = {
  sessions: { key: string; sessionId: string; archived?: boolean }[];
  hasMore?: boolean;
};
export type RetentionRpc = <T = Record<string, unknown>>(
  method: string,
  params: Record<string, unknown>,
  client?: GatewayClient,
) => Promise<T>;
function summarizeRetentionSamples(values: number[]) {
  const sorted = values.toSorted((a, b) => a - b);
  const at = (p: number) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? null;
  return { samples: sorted.length, p50: at(0.5), p95: at(0.95), max: sorted.at(-1) ?? null };
}
async function until(check: () => Promise<boolean>, label: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await delay(50);
  }
  throw new Error(`Timed out: ${label}`);
}

export async function proveBuiltRetentionLive(params: {
  instance: OpenClawTestInstance;
  store: RetentionStore;
  rows: RetentionFixture[];
  profile: RetentionProfile;
  output: string;
  deadline: number;
  phase: <T>(name: string, run: () => Promise<T>) => Promise<T>;
  registerCleanup: (work: () => Promise<void>) => () => Promise<void>;
  browserExecutable: string;
  expectedBuildId: string;
  assertBuildUnchanged: () => void;
}) {
  const { instance, store, rows, profile, output } = params;
  let samplingPhase = "startup";
  const phase = <T>(name: string, run: () => Promise<T>) => {
    samplingPhase = name;
    return params.phase(name, run);
  };
  const receipts: Receipt[] = [];
  const clients: GatewayClient[] = [];
  const latencies: number[] = [],
    healthLatencies: number[] = [],
    rss: number[] = [];
  const acknowledgedMessages: { key: string; text: string; messageId?: string }[] = [];
  const bootIds: string[] = [];
  const liveIdentities = new Map<string, string>();
  const port = await getFreePort();
  const control = path.join(output, "provider-control.json");
  const providerLog = path.join(output, "provider-requests.jsonl");
  const marker = "SESSION_RETENTION_SYNTHETIC_OK";
  const setHold = (hold: boolean) =>
    fs.writeFileSync(control, JSON.stringify({ hold, text: marker }));
  setHold(false);
  const config = JSON.parse(fs.readFileSync(instance.configPath, "utf8"));
  applyMockOpenAiModelConfig(config, {
    mockPort: port,
    modelRef: "retention-proof/synthetic-retention",
  });
  config.models.providers["retention-proof"] = config.models.providers.openai;
  delete config.models.providers.openai;
  config.models.mode = "replace";
  config.models.providers["retention-proof"].apiKey = "synthetic-retention-fixture-key";
  config.models.providers["retention-proof"].auth = "api-key";
  config.plugins.allow = ["openai"];
  await instance.state.writeConfig(config);
  const provider = spawn(process.execPath, [path.resolve("scripts/e2e/mock-openai-server.mjs")], {
    cwd: instance.homeDir,
    env: {
      ...instance.env,
      MOCK_PORT: String(port),
      MOCK_BIND_HOST: "127.0.0.1",
      SUCCESS_MARKER: marker,
      MOCK_REQUEST_LOG: providerLog,
      MOCK_RESPONSE_CONTROL: control,
    },
    detached: process.platform !== "win32",
    stdio: "pipe",
  });
  const providerOutput = fs.createWriteStream(path.join(output, "provider.log"));
  provider.stdout.pipe(providerOutput, { end: false });
  provider.stderr.pipe(providerOutput, { end: false });
  const stopProvider = params.registerCleanup(async () => {
    await stopChild(provider);
    providerOutput.end();
  });
  const rpc: RetentionRpc = async <T>(
    method: string,
    args: Record<string, unknown>,
    client = clients[0],
  ) => {
    assert(Date.now() < params.deadline, "profile total deadline exceeded");
    assert(client);
    const receipt: Receipt = {
      method,
      key:
        typeof args.key === "string"
          ? args.key
          : typeof args.sessionKey === "string"
            ? args.sessionKey
            : undefined,
      sent: false,
      outcome: "pending",
    };
    assert(receipts.length < 10_000, "RPC receipt bound exceeded");
    receipts.push(receipt);
    const start = performance.now();
    try {
      const value = await client.request<T>(method, args, {
        // A full disk sweep owns the remaining scenario budget, not a short UI request deadline.
        timeoutMs: Math.max(
          1,
          Math.min(
            method === "sessions.cleanup" ? Number.MAX_SAFE_INTEGER : 30_000,
            params.deadline - Date.now(),
          ),
        ),
        onSent: () => {
          receipt.sent = true;
        },
      });
      receipt.outcome = "acknowledged";
      return value;
    } catch (error) {
      const typed = isGatewayProtocolResponseError(error);
      // The current burst methods are not controlPlaneWrite descriptors. If that
      // changes, retain the typed rejection, not an invented lost acknowledgment.
      const rateLimited =
        typed &&
        error.code === "UNAVAILABLE" &&
        error.retryable &&
        typeof error.retryAfterMs === "number" &&
        error.retryAfterMs >= 0 &&
        isRecord(error.details) &&
        error.details.method === method &&
        error.details.limit === "30 per 60s";
      receipt.outcome = rateLimited ? "rate-limited" : typed ? "rejected" : "unknown";
      if (typed) {
        receipt.errorCode = error.code;
        receipt.retryAfterMs = error.retryAfterMs;
      }
      receipt.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      receipt.elapsedMs = performance.now() - start;
      latencies.push(receipt.elapsedMs);
    }
  };
  const connect = async () => {
    let client: GatewayClient;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        client.stop();
        reject(new Error("Gateway hello deadline"));
      }, 10_000);
      client = new GatewayClient({
        url: instance.url,
        token: instance.gatewayToken,
        clientName: "cli",
        mode: "cli",
        clientVersion: "retention-proof",
        scopes: ["operator.admin", "operator.read", "operator.write"],
        onHelloOk: (hello) => {
          clearTimeout(timer);
          try {
            assert(hello.server.bootId);
            assert.equal(
              hello.server.buildId,
              params.expectedBuildId,
              "serving Gateway build differs from candidate build-info",
            );
            bootIds.push(hello.server.bootId);
            resolve();
          } catch (error) {
            client.stop();
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        },
        onConnectError: (error) => {
          clearTimeout(timer);
          client.stop();
          reject(error);
        },
      });
      clients.push(client);
      client.start();
    });
    return client!;
  };
  const disconnect = async () => {
    await Promise.all(clients.splice(0).map((client) => client.stopAndWait()));
  };
  const samplingAbort = new AbortController();
  let samplingEnabled = false;
  let samplingEpoch = 0;
  let interruptedSamples = 0;
  let sampleFailureCount = 0;
  const sampleFailures: { phase: string; error: string }[] = [];
  const resourceSamples: {
    at: string;
    phase: string;
    pid: number;
    healthMs: number;
    rssBytes: number;
  }[] = [];
  const pauseSampling = () => {
    samplingEnabled = false;
    samplingEpoch++;
  };
  const sample = async () => {
    const child = instance.child;
    if (!samplingEnabled || !child?.pid || Date.now() >= params.deadline) {
      return;
    }
    const epoch = samplingEpoch;
    const samplePhase = samplingPhase;
    const start = performance.now();
    try {
      const rssMb = readProcessRssMb(child.pid);
      assert(rssMb !== null, "could not sample owned Gateway RSS");
      const response = await fetch(`http://127.0.0.1:${instance.port}/healthz`, {
        signal: AbortSignal.any([
          samplingAbort.signal,
          AbortSignal.timeout(Math.max(1, Math.min(10_000, params.deadline - Date.now()))),
        ]),
      });
      assert(response.ok, `Gateway health returned HTTP ${response.status}`);
      await response.text();
      if (epoch !== samplingEpoch || samplingAbort.signal.aborted) {
        interruptedSamples++;
        return;
      }
      assert(resourceSamples.length < 2_000, "resource sample bound exceeded");
      const healthMs = performance.now() - start;
      healthLatencies.push(healthMs);
      rss.push(rssMb * 1024 * 1024);
      resourceSamples.push({
        at: new Date().toISOString(),
        phase: samplePhase,
        pid: child.pid,
        healthMs,
        rssBytes: rssMb * 1024 * 1024,
      });
    } catch (error) {
      if (epoch !== samplingEpoch || samplingAbort.signal.aborted) {
        interruptedSamples++;
        return;
      }
      sampleFailureCount++;
      if (sampleFailures.length < 32) {
        sampleFailures.push({ phase: samplePhase, error: String(error) });
      }
    }
  };
  const sampling = (async () => {
    while (!samplingAbort.signal.aborted && Date.now() < params.deadline) {
      await sample();
      try {
        await delay(2_000, undefined, { signal: samplingAbort.signal });
      } catch (error) {
        if (!samplingAbort.signal.aborted) {
          throw error;
        }
      }
    }
  })();
  const stopSampler = params.registerCleanup(async () => {
    samplingAbort.abort();
    await sampling;
  });
  const startGateway = async () => {
    params.assertBuildUnchanged();
    await instance.startGateway();
    await connect();
    samplingEnabled = true;
  };
  const inject = async (key: string, text: string, client?: GatewayClient) => {
    const result = await rpc(
      "chat.inject",
      { sessionKey: key, agentId: RETENTION_AGENT_ID, message: text },
      client,
    );
    assert.equal(result.ok, true);
    assert.equal(
      typeof result.messageId,
      "string",
      "chat.inject must identify its committed message",
    );
    acknowledgedMessages.push({ key, text, messageId: result.messageId as string });
    return result;
  };
  const verifyMessages = async () => {
    for (const key of new Set(acknowledgedMessages.map((message) => message.key))) {
      const result = await rpc<{ messages: unknown[] }>("chat.history", {
        sessionKey: key,
        agentId: RETENTION_AGENT_ID,
        limit: 200,
      });
      const serialized = result.messages.map((message) => JSON.stringify(message));
      for (const expected of acknowledgedMessages.filter((message) => message.key === key)) {
        assert.equal(
          serialized.filter((message) => message.includes(expected.text)).length,
          1,
          `acknowledged message lost/duplicated: ${expected.text}`,
        );
        const messageId = expected.messageId;
        if (messageId) {
          readRetentionDatabase(store, (db) =>
            assert.equal(
              db
                .prepare(
                  "SELECT COUNT(*) AS count FROM transcript_event_identities i JOIN session_windows w USING (session_id) WHERE w.session_key = ? AND i.event_id = ?",
                )
                .get(key, messageId)?.count,
              1,
              "acknowledged message identity changed",
            ),
          );
        }
      }
    }
  };
  const roster = async () => {
    const seen = new Map<string, string>();
    for (let offset = 0; offset <= rows.length + 1_000; offset += 1_000) {
      const page = await rpc<Roster>("sessions.list", {
        agentId: RETENTION_AGENT_ID,
        archived: "all",
        limit: 1_000,
        offset,
      });
      for (const row of page.sessions) {
        assert(!seen.has(row.key), `duplicate page key: ${row.key}`);
        seen.set(row.key, row.sessionId);
      }
      if (!page.hasMore) {
        return seen;
      }
      assert(page.sessions.length > 0, "non-advancing sessions.list page");
    }
    throw new Error("sessions.list exceeded known dataset bound");
  };
  const seedIds = new Set(rows.filter((row) => !row.disposable).flatMap(retentionWindowIds));
  const verifySeed = () => {
    // Compare exact pre-existing bytes, ignoring only additional normal live messages.
    return readRetentionDatabase(store, (db) => {
      const digest = createHash("sha256");
      let count = 0;
      for (const row of db
        .prepare(
          "SELECT session_id, seq, event_json FROM transcript_events WHERE seq < 5 ORDER BY session_id, seq",
        )
        .iterate()) {
        if (!seedIds.has(String(row.session_id))) {
          continue;
        }
        digest.update(JSON.stringify([row.session_id, row.seq, row.event_json]) + "\n");
        count++;
      }
      return { count, sha256: digest.digest("hex") };
    });
  };
  const seedBefore = verifySeed();
  let crash: unknown;
  try {
    await until(async () => {
      try {
        return (
          await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1_000) })
        ).ok;
      } catch {
        return false;
      }
    }, "synthetic provider readiness");
    closeOpenClawAgentDatabasesForTest();
    await startGateway();
    await sample();
    const initial = await roster();
    for (const row of rows.filter((candidate) => !candidate.disposable)) {
      assert.equal(initial.get(row.key), row.entry.sessionId);
    }
    const liveKeys = Array.from({ length: RETENTION_PROFILES[profile].clients }, (_, i) =>
      retentionSessionKey(`dashboard:live-${i}`),
    );
    await phase("gateway-bursts", async () => {
      // Connect in bounded groups; all subsequent operation bursts use up to 64 distinct clients.
      for (let i = 1; i < liveKeys.length; i++) {
        await connect();
      }
      for (let round = 0; round < RETENTION_PROFILES[profile].rounds; round++) {
        const settled = await Promise.allSettled(
          liveKeys.map(async (key, i) => {
            const client = clients[i];
            assert(client);
            if (round === 0) {
              const created = await rpc(
                "sessions.create",
                {
                  key,
                  agentId: RETENTION_AGENT_ID,
                  label: `Live retention ${i}`,
                  idempotencyKey: `retention-create-${i}`,
                },
                client,
              );
              assert.equal(created.key, key);
              assert.equal(typeof created.sessionId, "string");
              liveIdentities.set(key, created.sessionId as string);
            }
            await rpc(
              "sessions.patch",
              { key, label: `Live retention ${i} round ${round}` },
              client,
            );
            await inject(key, `Acknowledged retention message client-${i} round-${round}.`, client);
            await rpc(
              "chat.history",
              { sessionKey: key, agentId: RETENTION_AGENT_ID, limit: 20 },
              client,
            );
            if (i % 8 === 0) {
              const expectedSessionId = liveIdentities.get(key);
              assert(expectedSessionId);
              await rpc("sessions.patch", { key, expectedSessionId, archived: true }, client);
              await rpc("sessions.patch", { key, expectedSessionId, archived: false }, client);
            }
            if (i === 1) {
              await rpc("sessions.cleanup", { agent: RETENTION_AGENT_ID, enforce: true }, client);
            }
          }),
        );
        const failed = settled.filter((result) => result.status === "rejected");
        assert.deepEqual(failed, [], "concurrent RPC burst failures (see receipts.json)");
      }
      await verifyMessages();
      return {
        clients: liveKeys.length,
        rounds: RETENTION_PROFILES[profile].rounds,
        acknowledgedMessages: acknowledgedMessages.length,
      };
    });
    await phase("admitted-provider-turn", async () => {
      const key = liveKeys[0]!;
      const id = randomUUID();
      const message = `Normal retained send ${id}`;
      const priorRequests = fs.existsSync(providerLog)
        ? fs.readFileSync(providerLog, "utf8").trim().split("\n").length
        : 0;
      setHold(true);
      const accepted = await rpc("chat.send", {
        sessionKey: key,
        agentId: RETENTION_AGENT_ID,
        message,
        idempotencyKey: id,
      });
      assert(accepted.runId);
      await until(
        async () =>
          fs.existsSync(providerLog) &&
          fs.readFileSync(providerLog, "utf8").trim().split("\n").length > priorRequests,
        "actual held provider request",
      );
      const held = readRetentionEntry(store, key);
      assert(held);
      assert.equal(held.archivedAt, undefined);
      await rpc("sessions.cleanup", { agent: RETENTION_AGENT_ID, enforce: true });
      assert.equal(readRetentionEntry(store, key)?.sessionId, held.sessionId);
      assert.equal(readRetentionEntry(store, key)?.archivedAt, undefined);
      const duplicate = await rpc("chat.send", {
        sessionKey: key,
        agentId: RETENTION_AGENT_ID,
        message,
        idempotencyKey: id,
      });
      assert.equal(duplicate.runId, accepted.runId);
      setHold(false);
      await until(
        async () =>
          JSON.stringify(
            await rpc("chat.history", { sessionKey: key, agentId: RETENTION_AGENT_ID, limit: 200 }),
          ).includes(marker),
        "held provider completes normally",
      );
      const history = await rpc<{ messages: unknown[] }>("chat.history", {
        sessionKey: key,
        agentId: RETENTION_AGENT_ID,
        limit: 200,
      });
      assert.equal(
        history.messages.filter((entry) => JSON.stringify(entry).includes(message)).length,
        1,
      );
      acknowledgedMessages.push({ key, text: message });
      return {
        provider: "maintained synthetic HTTP fixture",
        admittedRequestObserved: true,
        cleanupPreservedIdentity: held.sessionId,
        dedupe: true,
      };
    });
    await phase("control-ui", () =>
      proveRetentionUi({
        instance,
        output,
        row: rows.find((row) => row.key === retentionSessionKey("dashboard:fresh-000000"))!,
        rpc,
        marker,
        smoke: profile === "smoke",
        registerCleanup: params.registerCleanup,
        browserExecutable: params.browserExecutable,
        expectedBuildId: params.expectedBuildId,
      }),
    );
    acknowledgedMessages.push({
      key: retentionSessionKey("dashboard:fresh-000000"),
      text: "Please confirm this restored synthetic retention conversation.",
    });
    await phase("graceful-restart", async () => {
      const priorBoot = bootIds.at(-1);
      const child = instance.child;
      assert(child);
      pauseSampling();
      await disconnect();
      await instance.stopGateway();
      assert.notEqual(child.signalCode, "SIGKILL", "graceful shutdown escalated to kill");
      await startGateway();
      assert.notEqual(bootIds.at(-1), priorBoot);
      await verifyMessages();
      assert.deepEqual(verifySeed(), seedBefore);
      await sample();
      return {
        previousBoot: priorBoot,
        nextBoot: bootIds.at(-1),
        exitCode: child.exitCode,
        signal: child.signalCode,
      };
    });
    await phase("abrupt-crash", async () => {
      const key = liveKeys[0]!;
      await inject(key, "Acknowledged message immediately before abrupt crash.");
      const beforeIndex = receipts.length;
      const writes = Array.from(
        { length: Math.min(63, RETENTION_PROFILES[profile].clients - 1) },
        (_, i) => inject(key, `Crash window message ${i}.`),
      );
      const cleanupRequest = rpc("sessions.cleanup", { agent: RETENTION_AGENT_ID, enforce: true });
      const settledRequests = Promise.allSettled([...writes, cleanupRequest]);
      // Request onSent records actual socket issuance. Do not claim a DB transaction hook.
      await until(
        async () => receipts.slice(beforeIndex).every((receipt) => receipt.sent),
        "crash-burst socket issuance",
        5_000,
      );
      assert(
        receipts.slice(beforeIndex).some((receipt) => receipt.outcome === "pending"),
        "no in-flight requests at crash; this run does not prove the requested window",
      );
      const child = instance.child;
      assert(child);
      pauseSampling();
      terminateManagedChild(child, "SIGKILL");
      const outcomes = await settledRequests;
      assert(
        receipts
          .slice(beforeIndex)
          .every((receipt) => receipt.outcome === "acknowledged" || receipt.outcome === "unknown"),
        "crash burst received a typed rejection; inspect receipts before attributing it to crash loss",
      );
      await disconnect();
      await instance.stopGateway();
      assert.equal(child.signalCode, "SIGKILL");
      const priorBoot = bootIds.at(-1);
      closeOpenClawAgentDatabasesForTest();
      await startGateway();
      assert.notEqual(bootIds.at(-1), priorBoot);
      await verifyMessages();
      assert.deepEqual(verifySeed(), seedBefore);
      await rpc("sessions.cleanup", { agent: RETENTION_AGENT_ID, enforce: true });
      const recovered = await rpc<{ messages: unknown[] }>("chat.history", {
        sessionKey: key,
        agentId: RETENTION_AGENT_ID,
        limit: 200,
      });
      const crashMessages = recovered.messages.map((message) => JSON.stringify(message));
      let recoveredCrashWrites = 0;
      for (let i = 0; i < writes.length; i++) {
        const copies = crashMessages.filter((message) =>
          message.includes(`Crash window message ${i}.`),
        ).length;
        assert(copies <= 1, `duplicate crash write ${i}`);
        recoveredCrashWrites += copies;
      }
      const restoreKey = retentionSessionKey("dashboard:fresh-000001");
      const restoreId = initial.get(restoreKey);
      assert(restoreId);
      await rpc("sessions.patch", {
        key: restoreKey,
        expectedSessionId: restoreId,
        archived: false,
      });
      await inject(
        retentionSessionKey("dashboard:fresh-000001"),
        "Acknowledged restore continuation after crash recovery.",
      );
      await verifyMessages();
      await sample();
      crash = {
        attempts: outcomes.length,
        acknowledged: receipts
          .slice(beforeIndex, beforeIndex + outcomes.length)
          .filter((receipt) => receipt.outcome === "acknowledged").length,
        transportUnknown: receipts
          .slice(beforeIndex, beforeIndex + outcomes.length)
          .filter((receipt) => receipt.outcome === "unknown").length,
        typedRejected: 0,
        recoveredCrashWrites,
        absentCrashWrites: writes.length - recoveredCrashWrites,
        priorBoot,
        recoveredBoot: bootIds.at(-1),
        integrity: checkRetentionIntegrity(store),
      };
      return crash;
    });
    const final = await roster();
    for (const row of rows.filter((candidate) => !candidate.disposable)) {
      assert.equal(final.get(row.key), row.entry.sessionId);
    }
    for (const key of liveKeys) {
      assert.equal(final.get(key), liveIdentities.get(key));
    }
    assert.equal(final.size, initial.size + liveKeys.length);
    assert.deepEqual(verifySeed(), seedBefore);
    const beforeDisk = readRetentionSnapshot(store);
    const diskProof = await phase("built-disk-pressure", async () => {
      pauseSampling();
      await disconnect();
      await instance.stopGateway();
      assert(!instance.child, "disk fixture seeding requires a stopped Gateway");
      const prepared = await prepareRetentionDiskFixtures(store);
      const diskMaintenance = {
        // pruneAfter is positive-only: put its cutoff beyond every synthetic fixture.
        mode: "enforce",
        pruneAfter: "36500d",
        archiveDashboardAfter: false,
        preserveRecent: false,
        maxEntries: prepared.allBefore.nodes + 64,
        maxDiskBytes: 1,
        highWaterBytes: 1,
      };
      assert(
        SessionSchema.safeParse({ maintenance: diskMaintenance }).success,
        "invalid disk-stage config",
      );
      config.session.maintenance = diskMaintenance;
      await instance.state.writeConfig(config);
      closeOpenClawAgentDatabasesForTest();
      await startGateway();
      const diskResult = await proveRetentionDiskScenario(store, prepared, {
        execution: "built-gateway-rpc",
        cleanup: async () => {
          const result = await rpc("sessions.cleanup", {
            agent: RETENTION_AGENT_ID,
            enforce: true,
          });
          assert.equal(result.dryRun, false);
          assert.equal(result.mode, "enforce");
          return result;
        },
        deleteExplicit: async () => {
          const result = await rpc("sessions.delete", {
            key: prepared.explicit.key,
            agentId: RETENTION_AGENT_ID,
            expectedSessionId: prepared.explicit.entry.sessionId,
            deleteTranscript: true,
            archivedOnly: true,
          });
          assert.equal(result.ok, true);
          assert.equal(result.deleted, true);
          return result;
        },
      });
      await verifyMessages();
      return { maintenance: diskMaintenance, startupMayHaveKickedBudget: true, ...diskResult };
    });
    params.assertBuildUnchanged();
    return {
      execution: "built-gateway-rpc",
      initialNodes: initial.size,
      beforeDiskNodes: final.size,
      seedMessages: seedBefore,
      beforeDisk,
      final: readRetentionSnapshot(store),
      crash,
      diskProof,
      metrics: {
        rpcMs: summarizeRetentionSamples(latencies),
        healthMs: summarizeRetentionSamples(healthLatencies),
        gatewayRssBytes: summarizeRetentionSamples(rss),
      },
    };
  } finally {
    setHold(false);
    pauseSampling();
    await stopSampler();
    const stopped = await Promise.allSettled([
      disconnect(),
      instance.stopGateway(),
      stopProvider(),
    ]);
    fs.writeFileSync(path.join(output, "receipts.json"), JSON.stringify(receipts, null, 2) + "\n");
    fs.writeFileSync(
      path.join(output, "live-metrics.json"),
      JSON.stringify(
        {
          execution: "built-gateway-rpc",
          rpcMs: summarizeRetentionSamples(latencies),
          byMethod: Object.fromEntries(
            [...new Set(receipts.map((receipt) => receipt.method))].toSorted().map((method) => {
              const attempts = receipts.filter((receipt) => receipt.method === method);
              const successful = attempts.filter((receipt) => receipt.outcome === "acknowledged");
              return [
                method,
                {
                  attempts: attempts.length,
                  acknowledged: successful.length,
                  latencyMs: summarizeRetentionSamples(
                    attempts.flatMap((receipt) =>
                      receipt.elapsedMs === undefined ? [] : [receipt.elapsedMs],
                    ),
                  ),
                  acknowledgedLatencyMs: summarizeRetentionSamples(
                    successful.flatMap((receipt) =>
                      receipt.elapsedMs === undefined ? [] : [receipt.elapsedMs],
                    ),
                  ),
                  rateLimited: attempts.filter((receipt) => receipt.outcome === "rate-limited")
                    .length,
                },
              ];
            }),
          ),
          sampler: {
            intervalMs: 2_000,
            maxSamples: 2_000,
            interruptedSamples,
            sampleFailureCount,
            failureSamples: sampleFailures,
            observedPhases: [...new Set(resourceSamples.map((observation) => observation.phase))],
          },
          healthMs: summarizeRetentionSamples(healthLatencies),
          gatewayRssBytes: summarizeRetentionSamples(rss),
          receiptCounts: {
            total: receipts.length,
            acknowledged: receipts.filter((r) => r.outcome === "acknowledged").length,
            unknown: receipts.filter((r) => r.outcome === "unknown").length,
            rejected: receipts.filter((r) => r.outcome === "rejected").length,
            rateLimited: receipts.filter((r) => r.outcome === "rate-limited").length,
            pending: receipts.filter((r) => r.outcome === "pending").length,
          },
          acknowledgedMessages: acknowledgedMessages.length,
        },
        null,
        2,
      ) + "\n",
    );
    fs.writeFileSync(
      path.join(output, "resource-samples.json"),
      JSON.stringify(resourceSamples) + "\n",
    );
    assert.equal(
      sampleFailureCount,
      0,
      "Gateway health/RSS sampling failed; see live-metrics.json",
    );
    assert.deepEqual(
      stopped.filter((result) => result.status === "rejected"),
      [],
      "live teardown failed",
    );
  }
}
