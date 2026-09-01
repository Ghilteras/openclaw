// Preloaded adapter for the same literal owner embedded in the native helper.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveServiceManagerEnv } from "../daemon/service-process-env.js";
import { resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir.js";
import { HANDOFF_LEASE_FACTORY_SOURCE } from "./update-managed-service-handoff-lease-script.js";

type ProcessIdentity = { pid: number; startIdentity: string };
type ManagedHandoffLeaseAction =
  | { kind: "update" }
  | {
      kind: "triage";
      phase: "reserved" | "running" | "closing" | "closed" | "uncertain";
      lifetime:
        | { kind: "foreground"; boot: { platform: string; identity: string } }
        | {
            kind: "native";
            unit: string;
            scope: string;
            placement: { kind: "pending" } | { kind: "attached"; invocation: string };
          };
    };
export type ManagedHandoffLease = {
  key: string;
  owner: string;
  payload: string;
  updatedAt: number;
  version: 2;
  executor: ProcessIdentity;
  helper: ProcessIdentity;
  action: ManagedHandoffLeaseAction;
};
type LeaseStore = {
  read(
    root: string,
  ): { kind: "absent" | "unreadable" } | { kind: "current"; lease: ManagedHandoffLease };
  acquire(
    root: string,
    owner: string,
    action: ManagedHandoffLeaseAction,
  ): { kind: "busy"; owner: string } | { kind: "acquired"; lease: ManagedHandoffLease };
  bind(
    lease: ManagedHandoffLease,
    pid: number,
    action?: ManagedHandoffLeaseAction,
  ): ManagedHandoffLease | null;
  retarget(
    lease: ManagedHandoffLease,
    root: string,
    action: ManagedHandoffLeaseAction,
  ): { kind: "busy"; owner: string } | { kind: "acquired"; lease: ManagedHandoffLease } | null;
  activate(lease: ManagedHandoffLease): ManagedHandoffLease | null;
  owns(lease: ManagedHandoffLease, role?: "helper" | "executor"): boolean;
  current(lease: ManagedHandoffLease): boolean;
  revoke(lease: ManagedHandoffLease, uncertain?: boolean): ManagedHandoffLease | null;
  complete(lease: ManagedHandoffLease): ManagedHandoffLease | null;
  release(lease: ManagedHandoffLease): boolean;
  stopNative(lease: ManagedHandoffLease, ownPlacement?: boolean): boolean;
  processIdentity(pid?: number): ProcessIdentity;
  readProcessStartIdentity(pid: number): string | null;
  bootIdentity(): { platform: string; identity: string };
};

const builtins = { fs, path, spawnSync, DatabaseSync, process };
// Keep it self-contained: package replacement can remove or rename bundled chunks.
// oxlint-disable-next-line typescript/no-implied-eval -- Evaluates only our trusted staged literal, never external code.
const createStore = new Function(
  "builtins",
  "options",
  `"use strict"; return (${HANDOFF_LEASE_FACTORY_SOURCE})(builtins, options);`,
  // SAFETY: Our trusted literal returns LeaseStore from these builtins and private options.
) as (
  dependencies: typeof builtins,
  options: { databasePath: string; serviceManagerEnv: Record<string, string> },
) => LeaseStore;

export function resolveManagedUpdateLeaseDatabasePath(): string {
  return path.join(resolvePreferredOpenClawTmpDir(), "managed-update-handoffs.sqlite");
}

export function createManagedHandoffLeaseStore(): LeaseStore {
  return createStore(builtins, {
    databasePath: resolveManagedUpdateLeaseDatabasePath(),
    serviceManagerEnv: resolveServiceManagerEnv(),
  });
}

export function stopManagedTriageScope(lease: ManagedHandoffLease): boolean {
  return createManagedHandoffLeaseStore().stopNative(lease);
}

export function readManagedServiceUpdateHandoffLease(
  root: string,
  stale?: { handoffId: string; helper?: ManagedHandoffLease },
): ManagedHandoffLease | null | undefined {
  const store = createManagedHandoffLeaseStore();
  const result = store.read(root);
  if (result.kind !== "current") {
    return result.kind === "absent" ? null : undefined;
  }
  const lease = result.lease;
  if (
    stale?.handoffId === lease.owner &&
    JSON.stringify(stale.helper?.helper) === JSON.stringify(lease.helper) &&
    (lease.action.kind !== "update" || stale.helper?.payload === lease.payload) &&
    (lease.action.kind !== "triage" ||
      (stale.helper?.action.kind === "triage" &&
        JSON.stringify(stale.helper.action.lifetime) === JSON.stringify(lease.action.lifetime))) &&
    store.release(lease)
  ) {
    return null;
  }
  return lease;
}

/** Native identity probes use the same projected environment as staged control. */
export function readManagedHandoffProcessStartTime(pid: number): number | null {
  const value = createManagedHandoffLeaseStore().readProcessStartIdentity(pid);
  return value === null ? null : Number(value);
}
