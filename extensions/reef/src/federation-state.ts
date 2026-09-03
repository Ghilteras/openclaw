import { createHash } from "node:crypto";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  REEF_FEDERATION_NAMESPACE,
  validateReefFederationBody,
  type ReefFederationFrame,
} from "../protocol/federation.js";
import { ReefPeerIdentitySchema, type ReefPeerIdentity } from "./friend-types.js";

const REEF_FEDERATION_MOUNTS_NAMESPACE = "federation-mounts";
const REEF_FEDERATION_PROPOSALS_NAMESPACE = "federation-proposals";
const REEF_FEDERATION_MOUNTS_MAX_ENTRIES = 1_000;
const REEF_FEDERATION_MOUNTS_PER_PEER = 32;
const REEF_FEDERATION_MOUNT_TTL_MS = 7 * 24 * 60 * 60_000;
const REEF_FEDERATION_PROPOSALS_MAX_ENTRIES = 5_000;
const REEF_FEDERATION_PROPOSAL_TTL_MS = 30 * 24 * 60 * 60_000;

export type ReefFederationMount = {
  mountId: string;
  peer: string;
  peerIdentity: ReefPeerIdentity;
  role: "host" | "guest";
  sessionKey: string;
  sessionId: string;
  grantGeneration: number;
  allowAlways: boolean;
  revoked: boolean;
};

export type ReefFederationPromptRequest = {
  from: string;
  to: string;
  peer: string;
  peerIdentity: ReefPeerIdentity;
  frame: Extract<ReefFederationFrame, { type: "session.prompt.propose" }>;
};

export type ReefFederationProposal = {
  proposalId: string;
  mountId: string;
  digest: string;
  status: "pending" | "accepted" | "denied" | "failed";
  request: ReefFederationPromptRequest;
  outcome?: Exclude<
    ReefFederationFrame,
    { type: "session.mount.offer" | "session.prompt.propose" }
  >;
  outcomeSentAt?: number;
  approvalId?: string;
  runId?: string;
  failureCode?: string;
};

export type ReefFederationProposalResolution = Pick<ReefFederationProposal, "status"> &
  Partial<Pick<ReefFederationProposal, "approvalId" | "runId" | "failureCode" | "outcome">>;

/** Durable Reef-owned state for session mounts, standing grants, and proposal replay outcomes. */
export class ReefFederationState {
  readonly #mounts: PluginStateSyncKeyedStore<ReefFederationMount>;
  readonly #proposals: PluginStateSyncKeyedStore<ReefFederationProposal>;

  constructor(runtime: PluginRuntime) {
    this.#mounts = runtime.state.openSyncKeyedStore<ReefFederationMount>({
      namespace: REEF_FEDERATION_MOUNTS_NAMESPACE,
      maxEntries: REEF_FEDERATION_MOUNTS_MAX_ENTRIES,
      overflowPolicy: "reject-new",
      defaultTtlMs: REEF_FEDERATION_MOUNT_TTL_MS,
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
    const peerMounts = this.#mounts
      .entries()
      .filter((entry) => validateMount(entry.value).peer === mount.peer);
    if (peerMounts.length >= REEF_FEDERATION_MOUNTS_PER_PEER) {
      return false;
    }
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

  /** List durable prompt work whose terminal outcome has not reached the peer. */
  listUnsentProposals(): ReefFederationProposal[] {
    return this.#proposals
      .entries()
      .map((entry) => validateProposal(entry.value))
      .filter((proposal) => proposal.outcomeSentAt === undefined);
  }

  /** Record a proposal outcome only while its exact digest remains authoritative. */
  resolveProposal(
    proposalId: string,
    digest: string,
    outcome: ReefFederationProposalResolution,
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

  /** Mark one exact terminal outcome as handed to the Reef transport. */
  markOutcomeSent(proposalId: string, digest: string): boolean {
    let changed = false;
    const update = this.#proposals.update;
    if (!update) {
      throw new Error("Reef federation proposals require atomic plugin-state updates");
    }
    update(proposalKey(proposalId), (existing) => {
      if (!existing || existing.digest !== digest || !existing.outcome) {
        return existing;
      }
      changed = true;
      return validateProposal({ ...existing, outcomeSentAt: Date.now() });
    });
    return changed;
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
    !ReefPeerIdentitySchema.safeParse(value.peerIdentity).success ||
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
    !["pending", "accepted", "denied", "failed"].includes(value.status) ||
    !value.request ||
    typeof value.request.from !== "string" ||
    typeof value.request.to !== "string" ||
    typeof value.request.peer !== "string" ||
    !ReefPeerIdentitySchema.safeParse(value.request.peerIdentity).success ||
    (value.outcomeSentAt !== undefined && !Number.isFinite(value.outcomeSentAt))
  ) {
    throw new Error("invalid Reef federation proposal");
  }
  validateReefFederationBody({
    namespace: REEF_FEDERATION_NAMESPACE,
    frame: value.request.frame,
  });
  if (value.outcome) {
    validateReefFederationBody({ namespace: REEF_FEDERATION_NAMESPACE, frame: value.outcome });
  }
  if ((value.status === "pending") === Boolean(value.outcome)) {
    throw new Error("invalid Reef federation proposal outcome");
  }
  return structuredClone(value);
}
