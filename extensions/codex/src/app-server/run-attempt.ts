import { isDeepStrictEqual } from "node:util";
import type { EmbeddedRunAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createCodexAttemptPreparationTiming } from "./attempt-preparation-timing.js";
import type { EmbeddedRunAttemptResult } from "./attempt-terminal.js";
import { synchronizePendingCodexNativeCompaction } from "./compact.js";
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
import { assertCodexBindingMayBeReplaced } from "./session-binding.js";
import { retireCodexAppServerSessionGeneration } from "./session-retirement.js";

const CODEX_NATIVE_COMPACTION_MAX_REPREPARATIONS = 2;

async function retryPendingCodexNativeCompaction(
  connection: Awaited<ReturnType<typeof prepareCodexAttemptConnection>>,
): Promise<"continue" | "reprepare"> {
  const pendingBinding = connection.mutable.startupBinding;
  if (pendingBinding?.nativeCompactionSyncPending !== true) {
    return "continue";
  }
  const outcome = await synchronizePendingCodexNativeCompaction(
    {
      ...connection.params,
      model: connection.params.modelId,
      runtimeModel: connection.params.model,
      trigger:
        connection.params.trigger === "manual" || connection.params.trigger === "overflow"
          ? connection.params.trigger
          : undefined,
      senderId: connection.params.senderId ?? undefined,
      senderName: connection.params.senderName ?? undefined,
      senderUsername: connection.params.senderUsername ?? undefined,
      senderE164: connection.params.senderE164 ?? undefined,
    },
    {
      bindingStore: connection.bindingStore,
      pluginConfig: connection.options.pluginConfig,
      ...(connection.options.clientFactory
        ? { clientFactory: connection.options.clientFactory }
        : {}),
      allowNonManualNativeRequest: true,
      nativeCompactionRequest: "after_context_engine",
      expectedBinding: pendingBinding,
    },
  );
  const currentBinding = connection.bindingStore.read(connection.bindingIdentity);
  connection.mutable.startupBinding = currentBinding;
  connection.mutable.startupContextTokens = undefined;
  const bindingUnchanged =
    outcome.kind !== "binding_changed" &&
    currentBinding !== undefined &&
    isDeepStrictEqual(currentBinding, outcome.binding);
  if (outcome.kind === "binding_changed" || !bindingUnchanged) {
    return "reprepare";
  }
  if (outcome.kind === "synchronized") {
    return "continue";
  }
  if (outcome.kind === "stale_thread" || outcome.kind === "rotation_required") {
    assertCodexBindingMayBeReplaced(
      outcome.binding,
      outcome.kind === "stale_thread"
        ? "recovering stale native compaction history"
        : "rotating a thread whose persisted restrictions prohibit native compaction",
      connection.params.expectedSessionRuntimeOwnership,
    );
    if (connection.bindingIdentity.kind !== "session") {
      throw new Error("Codex native compaction recovery requires a session binding");
    }
    await retireCodexAppServerSessionGeneration({
      bindingStore: connection.bindingStore,
      identity: connection.bindingIdentity,
      mode: "reset",
      expectedBinding: outcome.binding,
    });
    return "reprepare";
  }
  throw new Error(
    "Codex native compaction retry remains pending before turn/start. Retry the turn after native compaction becomes available.",
  );
}

export async function runCodexAppServerAttempt(
  params: EmbeddedRunAttemptParamsV2,
  options: CodexRunAttemptOptions,
): Promise<EmbeddedRunAttemptResult> {
  const preparation = createCodexAttemptPreparationTiming(params);
  let connection: Awaited<ReturnType<typeof prepareCodexAttemptConnection>>;
  let repreparations = 0;
  for (;;) {
    connection = await preparation.measure(
      repreparations === 0 ? "connection" : `connection-reprepare-${repreparations}`,
      () => prepareCodexAttemptConnection({ params, options }),
    );
    let decision: "continue" | "reprepare";
    try {
      decision = await preparation.measure("native-compaction-retry", () =>
        retryPendingCodexNativeCompaction(connection),
      );
    } catch (error) {
      connection.params.abortSignal?.removeEventListener("abort", connection.abortFromUpstream);
      throw error;
    }
    if (decision === "continue") {
      break;
    }
    connection.params.abortSignal?.removeEventListener("abort", connection.abortFromUpstream);
    if (repreparations >= CODEX_NATIVE_COMPACTION_MAX_REPREPARATIONS) {
      throw new Error(
        "Codex binding changed repeatedly during native compaction recovery after 2 repreparations",
      );
    }
    repreparations += 1;
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
