import { describe, expect, it, vi } from "vitest";
import type { QuestionWaitAnswerResult } from "../../../packages/gateway-protocol/src/index.js";
import {
  claimEmbeddedPendingUserInputAnswer,
  steerActiveSessionWithOptionalDeliveryWait,
} from "../../agents/embedded-agent-runner/run/attempt-queue-message.js";
import type { AgentHarnessQuestionGatewayCall } from "../../agents/harness/gateway-question-dispatch.js";
import { registerPendingAgentQuestion } from "../../agents/harness/gateway-question.js";
import {
  callGatewayTool,
  withQuestionGateway,
} from "../../agents/harness/gateway-question.test-support.js";
import { runActiveReplySteer } from "./agent-runner-steer-adoption.js";
import { clearSessionQueues, enqueueFollowupRun, type FollowupRun } from "./queue.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import { getExistingFollowupQueue } from "./queue/state.js";
import type { ReplyOperationRunState } from "./reply-operation-run-state.js";
import { createReplyOperation, replyRunRegistry } from "./reply-run-registry.js";
import { createMockTypingController } from "./test-helpers.js";
import { createTypingSignaler } from "./typing-mode.js";

const text = "candidate committed answer";
const fingerprint = "question-test-authority";
type QueueOptions = Parameters<typeof steerActiveSessionWithOptionalDeliveryWait>[2];

// A V1 translator built against v2026.8.2's closed request schemas. The real
// transport/manager still commits and answers; only new receipt fields are absent.
const legacyGateway: AgentHarnessQuestionGatewayCall = (method, options, params, extra) => {
  const input = params as Record<string, unknown>;
  const forwarded =
    method === "question.resolve"
      ? { id: input.id, answers: input.answers, resolvedBy: input.resolvedBy }
      : method === "question.waitAnswer"
        ? { id: input.id, timeoutMs: input.timeoutMs }
        : params;
  return callGatewayTool(method, options, forwarded, extra);
};

describe("question response custody through reply adoption", () => {
  it.each([
    "delayed-receipt",
    "failed-waiter",
    "legacy-receipt",
    "v1-negative",
    "closed-adoption",
  ] as const)("does not replay or abort independent work after %s", async (mode) => {
    const key = `agent:main:question-recovery-${mode}`;
    const id = `ask_recovery_${mode}`;
    await withQuestionGateway(async (fixture) => {
      const hold = fixture.holdWaitAnswerResponse();
      const call = mode === "legacy-receipt" ? legacyGateway : callGatewayTool;
      const questions = [
        { id: "answer", header: "Answer", question: "Continue?", isOther: true, options: [] },
      ];
      const claim = registerPendingAgentQuestion({
        questionId: id,
        sessionKey: key,
        questions,
        gatewayCall: mode === "legacy-receipt" ? legacyGateway : undefined,
      });
      const registration = call(
        "question.request",
        {},
        {
          id,
          sessionKey: key,
          timeoutMs: 60_000,
          questions: questions.map((question) => ({
            questionId: question.id,
            header: question.header,
            question: question.question,
            isOther: question.isOther,
            options: question.options,
          })),
        },
      );
      claim.attachRegistration(registration);
      await registration;
      const answer = call(
        "question.waitAnswer",
        { timeoutMs: 70_000 },
        { id, timeoutMs: 60_000, includeResolutionId: true },
      ) as Promise<QuestionWaitAnswerResult>;
      const answerOutcome = answer.catch(() => undefined);
      claim.setAnswer(answer);
      await fixture.waitStarted;
      const run = createQueueTestRun({ prompt: text, messageId: `recovery-${mode}` });
      const abandoned = vi.fn();
      const settled = vi.fn();
      run.turnAdoptionLifecycle = {
        onAdopted: async () => {
          if (mode === "closed-adoption") {
            throw new Error("source adoption closed after dispatch");
          }
        },
        onAbandoned: abandoned,
        onSettled: settled,
      };
      const operation = createReplyOperation({
        sessionKey: key,
        sessionId: run.run.sessionId,
        resetTriggered: false,
      });
      operation.bindToolAuthoritySnapshot({
        fingerprint: () => fingerprint,
        project: () => fingerprint,
      });
      const cancel = vi.fn(() => fixture.backingRun.abort());
      const nativeSteer = vi.fn(async () => {
        throw new Error("unexpected ordinary steering of an answered question");
      });
      const subscribe = vi.fn(() => () => {});
      const queue = async (
        message: string,
        options: QueueOptions,
        assertCurrent: () => void,
        kind: "run" | "source-bound",
      ) => {
        try {
          return await steerActiveSessionWithOptionalDeliveryWait(
            { steer: nativeSteer, subscribe },
            message,
            options,
            key,
            () => {
              assertCurrent();
              return true;
            },
            { kind, assertCurrent },
          );
        } catch (error) {
          if (mode === "v1-negative") {
            options?.onQueueAccepted?.(false);
          }
          throw error;
        }
      };
      const assertCurrent = () => {
        expect(replyRunRegistry.get(key)).toBe(operation);
        operation.abortSignal.throwIfAborted();
      };
      operation.attachBackend({
        kind: "embedded",
        runId: "accepted-backing-work",
        toolAuthorityFingerprint: fingerprint,
        cancel,
        ...(mode === "v1-negative"
          ? {
              messageInjection: {
                isAvailable: () => true,
                queueMessage: (message, options) => queue(message, options, assertCurrent, "run"),
              },
            }
          : {
              messageInjectionV2: {
                version: 2 as const,
                isAvailable: () => true,
                queueMessage: queue,
                claimPendingUserInputAnswer: (message, options, current, kind) =>
                  claimEmbeddedPendingUserInputAnswer(
                    message,
                    options,
                    key,
                    () => {
                      current();
                      return true;
                    },
                    { kind, assertCurrent: current },
                  ),
              },
            }),
      });
      operation.setPhase("running");
      fixture.dropNextResolveResponse();
      const state: ReplyOperationRunState = {};
      const followup = vi.fn(async (_run: FollowupRun) => {});
      const typing = createMockTypingController();
      let done = false;
      const adoption = runActiveReplySteer({
        followupRun: run,
        opts: undefined,
        providedReplyOperation: operation,
        queueKey: key,
        releaseAdmissionTicket: () => {},
        replyOperationRunState: state,
        resolvedQueue: { mode: "steer", debounceMs: 0 },
        restartRecoverySourceTurnId: run.messageId,
        runFollowup: followup,
        sessionCtx: {},
        sessionKey: key,
        touchActiveSessionEntry: async () => {},
        typing,
        typingSignals: createTypingSignaler({ typing, mode: "never", isHeartbeat: false }),
        toolAuthorityFingerprint: mode === "legacy-receipt" ? "incoming-authority" : fingerprint,
        ...(mode === "legacy-receipt" ? { pendingInputAuthorityFingerprint: fingerprint } : {}),
      }).finally(() => {
        done = true;
      });
      void adoption.catch(() => undefined);
      try {
        await Promise.race([
          hold.entered,
          adoption.then(() => {
            throw new Error("adoption completed before the committed waiter gate");
          }),
        ]);
        const resolves = fixture.requests.filter(
          (request) => request.method === "question.resolve",
        );
        const wait = fixture.requests.find((request) => request.method === "question.waitAnswer");
        expect(resolves).toHaveLength(1);
        const receipt = await fixture.manager.waitAnswer(id, undefined, true);
        expect(receipt).toMatchObject({
          status: "answered",
          answers: { answers: { answer: [text] } },
        });
        if (mode === "legacy-receipt") {
          expect(resolves[0]?.params).not.toHaveProperty("resolutionId");
          expect(wait?.params).not.toHaveProperty("includeResolutionId");
          expect(receipt).not.toHaveProperty("resolutionId");
        } else {
          const resolveParams = resolves[0]?.params as { resolutionId?: string } | undefined;
          const resolutionId = resolveParams?.resolutionId;
          expect(resolutionId).toMatch(/^[a-f0-9]{32}$/);
          expect(receipt).toMatchObject({ resolutionId });
          expect(wait?.params).toMatchObject({ includeResolutionId: true });
        }
        expect(operation.phase).toBe("running");
        expect(operation.result).toBeNull();
        expect(cancel).not.toHaveBeenCalled();
        if (mode === "delayed-receipt") {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 1_200);
          });
          expect(done).toBe(false);
          expect(claim.isResolving()).toBe(true);
          expect(followup).not.toHaveBeenCalled();
          expect(cancel).not.toHaveBeenCalled();
        }
        if (mode === "delayed-receipt" || mode === "legacy-receipt") {
          hold.release();
        } else {
          hold.fail();
        }
        const result = await adoption;
        await answerOutcome;
        // Observe drainage without waiting for the replay a correct owner forbids.
        await vi.waitFor(() => expect(getExistingFollowupQueue(key)).toBeUndefined());
        expect.soft(followup).not.toHaveBeenCalled();
        expect.soft(cancel).not.toHaveBeenCalled();
        expect.soft(operation.abortSignal.aborted).toBe(false);
        expect.soft(fixture.backingRun.signal.aborted).toBe(false);
        expect.soft(abandoned).not.toHaveBeenCalled();
        expect.soft(settled).toHaveBeenCalledOnce();
        expect(nativeSteer).not.toHaveBeenCalled();
        if (mode === "delayed-receipt") {
          expect(result).toBe("handled");
          expect(state.admission).toEqual({ status: "accepted", mode: "steer" });
        } else {
          expect.soft(result).toMatchObject({
            isError: true,
            text: expect.stringContaining("confirmation was lost"),
          });
          expect
            .soft(state.admission)
            .toEqual({ status: "skipped", reason: "question-response-indeterminate" });
        }
        expect
          .soft(
            enqueueFollowupRun(key, { ...run }, { mode: "followup", debounceMs: 0 }, "message-id"),
          )
          .toBe(false);
      } finally {
        hold.release();
        await answerOutcome;
        await adoption.catch(() => undefined);
        claim.dispose();
        clearSessionQueues([key]);
        operation.complete();
      }
    });
    expect(replyRunRegistry.get(key)).toBeUndefined();
    expect(getExistingFollowupQueue(key)).toBeUndefined();
  });
});
