import { once } from "node:events";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { WebSocket, WebSocketServer } from "ws";
import type {
  QuestionRequestParams,
  QuestionResolveParams,
  RequestFrame,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { QuestionManager, QuestionManagerError } from "../../gateway/question-manager.js";
import { createDeferredCore as deferred, type Deferred } from "../../shared/deferred.js";
import { withEnvAsync } from "../../test-utils/env.js";
// Collect the real transport before test deadlines; production still imports it lazily.
export { callGatewayTool } from "../tools/gateway.js";

// Only the peer is synthetic: question claims use the production tool, one-shot
// call, client, and WebSocket send, with real QuestionManager terminal state.
export async function withQuestionGateway(
  run: (fixture: {
    manager: QuestionManager;
    backingRun: AbortController;
    requests: RequestFrame[];
    waitStarted: Promise<void>;
    holdNextHello: () => { entered: Promise<void>; release: () => void };
    onResolved: (callback: () => void) => void;
    holdRegistration: () => { entered: Promise<void>; release: () => void };
  }) => Promise<void>,
) {
  await withEnvAsync(
    {
      OPENCLAW_GATEWAY_URL: undefined,
      OPENCLAW_GATEWAY_PORT: undefined,
      OPENCLAW_GATEWAY_TOKEN: undefined,
      OPENCLAW_GATEWAY_PASSWORD: undefined,
    },
    async () => {
      const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      await once(server, "listening");
      const address = server.address();
      if (typeof address === "string" || address === null || address.port === 18789) {
        throw new Error("expected an isolated question Gateway port");
      }
      setRuntimeConfigSnapshot({
        gateway: {
          mode: "local",
          port: address.port,
          auth: { mode: "token", token: "synthetic-question-test" },
        },
      });
      const manager = new QuestionManager();
      const backingRun = new AbortController();
      const requests: RequestFrame[] = [];
      const waitStarted = deferred();
      let nextHello: { entered: Deferred; release: Deferred } | undefined;
      let onResolved = () => {};
      let registrationHold: { entered: Deferred; release: Deferred } | undefined;
      server.on("connection", (socket) => {
        socket.send(
          JSON.stringify({
            type: "event",
            event: "connect.challenge",
            payload: { nonce: "synthetic-question-nonce", ts: Date.now() },
          }),
        );
        socket.on("message", (raw) => {
          const frame = JSON.parse(rawDataToString(raw)) as RequestFrame;
          const respond = (payload: unknown) => {
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload }));
            }
          };
          if (frame.method === "connect") {
            const hold = nextHello;
            nextHello = undefined;
            hold?.entered.resolve();
            void (hold?.release.promise ?? Promise.resolve()).then(() =>
              respond({ type: "hello-ok" }),
            );
            return;
          }
          requests.push(frame);
          if (frame.method === "question.request") {
            const request = frame.params as QuestionRequestParams;
            const record = manager.request({
              ...request,
              timeoutMs: request.timeoutMs ?? 60_000,
              isRequesterActive: () => !backingRun.signal.aborted,
            });
            registrationHold?.entered.resolve();
            void (registrationHold?.release.promise ?? Promise.resolve()).then(() =>
              respond(record),
            );
          } else if (frame.method === "question.waitAnswer") {
            const request = frame.params as { id: string };
            void manager.waitAnswer(request.id).then(respond);
            waitStarted.resolve();
          } else if (frame.method === "question.resolve") {
            const request = frame.params as QuestionResolveParams;
            try {
              const result =
                "cancel" in request
                  ? manager.cancel(request.id, request.resolvedBy)
                  : manager.resolve(request.id, request.answers, request.resolvedBy);
              onResolved();
              respond(result);
            } catch (error) {
              if (!(error instanceof QuestionManagerError)) {
                throw error;
              }
              socket.send(
                JSON.stringify({
                  type: "res",
                  id: frame.id,
                  ok: false,
                  error: {
                    code: "INVALID_REQUEST",
                    message: error.message,
                    details: { reason: error.code },
                  },
                }),
              );
            }
          } else if (frame.method === "question.list") {
            respond({ questions: manager.list() });
          } else {
            throw new Error(`unexpected question fixture RPC: ${frame.method}`);
          }
        });
      });
      try {
        await run({
          manager,
          backingRun,
          requests,
          waitStarted: waitStarted.promise,
          holdNextHello: () => {
            const hold = { entered: deferred(), release: deferred() };
            nextHello = hold;
            return { entered: hold.entered.promise, release: () => hold.release.resolve() };
          },
          holdRegistration: () => {
            const hold = { entered: deferred(), release: deferred() };
            registrationHold = hold;
            return { entered: hold.entered.promise, release: () => hold.release.resolve() };
          },
          onResolved: (callback) => {
            onResolved = callback;
          },
        });
      } finally {
        manager.reset();
        for (const socket of server.clients) {
          socket.terminate();
        }
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
        resetConfigRuntimeState();
      }
    },
  );
}
