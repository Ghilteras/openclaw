import { isDeepStrictEqual } from "node:util";
import type { WorkerProvider } from "../../plugins/types.js";
import type { WorkerProviderLifecycleOptions } from "./provider-lifecycle.types.js";
import { requireProviderOperationTimeoutMs } from "./service-validation.js";
import type { WorkerEnvironmentRecord } from "./store.js";
import {
  WorkerTunnelOwnerDisconnectedError,
  type WorkerTunnelStopReason,
} from "./tunnel-contract.js";

export function createWorkerProviderOwnerLifecycle(
  options: Pick<
    WorkerProviderLifecycleOptions,
    | "store"
    | "tunnelManager"
    | "serviceError"
    | "callProvider"
    | "providerCallTimeoutMs"
    | "placementStore"
    | "move"
    | "inState"
    | "retireNodeEnrollment"
    | "isStopping"
    | "withLock"
    | "saveError"
  > & { finishDestroy: (record: WorkerEnvironmentRecord) => Promise<WorkerEnvironmentRecord> },
) {
  const { store, serviceError, move, inState, withLock, saveError, finishDestroy } = options;
  const tunnels = options.tunnelManager;

  const requireCurrentOwner = (record: WorkerEnvironmentRecord): WorkerEnvironmentRecord => {
    const current = store.get(record.environmentId);
    if (
      !current ||
      current.ownerEpoch !== record.ownerEpoch ||
      current.state !== record.state ||
      current.leaseId !== record.leaseId ||
      current.nodeDeviceId !== record.nodeDeviceId ||
      current.sharedHost !== record.sharedHost ||
      !isDeepStrictEqual(current.attachedSessionIds, record.attachedSessionIds)
    ) {
      throw serviceError("invalid_state", "Worker environment owner changed during teardown");
    }
    return current;
  };

  const stopOwner = async (
    record: WorkerEnvironmentRecord,
    reason?: WorkerTunnelStopReason,
  ): Promise<WorkerEnvironmentRecord> => {
    requireCurrentOwner(record);
    const sessionId = record.attachedSessionIds.length === 1 ? record.attachedSessionIds[0] : null;
    if (sessionId) {
      // Transfer an exact pending-result owner before credential revocation makes its
      // same-lifecycle worker permanently unreachable to recovery.
      options.placementStore?.prepareWorkspaceResultOwnerRevocation(
        { sessionId, environmentId: record.environmentId, ownerEpoch: record.ownerEpoch },
        new Error(record.lastError ?? "Cloud worker owner revoked before workspace recovery"),
      );
    }
    // Fence admission without erasing the attachment needed to stop a retained node worker.
    // A crash or failed stop leaves the exact scope available for teardown replay.
    store.revokeEnvironmentCredential(record.environmentId);
    // Only a dedicated node lease makes provider teardown proof of worker termination.
    // Shared or unknown host isolation still requires the exact worker's stop acknowledgement.
    await tunnels?.stop(
      record.environmentId,
      record.ownerEpoch,
      record.nodeDeviceId !== null && record.sharedHost === false ? reason : undefined,
    );
    return requireCurrentOwner(record);
  };

  const destroyLease = async (
    record: WorkerEnvironmentRecord,
    provider: WorkerProvider,
    lease: Parameters<WorkerProvider["destroy"]>[0],
  ) => {
    requireCurrentOwner(record);
    const timeoutMs =
      options.providerCallTimeoutMs === undefined
        ? requireProviderOperationTimeoutMs(
            "destroy",
            provider.resolveDestroyTimeoutMs?.(lease.profile),
          )
        : undefined;
    await options.callProvider(
      record.environmentId,
      () => {
        // An earlier timed-out operation can keep this call queued across owner changes.
        requireCurrentOwner(record);
        return provider.destroy(lease);
      },
      timeoutMs,
    );
  };

  const beginDrain = (record: WorkerEnvironmentRecord) => {
    const failurePatch =
      record.teardownTerminalState === "failed" ? { lastError: record.lastError } : undefined;
    return inState(record, "bootstrapping", "ready", "attached", "idle")
      ? move(record, "draining", failurePatch)
      : record;
  };

  const beginDestroy = (record: WorkerEnvironmentRecord) => {
    const failurePatch =
      record.teardownTerminalState === "failed" ? { lastError: record.lastError } : undefined;
    const draining = beginDrain(record);
    if (draining.state === "draining") {
      return move(draining, "destroying", failurePatch);
    }
    if (draining.state === "destroying") {
      return draining;
    }
    throw serviceError("invalid_state", `Cannot destroy worker in state: ${record.state}`);
  };

  const finishProvenDestroy = async (record: WorkerEnvironmentRecord) => {
    const destroying = beginDestroy(requireCurrentOwner(record));
    if (destroying.nodeSetupId) {
      await options.retireNodeEnrollment?.(destroying);
    }
    requireCurrentOwner(destroying);
    if (destroying.teardownTerminalState !== "failed") {
      return move(destroying, "destroyed");
    }
    return move(destroying, "failed", {
      leaseId: null,
      nodeDeviceId: null,
      sshEndpoint: null,
      sharedHost: false,
      lastError: destroying.lastError ?? "Worker bootstrap failed after provider teardown",
    });
  };

  const retireAbandonedNodeEnvironment = async (
    binding: { environmentId: string; sessionId: string; ownerEpoch: number },
    authorize?: () => void,
  ): Promise<{ status: "destroyed" } | { status: "cleanup-pending" }> => {
    if (options.isStopping()) {
      throw serviceError("invalid_state", "Worker environment service is stopping");
    }
    return withLock(binding.environmentId, async () => {
      authorize?.();
      let record = store.get(binding.environmentId);
      if (
        !record ||
        record.state === "destroyed" ||
        (record.state === "failed" && !record.leaseId)
      ) {
        return { status: "destroyed" };
      }
      if (
        record.ownerEpoch !== binding.ownerEpoch ||
        !record.nodeDeviceId ||
        record.sharedHost !== true ||
        record.attachedSessionIds.length !== 1 ||
        record.attachedSessionIds[0] !== binding.sessionId
      ) {
        throw serviceError(
          "invalid_state",
          "Abandoned device worker owner changed before retirement",
        );
      }
      record = store.requestDestroy({ environmentId: record.environmentId, state: record.state });
      try {
        await finishDestroy(record);
        authorize?.();
        return { status: "destroyed" };
      } catch (error) {
        if (!(error instanceof WorkerTunnelOwnerDisconnectedError)) {
          throw error;
        }
        authorize?.();
        const current = requireCurrentOwner(record);
        if (current.destroyRequestedAtMs === null || store.getCredential(current.environmentId)) {
          throw serviceError("invalid_state", "Abandoned device worker authority is not fenced");
        }
        // All local stops have joined. Keep the old attachment until reconnect can prove
        // physical cleanup; explicit abandonment releases only the session's local owner.
        saveError(current, error);
        return { status: "cleanup-pending" };
      }
    });
  };

  return {
    retireAbandonedNodeEnvironment,
    requireCurrentOwner,
    stopOwner,
    destroyLease,
    beginDrain,
    beginDestroy,
    finishProvenDestroy,
  };
}
