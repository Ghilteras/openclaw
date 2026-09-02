import { randomBytes } from "node:crypto";
import type {
  QuestionAnswers,
  QuestionRequestQuestion,
  QuestionWaitAnswerResult,
} from "../../../packages/gateway-protocol/src/schema/questions.js";
import { resolveGlobalMap } from "../../shared/global-singleton.js";
import type { EmbeddedRunAttemptParams } from "../embedded-agent-runner/run/types.js";
import type { GatewayQuestionCall } from "../tools/gateway-question-lifecycle.js";
import {
  QuestionDispatchRefusedError,
  resolveAgentQuestionGatewayCall,
  type AgentHarnessQuestionGatewayCall,
  type AgentQuestionDispatcher,
} from "./gateway-question-dispatch.js";
import {
  buildAgentHarnessUserInputAnswers,
  deliverAgentHarnessQuestionPrompt,
  deliverAgentHarnessUserInputPrompt,
  type AgentHarnessUserInputPromptOptions,
  type AgentHarnessUserInputQuestion,
} from "./user-input-bridge.js";

const QUESTION_RPC_GRACE_MS = 10_000;
const TERMINAL_QUESTION_ERROR_REASONS = new Set([
  "QUESTION_ALREADY_TERMINAL",
  "QUESTION_NOT_FOUND",
]);

type PendingAgentGatewayQuestion = {
  kind: "gateway";
  questionId: string;
  sessionKey: string;
  questions: readonly AgentHarnessUserInputQuestion[];
  gatewayCall: GatewayQuestionCall;
  supportsSourceBound: boolean;
  registration: Promise<unknown>;
  rejectRegistration: (error: unknown) => void;
  attachRegistration: (promise: Promise<unknown>) => void;
  answer?: Promise<QuestionWaitAnswerResult>;
  resolution?: Promise<void>;
  cancelRequested: boolean;
  onCancel?: (resolvedBy: string) => void;
  resolving: boolean;
};

type PendingAgentSecretInput = {
  kind: "secret";
  sessionKey: string;
  resolving: boolean;
  settle: (text?: string) => boolean;
};

type PendingAgentQuestion = PendingAgentGatewayQuestion | PendingAgentSecretInput;

const pendingAgentQuestions = resolveGlobalMap<string, PendingAgentQuestion>(
  Symbol.for("openclaw.pendingAgentQuestions"),
  (questions) => {
    const error = new Error("gateway lifecycle ended before question registration completed");
    for (const state of questions.values()) {
      if (state.kind === "gateway") {
        state.rejectRegistration(error);
      } else {
        state.settle();
      }
    }
    questions.clear();
  },
);

function readQuestionErrorReason(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const requestError = error as { details?: unknown; name?: unknown };
  if (requestError.name !== "GatewayClientRequestError") {
    return undefined;
  }
  const details = requestError.details;
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return undefined;
  }
  const reason = (details as { reason?: unknown }).reason;
  return typeof reason === "string" ? reason : undefined;
}

function isTerminalAgentQuestionError(error: unknown): boolean {
  const reason = readQuestionErrorReason(error);
  return reason !== undefined && TERMINAL_QUESTION_ERROR_REASONS.has(reason);
}

async function observeQuestionAnswer(
  answer: Promise<QuestionWaitAnswerResult> | undefined,
): Promise<Extract<QuestionWaitAnswerResult, { status: "answered" }> | undefined> {
  if (!answer) {
    return undefined;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      answer,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), 1_000);
        timer.unref?.();
      }),
    ]);
    return result?.status === "answered" ? result : undefined;
  } catch {
    return undefined;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

type QuestionInputAuthority = { kind: "run" | "source-bound"; assertCurrent: () => void };

/** One reservation owns both dispatch refusal and the prompt's release notification. */
function reserveQuestionInput(
  state: PendingAgentGatewayQuestion,
  authority?: QuestionInputAuthority,
) {
  if (authority?.kind === "source-bound" && !state.supportsSourceBound) {
    throw new QuestionDispatchRefusedError(
      "source-bound question input requires the default or a version 2 dispatcher",
    );
  }
  let refused = false;
  const assertCurrent = () => {
    try {
      authority?.assertCurrent();
      if (pendingAgentQuestions.get(state.sessionKey) !== state) {
        throw new Error("pending question is no longer current");
      }
    } catch (error) {
      // A known pre-dispatch refusal cannot be recovered as someone else's answer.
      refused = true;
      throw new QuestionDispatchRefusedError(
        error instanceof Error ? error.message : "question dispatch authority refused",
        { cause: error },
      );
    }
  };
  assertCurrent();
  state.resolving = true;
  let finish!: () => void;
  state.resolution = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return {
    assertCurrent,
    wasRefused: () => refused,
    extra: state.supportsSourceBound
      ? {
          dispatchAuthority: {
            version: 2 as const,
            kind: authority?.kind ?? ("run" as const),
            assertCurrent,
          },
        }
      : undefined,
    finish: (consumed: boolean) => {
      state.resolving = consumed;
      if (!consumed) {
        state.cancelRequested = false;
      }
      state.resolution = undefined;
      finish();
    },
  };
}

/** Registers one gateway question as the next plain-text claim target for its session. */
export function registerPendingAgentQuestion(params: {
  questionId: string;
  sessionKey: string;
  questions: readonly AgentHarnessUserInputQuestion[];
  gatewayCall?: AgentHarnessQuestionGatewayCall | AgentQuestionDispatcher;
  answer?: Promise<QuestionWaitAnswerResult>;
  onCancel?: (resolvedBy: string) => void;
}): {
  attachRegistration: (promise: Promise<unknown>) => void;
  setAnswer: (answer: Promise<QuestionWaitAnswerResult>) => void;
  waitForResolution: () => Promise<boolean>;
  isCancellationRequested: () => boolean;
  isResolving: () => boolean;
  dispose: () => void;
} {
  const sessionKey = params.sessionKey.trim();
  const existing = pendingAgentQuestions.get(sessionKey);
  if (existing) {
    throw new Error(`session already has a pending agent input request: ${sessionKey}`);
  }
  let resolveRegistration!: (value: unknown) => void;
  let rejectRegistration!: (error: unknown) => void;
  const registration = new Promise<unknown>((resolve, reject) => {
    resolveRegistration = resolve;
    rejectRegistration = reject;
  });
  void registration.catch(() => undefined);
  let registrationAttached = false;
  const state: PendingAgentQuestion = {
    kind: "gateway",
    ...params,
    sessionKey,
    gatewayCall: resolveAgentQuestionGatewayCall(params.gatewayCall),
    supportsSourceBound: typeof params.gatewayCall !== "function",
    registration,
    rejectRegistration,
    attachRegistration: (promise) => {
      if (registrationAttached) {
        throw new Error("gateway question registration already attached");
      }
      registrationAttached = true;
      promise.then(resolveRegistration, rejectRegistration);
    },
    cancelRequested: false,
    resolving: false,
  };
  pendingAgentQuestions.set(sessionKey, state);
  return {
    attachRegistration: state.attachRegistration,
    setAnswer: (answer) => {
      state.answer = answer;
    },
    waitForResolution: async () => {
      // A refused claim can hand off while waiters wake. Only report consumption
      // after that reservation settles; callers recheck for later handoffs.
      while (state.resolution) {
        await state.resolution;
      }
      return state.cancelRequested || state.resolving;
    },
    isCancellationRequested: () => state.cancelRequested,
    isResolving: () => state.cancelRequested || state.resolving,
    dispose: () => {
      if (pendingAgentQuestions.get(sessionKey) === state) {
        pendingAgentQuestions.delete(sessionKey);
      }
      if (!registrationAttached) {
        rejectRegistration(new Error("gateway question registration disposed before attachment"));
      }
    },
  };
}

/** Claims the next queued plain-text message for the session's gateway question. */
export async function claimPendingAgentQuestionAnswer(params: {
  sessionKey?: string;
  text: string;
  persist?: () => Promise<void>;
  authority?: QuestionInputAuthority;
}): Promise<boolean> {
  params.authority?.assertCurrent();
  const sessionKey = params.sessionKey?.trim();
  const state = sessionKey ? pendingAgentQuestions.get(sessionKey) : undefined;
  if (!state || state.resolving || (state.kind === "gateway" && state.cancelRequested)) {
    return false;
  }
  if (state.kind === "secret") {
    state.resolving = true;
    return state.settle(params.text);
  }
  const reservation = reserveQuestionInput(state, params.authority);
  let consumed = false;
  let terminal = false;
  try {
    if (!state.answer) {
      // Both registration owners attach the answer before this continuation.
      // Failed registration leaves this input available for ordinary steering.
      try {
        await state.registration;
      } catch {
        return false;
      }
      if (pendingAgentQuestions.get(state.sessionKey) !== state) {
        return false;
      }
    }
    reservation.assertCurrent();
    await params.persist?.();
    reservation.assertCurrent();
    const parsed = buildAgentHarnessUserInputAnswers(state.questions, params.text);
    const answers: QuestionAnswers = {
      answers: Object.fromEntries(
        Object.entries(parsed.answers).map(([id, answer]) => [id, answer.answers]),
      ),
    };
    const resolutionId = randomBytes(16).toString("hex");
    try {
      await state.gatewayCall(
        "question.resolve",
        {},
        { id: state.questionId, answers, resolvedBy: "plain-text", resolutionId },
        ...(reservation.extra ? ([reservation.extra] as const) : []),
      );
      consumed = true;
    } catch (error) {
      if (reservation.wasRefused()) {
        throw error;
      }
      if (isTerminalAgentQuestionError(error)) {
        terminal = true;
        return false;
      }
      // The shared waiter can be answered by another actor, even with identical
      // text. Only this submission's owner-stamped receipt prevents lost-ACK replay.
      const answer = await observeQuestionAnswer(state.answer);
      if (!answer) {
        throw error;
      }
      terminal = true;
      consumed = answer.resolutionId === resolutionId;
    }
    return consumed;
  } finally {
    reservation.finish(consumed || terminal);
  }
}

/** Cancels a question before the same inbound message takes another route. */
export async function cancelPendingAgentQuestionForSession(params: {
  sessionKey?: string;
  resolvedBy: string;
  authority?: QuestionInputAuthority;
}): Promise<boolean> {
  params.authority?.assertCurrent();
  const sessionKey = params.sessionKey?.trim();
  const state = sessionKey ? pendingAgentQuestions.get(sessionKey) : undefined;
  if (!state || state.resolving) {
    return false;
  }
  if (state.kind === "secret") {
    state.resolving = true;
    return state.settle();
  }
  const reservation = reserveQuestionInput(state, params.authority);
  const sourceBound = params.authority?.kind === "source-bound";
  let consumed = false;
  // Shipped ordinary early cancellation is replayed by the registration owner.
  // Source-bound cancellation instead waits here, retaining its exact assertion.
  state.cancelRequested = !sourceBound;
  try {
    if (sourceBound && !state.answer) {
      await state.registration;
    }
    reservation.assertCurrent();
    try {
      await state.gatewayCall(
        "question.resolve",
        { timeoutMs: QUESTION_RPC_GRACE_MS },
        { id: state.questionId, cancel: true, resolvedBy: params.resolvedBy },
        ...(reservation.extra ? ([reservation.extra] as const) : []),
      );
    } catch (error) {
      if (reservation.wasRefused() || !isTerminalAgentQuestionError(error)) {
        throw error;
      }
    }
    consumed = true;
    state.onCancel?.(params.resolvedBy);
    return true;
  } finally {
    reservation.finish(consumed);
  }
}

type RunAgentHarnessSecretInputParams = {
  questions: readonly AgentHarnessUserInputQuestion[];
  sessionKey: string;
  timeoutMs: number;
  delivery: Pick<EmbeddedRunAttemptParams, "onBlockReply" | "onPartialReply">;
  promptOptions?: AgentHarnessUserInputPromptOptions;
  signal?: AbortSignal;
};

/** Presents one warned secret prompt and keeps its answer out of durable question records. */
function runAgentHarnessSecretInput(
  params: RunAgentHarnessSecretInputParams,
): Promise<string | undefined> {
  params.signal?.throwIfAborted();
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    throw new Error("secret input requires a session key");
  }
  if (pendingAgentQuestions.has(sessionKey)) {
    throw new Error(`session already has a pending agent input request: ${sessionKey}`);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (text?: string): boolean => {
      if (settled || pendingAgentQuestions.get(sessionKey) !== state) {
        return false;
      }
      settled = true;
      pendingAgentQuestions.delete(sessionKey);
      clearTimeout(timeout);
      params.signal?.removeEventListener("abort", onAbort);
      resolve(text);
      return true;
    };
    const onAbort = () => finish();
    const timeout = setTimeout(onAbort, params.timeoutMs);
    timeout.unref?.();
    const state: PendingAgentSecretInput = {
      kind: "secret",
      sessionKey,
      resolving: false,
      settle: finish,
    };
    pendingAgentQuestions.set(sessionKey, state);
    params.signal?.addEventListener("abort", onAbort, { once: true });
    if (params.signal?.aborted) {
      onAbort();
      return;
    }
    void deliverAgentHarnessUserInputPrompt(
      params.delivery,
      params.questions,
      params.promptOptions,
    ).catch(() => finish());
  });
}

type RunAgentHarnessGatewayQuestionParams = {
  questions: readonly AgentHarnessUserInputQuestion[];
  sessionKey: string;
  agentId?: string;
  runId?: string;
  timeoutMs: number;
  gatewayCall?: AgentHarnessQuestionGatewayCall | AgentQuestionDispatcher;
  delivery: Pick<EmbeddedRunAttemptParams, "onBlockReply" | "onPartialReply">;
  promptOptions?: AgentHarnessUserInputPromptOptions;
  signal?: AbortSignal;
  questionId?: string;
};

/** Registers, presents, and waits for one harness-owned gateway question record. */
export async function runAgentHarnessGatewayQuestion(
  params: RunAgentHarnessGatewayQuestionParams,
): Promise<QuestionWaitAnswerResult> {
  if (params.questions.some((question) => question.isSecret)) {
    const text = await runAgentHarnessSecretInput({
      questions: params.questions,
      sessionKey: params.sessionKey,
      timeoutMs: params.timeoutMs,
      delivery: params.delivery,
      promptOptions: params.promptOptions,
      signal: params.signal,
    });
    if (text === undefined) {
      return { status: "cancelled" };
    }
    const parsed = buildAgentHarnessUserInputAnswers(params.questions, text);
    return {
      status: "answered",
      answers: {
        answers: Object.fromEntries(
          Object.entries(parsed.answers).map(([id, answer]) => [id, answer.answers]),
        ),
      },
    };
  }
  const gatewayCall = resolveAgentQuestionGatewayCall(params.gatewayCall);
  const questionId = params.questionId ?? `ask_${randomBytes(16).toString("hex")}`;
  const questions: QuestionRequestQuestion[] = params.questions.map(({ id, ...question }) => ({
    ...question,
    questionId: id,
    options: [...(question.options ?? [])],
  }));
  let aborted = false;
  params.signal?.throwIfAborted();
  const claim = registerPendingAgentQuestion({
    questionId,
    sessionKey: params.sessionKey,
    questions: params.questions,
    gatewayCall: params.gatewayCall,
  });
  const registration = Promise.resolve().then(
    () =>
      gatewayCall(
        "question.request",
        {},
        {
          id: questionId,
          questions,
          sessionKey: params.sessionKey,
          ...(params.agentId ? { agentId: params.agentId } : {}),
          ...(params.runId ? { runId: params.runId } : {}),
          timeoutMs: params.timeoutMs,
        },
        params.signal ? { signal: params.signal } : undefined,
      ) as Promise<{ id?: unknown }>,
  );
  claim.attachRegistration(registration);
  const cancel = async (resolvedBy: string): Promise<QuestionWaitAnswerResult | undefined> => {
    try {
      return (await gatewayCall(
        "question.resolve",
        { timeoutMs: QUESTION_RPC_GRACE_MS },
        { id: questionId, cancel: true, resolvedBy },
      )) as QuestionWaitAnswerResult;
    } catch (error) {
      if (!isTerminalAgentQuestionError(error)) {
        throw error;
      }
      try {
        const result = (await gatewayCall(
          "question.waitAnswer",
          { timeoutMs: QUESTION_RPC_GRACE_MS },
          { id: questionId, timeoutMs: 1_000 },
        )) as QuestionWaitAnswerResult;
        return result.status === "answered" ? result : undefined;
      } catch {
        return undefined;
      }
    }
  };
  const onAbort = () => {
    aborted = true;
    // Release the session slot synchronously so a replacement request can register
    // while the best-effort gateway cancellation finishes.
    claim.dispose();
    void cancel("run-abort").catch(() => undefined);
  };

  try {
    params.signal?.addEventListener("abort", onAbort, { once: true });
    if (params.signal?.aborted) {
      onAbort();
      params.signal.throwIfAborted();
    }
    const request = await registration;
    if (request.id !== questionId) {
      throw new Error("question.request returned an unexpected question id");
    }
    // Cancellation can race registration. Retry against the committed ID and
    // never present a stale prompt after the inbound message took another route.
    if (aborted || claim.isCancellationRequested() || params.signal?.aborted) {
      const terminal = await cancel(
        aborted || params.signal?.aborted ? "run-abort" : "superseded-input",
      );
      if (terminal?.status === "answered") {
        return terminal;
      }
      return { status: "cancelled" };
    }
    const answer = gatewayCall(
      "question.waitAnswer",
      { timeoutMs: params.timeoutMs + QUESTION_RPC_GRACE_MS },
      { id: questionId, timeoutMs: params.timeoutMs, includeResolutionId: true },
      params.signal ? { signal: params.signal } : undefined,
    ) as Promise<QuestionWaitAnswerResult>;
    claim.setAnswer(answer);
    const answerOutcome = answer.then(
      (result) => ({ kind: "answer" as const, result }),
      (error: unknown) => ({ kind: "answer-error" as const, error }),
    );
    const finishAnswer = async (result: QuestionWaitAnswerResult) => {
      const terminal =
        result.status === "pending"
          ? ((await cancel("wait-timeout")) ?? ({ status: "cancelled" } as const))
          : result;
      // The receipt belongs to the input claim, not the harness/model answer.
      return terminal.status === "answered"
        ? { status: terminal.status, answers: terminal.answers }
        : terminal;
    };
    const beforeDelivery = await Promise.race([
      answerOutcome,
      new Promise<{ kind: "delivery-ready" }>((resolve) => {
        setTimeout(() => resolve({ kind: "delivery-ready" }), 0);
      }),
    ]);
    if (beforeDelivery.kind === "answer") {
      return await finishAnswer(beforeDelivery.result);
    }
    if (beforeDelivery.kind === "answer-error") {
      throw beforeDelivery.error;
    }
    let consumed: boolean;
    do {
      consumed = await Promise.race([claim.waitForResolution(), answerOutcome.then(() => true)]);
    } while (!consumed && claim.isResolving());
    if (consumed) {
      // A completed registration-time claim must not expose a stale prompt.
      const outcome = await answerOutcome;
      if (outcome.kind === "answer-error") {
        throw outcome.error;
      }
      return await finishAnswer(outcome.result);
    }
    const deliveryAbort = new AbortController();
    const delivery = deliverAgentHarnessQuestionPrompt(
      params.delivery,
      questionId,
      params.questions,
      params.promptOptions,
      deliveryAbort.signal,
    );
    const deliveryOutcome = delivery.then(
      () => ({ kind: "delivery" as const }),
      (error: unknown) => ({ kind: "delivery-error" as const, error }),
    );
    const first = await Promise.race([answerOutcome, deliveryOutcome]);
    if (first.kind === "answer") {
      deliveryAbort.abort(new Error("gateway question resolved before prompt delivery"));
      return await finishAnswer(first.result);
    }
    if (first.kind === "answer-error") {
      deliveryAbort.abort(first.error);
      throw first.error;
    }
    if (first.kind === "delivery-error") {
      const terminal = await cancel("prompt-delivery-failed");
      if (terminal?.status === "answered") {
        return terminal;
      }
      throw new Error("harness question prompt delivery failed", { cause: first.error });
    }
    const terminal = await answerOutcome;
    if (terminal.kind === "answer-error") {
      throw terminal.error;
    }
    return await finishAnswer(terminal.result);
  } catch (error) {
    try {
      const terminal = await cancel(params.signal?.aborted ? "run-abort" : "harness-error");
      if (terminal?.status === "answered") {
        return terminal;
      }
    } catch {
      // Preserve the original bridge failure.
    }
    if (params.signal?.aborted) {
      return { status: "cancelled" };
    }
    throw error;
  } finally {
    params.signal?.removeEventListener("abort", onAbort);
    claim.dispose();
  }
}
