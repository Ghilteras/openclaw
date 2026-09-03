import { createHash } from "node:crypto";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";

const REEF_FEDERATION_MOUNTS_NAMESPACE = "federation-mounts";
const REEF_FEDERATION_PROPOSALS_NAMESPACE = "federation-proposals";
const REEF_FEDERATION_MOUNTS_MAX_ENTRIES = 1_000;
const REEF_FEDERATION_PROPOSALS_MAX_ENTRIES = 5_000;
const REEF_FEDERATION_PROPOSAL_TTL_MS = 30 * 24 * 60 * 60_000;

export type ReefFederationMount = {
  mountId: string;
  peer: string;
  peerKeyEpoch: number;
  role: "host" | "guest";
  sessionKey: string;
  sessionId: string;
  grantGeneration: number;
  allowAlways: boolean;
  revoked: boolean;
};

export type ReefFederationProposal = {
  proposalId: string;
  mountId: string;
  digest: string;
  status: "pending" | "accepted" | "denied" | "failed";
  approvalId?: string;
  runId?: string;
  failureCode?: string;
};

/** Durable Reef-owned state for session mounts, standing grants, and proposal replay outcomes. */
export class ReefFederationState {
  readonly #mounts: PluginStateSyncKeyedStore<ReefFederationMount>;
  readonly #proposals: PluginStateSyncKeyedStore<ReefFederationProposal>;

  constructor(runtime: PluginRuntime) {
    this.#mounts = runtime.state.openSyncKeyedStore<ReefFederationMount>({
      namespace: REEF_FEDERATION_MOUNTS_NAMESPACE,
      maxEntries: REEF_FEDERATION_MOUNTS_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    });
    this.#proposals = runtime.state.openSyncKeyedStore<ReefFederationProposal>({
      namespace: REEF_FEDERATION_PROPOSALS_NAMESPACE,
      maxEntries: REEF_FEDERATION_PROPOSALS_MAX_ENTRIES,
      overflowPolicy: "reject-new",
      defaultTtlMs: REEF_FEDERATION_PROPOSAL_TTL_MS,
    });
  }

  /** Persist a host-issued mount without replacing an existing authority binding. */
  createMount(mount: ReefFederationMount): boolean {
    validateMount(mount);
    return this.#mounts.registerIfAbsent(mountKey(mount.mountId), structuredClone(mount));
  }

  /** List validated mounts for owner commands and status surfaces. */
  listMounts(): ReefFederationMount[] {
    return this.#mounts.entries().map((entry) => validateMount(entry.value));
  }

  /** Read one validated mount by its public identifier. */
  getMount(mountId: string): ReefFederationMount | undefined {
    const value = this.#mounts.lookup(mountKey(mountId));
    return value ? validateMount(value) : undefined;
  }

  /** Enable the standing session grant only when the exact authority generation still matches. */
  allowAlways(mountId: string, expectedGeneration: number): boolean {
    return this.#updateMount(mountId, expectedGeneration, (mount) => ({
      ...mount,
      allowAlways: true,
    }));
  }

  /** Revoke a standing grant before returning the new generation to the caller. */
  revoke(mountId: string, expectedGeneration: number): ReefFederationMount | undefined {
    let revoked: ReefFederationMount | undefined;
    this.#updateMount(mountId, expectedGeneration, (mount) => {
      revoked = {
        ...mount,
        allowAlways: false,
        revoked: true,
        grantGeneration: mount.grantGeneration + 1,
      };
      return revoked;
    });
    return revoked;
  }

  /** Apply a peer-issued revocation only when it advances the local authority generation. */
  applyRevocation(mountId: string, generation: number): boolean {
    let changed = false;
    const update = this.#mounts.update;
    if (!update) {
      throw new Error("Reef federation mounts require atomic plugin-state updates");
    }
    update(mountKey(mountId), (existing) => {
      if (!existing) {
        return existing;
      }
      const mount = validateMount(existing);
      if (generation <= mount.grantGeneration) {
        return mount;
      }
      changed = true;
      return { ...mount, grantGeneration: generation, allowAlways: false, revoked: true };
    });
    return changed;
  }

  /** Claim one exact proposal; duplicate IDs return the prior outcome, while digest reuse fails. */
  claimProposal(proposal: ReefFederationProposal): {
    result: "new" | "duplicate" | "mismatch";
    proposal: ReefFederationProposal;
  } {
    validateProposal(proposal);
    let result: "new" | "duplicate" | "mismatch" = "new";
    let current = proposal;
    const update = this.#proposals.update;
    if (!update) {
      throw new Error("Reef federation proposals require atomic plugin-state updates");
    }
    update(proposalKey(proposal.proposalId), (existing) => {
      if (!existing) {
        return structuredClone(proposal);
      }
      current = validateProposal(existing);
      result = existing.digest === proposal.digest ? "duplicate" : "mismatch";
      return existing;
    });
    return { result, proposal: structuredClone(current) };
  }

  /** Record a proposal outcome only while its exact digest remains authoritative. */
  resolveProposal(
    proposalId: string,
    digest: string,
    outcome: Omit<ReefFederationProposal, "proposalId" | "mountId" | "digest">,
  ): ReefFederationProposal | undefined {
    let resolved: ReefFederationProposal | undefined;
    const update = this.#proposals.update;
    if (!update) {
      throw new Error("Reef federation proposals require atomic plugin-state updates");
    }
    update(proposalKey(proposalId), (existing) => {
      if (!existing || existing.digest !== digest) {
        return existing;
      }
      resolved = validateProposal({ ...existing, ...outcome });
      return resolved;
    });
    return resolved;
  }

  #updateMount(
    mountId: string,
    expectedGeneration: number,
    mutate: (mount: ReefFederationMount) => ReefFederationMount,
  ): boolean {
    let changed = false;
    const update = this.#mounts.update;
    if (!update) {
      throw new Error("Reef federation mounts require atomic plugin-state updates");
    }
    update(mountKey(mountId), (existing) => {
      if (!existing) {
        return existing;
      }
      const mount = validateMount(existing);
      if (mount.grantGeneration !== expectedGeneration || mount.revoked) {
        return mount;
      }
      changed = true;
      return validateMount(mutate(mount));
    });
    return changed;
  }
}

function mountKey(mountId: string): string {
  return `mount:${hashKey(mountId)}`;
}

function proposalKey(proposalId: string): string {
  return `proposal:${hashKey(proposalId)}`;
}

function hashKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validateMount(value: ReefFederationMount): ReefFederationMount {
  if (
    !value ||
    typeof value.mountId !== "string" ||
    typeof value.peer !== "string" ||
    !Number.isSafeInteger(value.peerKeyEpoch) ||
    value.peerKeyEpoch < 1 ||
    !["host", "guest"].includes(value.role) ||
    typeof value.sessionKey !== "string" ||
    typeof value.sessionId !== "string" ||
    !Number.isSafeInteger(value.grantGeneration) ||
    value.grantGeneration < 0 ||
    typeof value.allowAlways !== "boolean" ||
    typeof value.revoked !== "boolean"
  ) {
    throw new Error("invalid Reef federation mount");
  }
  return structuredClone(value);
}

function validateProposal(value: ReefFederationProposal): ReefFederationProposal {
  if (
    !value ||
    typeof value.proposalId !== "string" ||
    typeof value.mountId !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.digest) ||
    !["pending", "accepted", "denied", "failed"].includes(value.status)
  ) {
    throw new Error("invalid Reef federation proposal");
  }
  return structuredClone(value);
}
