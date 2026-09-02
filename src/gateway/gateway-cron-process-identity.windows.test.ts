import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  createOpenClawTestInstance,
  writeGatewayProcessDiagnostic,
} from "../../test/helpers/openclaw-test-instance.js";
import { connectGatewayClient, disconnectGatewayClient } from "./test-helpers.e2e.js";

describe.skipIf(process.platform !== "win32")("Windows cron process identity", () => {
  it(
    "completes a scheduled Gateway job with a durable owner identity",
    { timeout: 90_000 },
    async () => {
      const instance = await createOpenClawTestInstance({
        name: `windows-cron-process-identity-${process.pid}`,
        env: {
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENCLAW_SKIP_CRON: undefined,
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        },
      });
      const diagnose = (phase: string, error?: unknown) => {
        const detail = error instanceof Error ? (error.stack ?? error.message) : typeof error;
        writeGatewayProcessDiagnostic(phase, {
          pid: instance.child?.pid,
          error:
            error === undefined
              ? undefined
              : detail
                  .replaceAll(instance.gatewayToken, "[redacted]")
                  .replaceAll(instance.hookToken, "[redacted]"),
        });
      };
      let jobId: string | undefined;
      let client: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
      try {
        await instance.startGateway();
        client = await connectGatewayClient({
          url: instance.url,
          token: instance.gatewayToken,
          requestTimeoutMs: 30_000,
        });
        const job = await client.request<{ id: string }>("cron.add", {
          name: "Windows process identity proof",
          enabled: true,
          deleteAfterRun: false,
          schedule: { kind: "at", at: new Date(Date.now() + 2_000).toISOString() },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "Windows process identity proof fired" },
        });
        jobId = job.id;

        let terminal: Record<string, unknown> | undefined;
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          const history = await client.request<{ entries: Array<Record<string, unknown>> }>(
            "cron.runs",
            { id: job.id, limit: 1 },
          );
          terminal = history.entries[0];
          if (terminal && terminal.status !== "running") {
            break;
          }
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 250);
          });
        }

        const database = new DatabaseSync(
          path.join(instance.stateDir, "state", "openclaw.sqlite"),
          { readOnly: true },
        );
        const receipt = database
          .prepare(
            `SELECT status, owner_pid AS ownerPid, owner_start_time AS ownerStartTime,
                    finished_at_ms AS finishedAtMs
               FROM cron_run_receipts WHERE job_id = ?
               ORDER BY started_at_ms DESC LIMIT 1`,
          )
          .get(job.id);
        database.close();

        expect(terminal).toMatchObject({ status: "ok", completionStatus: "succeeded" });
        expect(receipt).toMatchObject({
          status: "ok",
          ownerPid: expect.any(Number),
          ownerStartTime: expect.any(Number),
          finishedAtMs: expect.any(Number),
        });
        diagnose("cron-primary-passed");
      } catch (error) {
        // Record the primary failure before finally can replace it with a teardown error.
        diagnose("cron-primary-failed", error);
        throw error;
      } finally {
        if (jobId && client) {
          await client.request("cron.remove", { id: jobId }).catch((error: unknown) => {
            diagnose("cron-remove-failed", error);
          });
        }
        if (client) {
          await disconnectGatewayClient(client).catch((error: unknown) => {
            diagnose("cron-disconnect-failed", error);
          });
        }
        diagnose("cron-cleanup-start");
        try {
          await instance.cleanup();
          diagnose("cron-cleanup-passed");
        } catch (error) {
          diagnose("cron-cleanup-failed", error);
          throw error;
        }
      }
    },
  );
});
