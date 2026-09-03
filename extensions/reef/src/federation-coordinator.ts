import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import {
  createReefFederatedPromptDigest,
  type ReefFederationFrame,
} from "../protocol/federation.js";
import type { ReefFederationMount, ReefFederationProposal } from "./federation-state.js";

const REEF_FEDERATION_APPROVAL_TIMEOUT_MS = 10 * 60_000;

type FederationState = {
  getMount(mountId: string): ReefFederationMount | undefined;
  allowAlways(mountId: string, expectedGeneration: number): boolean;
  claimProposal(proposal: ReefFederationProposal): {
    result: "new" | "duplicate" | "mismatch";
    proposal: ReefFederationProposal;
  };
  resolveProposal(
    proposalId: string,
    digest: string,
    outcome: Omit<ReefFederationProposal, "proposalId" | "mountId" | "digest">,
  ): ReefFederationProposal | undefined;
};

type ApprovalResponse = {
  id?: string;
  decision?: "allow-once" | "allow-always" | "deny" | null;
};

type AgentResponse = {
  runId?: string;
};

/** Home-Gateway coordinator for exact, host-approved remote prompt proposals. */
export class ReefFederationCoordinator {
  constructor(
    private readonly runtime: Pick<PluginRuntime, "gateway">,
    private readonly state: FederationState,
    private readonly currentPeerKeyEpoch: (peer: string) => number | undefined,
  ) {}

  /** Validate, approve, and dispatch one remote prompt through canonical agent admission. */
  async handlePrompt(params: {
    from: string;
    to: string;
    peer: string;
    peerKeyEpoch: number;
    frame: Extract<ReefFederationFrame, { type: "session.prompt.propose" }>;
  }): Promise<Exclude<ReefFederationFrame, { type: "session.prompt.propose" }>> {
    const { frame } = params;
    const mount = this.state.getMount(frame.mountId);
    const invalid = this.validateMount({ ...params, mount });
    if (invalid) {
      return this.denied(frame, invalid);
    }
    const digest = createReefFederatedPromptDigest({
      from: params.from,
      to: params.to,
      mountId: frame.mountId,
      proposalId: frame.proposalId,
      sessionId: frame.sessionId,
      grantGeneration: frame.grantGeneration,
      text: frame.text,
    });
    if (digest !== frame.textSha256) {
      return this.failed(frame, "digest-mismatch", "The prompt digest does not match its binding.");
    }
    const claim = this.state.claimProposal({
      proposalId: frame.proposalId,
      mountId: frame.mountId,
      digest,
      status: "pending",
    });
    if (claim.result === "mismatch") {
      return this.failed(
        frame,
        "proposal-rebound",
        "The proposal ID is already bound to other content.",
      );
    }
    const prior = priorOutcome(claim.proposal, frame);
    if (prior) {
      return prior;
    }

    let approvalId: string | undefined;
    if (!mount!.allowAlways) {
      const approval = await this.requestApproval(params.peer, mount!, frame);
      approvalId = approval.id;
      if (approval.decision === "deny") {
        this.state.resolveProposal(frame.proposalId, digest, {
          status: "denied",
          ...(approvalId ? { approvalId } : {}),
        });
        return this.denied(frame, "host-denied");
      }
      if (approval.decision !== "allow-once" && approval.decision !== "allow-always") {
        return this.recordFailure(
          frame,
          digest,
          "approval-unavailable",
          "No host approval route accepted the prompt.",
          approvalId,
        );
      }
      if (
        approval.decision === "allow-always" &&
        !this.state.allowAlways(frame.mountId, frame.grantGeneration)
      ) {
        return this.recordFailure(
          frame,
          digest,
          "grant-stale",
          "The session grant changed before it could be stored.",
          approvalId,
        );
      }
    }

    const currentMount = this.state.getMount(frame.mountId);
    const currentPeerKeyEpoch = this.currentPeerKeyEpoch(params.peer);
    const staleAuthority = this.validateMount({
      ...params,
      peerKeyEpoch: currentPeerKeyEpoch ?? -1,
      mount: currentMount,
    });
    if (staleAuthority) {
      this.state.resolveProposal(frame.proposalId, digest, {
        status: "denied",
        ...(approvalId ? { approvalId } : {}),
      });
      return this.denied(frame, staleAuthority);
    }

    try {
      const runId = `reef:${frame.proposalId}`;
      const result = await this.runtime.gateway.request<AgentResponse>(
        "agent",
        {
          message: frame.text,
          sessionKey: currentMount!.sessionKey,
          expectedExistingSessionId: currentMount!.sessionId,
          idempotencyKey: runId,
          deliver: false,
          inputProvenance: {
            kind: "inter_session",
            sourceSessionKey: `reef:${params.peer}:${frame.mountId}`,
            sourceChannel: "reef",
            sourceTool: "reef_federated_prompt",
          },
        },
        { timeoutMs: REEF_FEDERATION_APPROVAL_TIMEOUT_MS },
      );
      const accepted = {
        type: "session.prompt.accepted" as const,
        mountId: frame.mountId,
        proposalId: frame.proposalId,
        sessionId: frame.sessionId,
        runId: result.runId || runId,
      };
      this.state.resolveProposal(frame.proposalId, digest, {
        status: "accepted",
        ...(approvalId ? { approvalId } : {}),
        runId: accepted.runId,
      });
      return accepted;
    } catch (error) {
      return this.recordFailure(
        frame,
        digest,
        "dispatch-failed",
        error instanceof Error ? error.message : "Prompt dispatch failed.",
        approvalId,
      );
    }
  }

  private validateMount(params: {
    peer: string;
    peerKeyEpoch: number;
    frame: Extract<ReefFederationFrame, { type: "session.prompt.propose" }>;
    mount: ReefFederationMount | undefined;
  }): "grant-revoked" | "stale-session" | undefined {
    const { frame, mount } = params;
    if (
      !mount ||
      mount.role !== "host" ||
      mount.revoked ||
      mount.peer !== params.peer ||
      mount.peerKeyEpoch !== params.peerKeyEpoch ||
      mount.grantGeneration !== frame.grantGeneration
    ) {
      return "grant-revoked";
    }
    if (mount.sessionId !== frame.sessionId) {
      return "stale-session";
    }
    return undefined;
  }

  private async requestApproval(
    peer: string,
    mount: ReefFederationMount,
    frame: Extract<ReefFederationFrame, { type: "session.prompt.propose" }>,
  ): Promise<ApprovalResponse> {
    return await this.runtime.gateway.request<ApprovalResponse>(
      "plugin.approval.request",
      {
        pluginId: "reef",
        title: `Guest prompt from @${peer}`,
        description: frame.text,
        detail: `Session: ${mount.sessionKey}\nRemote peer: @${peer}\nProposal: ${frame.proposalId}`,
        severity: "info",
        sessionKey: mount.sessionKey,
        allowedDecisions: ["allow-once", "allow-always", "deny"],
        timeoutMs: REEF_FEDERATION_APPROVAL_TIMEOUT_MS,
      },
      { timeoutMs: REEF_FEDERATION_APPROVAL_TIMEOUT_MS },
    );
  }

  private recordFailure(
    frame: Extract<ReefFederationFrame, { type: "session.prompt.propose" }>,
    digest: string,
    code: string,
    message: string,
    approvalId?: string,
  ): Extract<ReefFederationFrame, { type: "session.prompt.failed" }> {
    this.state.resolveProposal(frame.proposalId, digest, {
      status: "failed",
      failureCode: code,
      ...(approvalId ? { approvalId } : {}),
    });
    return this.failed(frame, code, message);
  }

  private denied(
    frame: Extract<ReefFederationFrame, { type: "session.prompt.propose" }>,
    reason: Extract<ReefFederationFrame, { type: "session.prompt.denied" }>["reason"],
  ): Extract<ReefFederationFrame, { type: "session.prompt.denied" }> {
    return {
      type: "session.prompt.denied",
      mountId: frame.mountId,
      proposalId: frame.proposalId,
      sessionId: frame.sessionId,
      reason,
    };
  }

  private failed(
    frame: Extract<ReefFederationFrame, { type: "session.prompt.propose" }>,
    code: string,
    message: string,
  ): Extract<ReefFederationFrame, { type: "session.prompt.failed" }> {
    return {
      type: "session.prompt.failed",
      mountId: frame.mountId,
      proposalId: frame.proposalId,
      sessionId: frame.sessionId,
      code,
      message: message.slice(0, 512),
    };
  }
}

function priorOutcome(
  proposal: ReefFederationProposal,
  frame: Extract<ReefFederationFrame, { type: "session.prompt.propose" }>,
): Exclude<ReefFederationFrame, { type: "session.prompt.propose" }> | undefined {
  if (proposal.status === "accepted" && proposal.runId) {
    return {
      type: "session.prompt.accepted",
      mountId: frame.mountId,
      proposalId: frame.proposalId,
      sessionId: frame.sessionId,
      runId: proposal.runId,
    };
  }
  if (proposal.status === "denied") {
    return {
      type: "session.prompt.denied",
      mountId: frame.mountId,
      proposalId: frame.proposalId,
      sessionId: frame.sessionId,
      reason: "host-denied",
    };
  }
  if (proposal.status === "failed") {
    return {
      type: "session.prompt.failed",
      mountId: frame.mountId,
      proposalId: frame.proposalId,
      sessionId: frame.sessionId,
      code: proposal.failureCode || "dispatch-failed",
      message: "The prior prompt attempt failed.",
    };
  }
  return undefined;
}
