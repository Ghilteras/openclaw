import type { EmbeddedRunAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createCodexAttemptPreparationTiming } from "./attempt-preparation-timing.js";
import type { EmbeddedRunAttemptResult } from "./attempt-terminal.js";
import { maybeCompactCodexAppServerSession } from "./compact.js";
import { activateCodexAttemptTurn } from "./run-attempt-active-turn.js";
import { cleanupCodexAttempt } from "./run-attempt-cleanup.js";
import { prepareCodexAttemptConnection } from "./run-attempt-connection.js";
import { prepareCodexAttemptContext } from "./run-attempt-context.js";
import { finalizeCodexAttempt } from "./run-attempt-finalize.js";
import { createCodexAttemptLifecycleController } from "./run-attempt-lifecycle-controller.js";
import { createCodexAttemptNotificationController } from "./run-attempt-notification-controller.js";
import { prepareCodexAttemptPrompt } from "./run-attempt-prompt.js";
import { prepareCodexAttemptResources } from "./run-attempt-resources.js";
import { prepareCodexAttemptRoute } from "./run-attempt-route.js";
import { prepareCodexAttemptRuntime } from "./run-attempt-runtime.js";
import { createCodexAttemptServerRequestController } from "./run-attempt-server-requests.js";
import { startCodexAttemptRuntime } from "./run-attempt-start.js";
import { prepareCodexAttemptTools } from "./run-attempt-tool-setup.js";
import { prepareCodexAttemptTurnRequest } from "./run-attempt-turn-request.js";
import { startCodexAttemptTurn } from "./run-attempt-turn-start.js";
import { createCodexAttemptTurnState } from "./run-attempt-turn-state.js";
import type { CodexRunAttemptOptions } from "./run-attempt-types.js";
import { isSameCodexAppServerThreadOwner } from "./thread-ownership.js";

async function retryPendingCodexNativeCompaction(
  connection: Awaited<ReturnType<typeof prepareCodexAttemptConnection>>,
): Promise<void> {
  const pendingBinding = connection.mutable.startupBinding;
  if (pendingBinding?.nativeCompactionRetryPending !== true) {
    return;
  }
  await maybeCompactCodexAppServerSession(connection.params, {
    bindingStore: connection.bindingStore,
    pluginConfig: connection.options.pluginConfig,
    ...(connection.options.clientFactory
      ? { clientFactory: connection.options.clientFactory }
      : {}),
    allowNonManualNativeRequest: true,
    nativeCompactionRequest: "after_context_engine",
  });
  const currentBinding = connection.bindingStore.read(connection.bindingIdentity);
  connection.mutable.startupBinding = currentBinding;
  connection.mutable.startupContextTokens = undefined;
  if (
    currentBinding?.nativeCompactionRetryPending === true &&
    isSameCodexAppServerThreadOwner(currentBinding, pendingBinding)
  ) {
    throw new Error(
      "Codex native compaction retry remains pending before turn/start. Retry the turn after native compaction becomes available.",
    );
  }
}

export async function runCodexAppServerAttempt(
  params: EmbeddedRunAttemptParamsV2,
  options: CodexRunAttemptOptions,
): Promise<EmbeddedRunAttemptResult> {
  const preparation = createCodexAttemptPreparationTiming(params);
  const connection = await preparation.measure("connection", () =>
    prepareCodexAttemptConnection({ params, options }),
  );
  try {
    await preparation.measure("native-compaction-retry", () =>
      retryPendingCodexNativeCompaction(connection),
    );
  } catch (error) {
    connection.params.abortSignal?.removeEventListener("abort", connection.abortFromUpstream);
    throw error;
  }
  const runtime = await preparation.measure("runtime", () =>
    prepareCodexAttemptRuntime(connection),
  );
  const attemptTools = await preparation.measure("tools", () => prepareCodexAttemptTools(runtime));
  const attemptContext = await preparation.measure("context", () =>
    prepareCodexAttemptContext(runtime, attemptTools),
  );
  const attemptPrompt = await preparation.measure("prompt", () =>
    prepareCodexAttemptPrompt(attemptContext),
  );
  const resources = prepareCodexAttemptResources(attemptPrompt);
  attemptTools.runtimeYieldCompletionClaim.current = () =>
    resources.state.nativeHookRelay?.hasClaimedDirectChild() ?? false;
  await preparation.measure("runtime-start", () => startCodexAttemptRuntime(resources));

  const turnRuntime = createCodexAttemptTurnState(resources);
  try {
    const lifecycle = createCodexAttemptLifecycleController(resources, turnRuntime);
    const notifications = createCodexAttemptNotificationController(
      resources,
      turnRuntime,
      lifecycle,
    );
    const serverRequests = createCodexAttemptServerRequestController(
      resources,
      turnRuntime,
      lifecycle,
    );
    const { ensureCurrentThreadRoute } = await preparation.measure("thread-route", () =>
      prepareCodexAttemptRoute(
        resources,
        turnRuntime,
        notifications,
        serverRequests.handleServerRequest,
      ),
    );
    const turnRequest = await preparation.measure("turn-request", () =>
      prepareCodexAttemptTurnRequest(
        resources,
        turnRuntime,
        ensureCurrentThreadRoute,
        notifications.waitForActiveNativeTurnCompletion,
      ),
    );
    preparation.ready();
    const turnStart = await startCodexAttemptTurn(
      resources,
      turnRuntime,
      notifications,
      turnRequest,
    );
    if ("result" in turnStart) {
      return turnStart.result;
    }
    const activeTurn = activateCodexAttemptTurn(
      resources,
      turnRuntime,
      lifecycle,
      notifications,
      turnStart.turn,
    );
    let finalizedResult: EmbeddedRunAttemptResult;
    try {
      await activeTurn.ready;
      finalizedResult = await finalizeCodexAttempt(
        resources,
        turnRuntime,
        lifecycle,
        notifications,
        turnRequest,
        activeTurn,
      );
    } finally {
      await cleanupCodexAttempt(resources, turnRuntime, lifecycle, turnRequest, activeTurn);
    }
    // Cleanup retires the execution lease; only then can device loss no longer
    // race the final result captured during asynchronous terminal processing.
    if (
      resources.state.executionDisconnectError &&
      !connection.terminalState.explicitCancellationObserved
    ) {
      throw resources.state.executionDisconnectError;
    }
    return finalizedResult;
  } finally {
    turnRuntime.deadlines.dispose();
  }
}
