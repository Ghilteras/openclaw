import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MOBILE_PAIRING_AUDIT_CLIENT,
  MOBILE_PAIRING_APPROVAL_SCOPES,
  MOBILE_PAIRING_CLIENT,
  MOBILE_PAIRING_NODE_CAPS,
  MOBILE_PAIRING_NODE_COMMANDS,
  MOBILE_PAIRING_NODE_PERMISSIONS,
  MOBILE_PAIRING_OPERATOR_CAPS,
  approveBaselineNodePairing,
  buildConnectRequest,
  buildDeviceAuthCompatibilityPayloadV2,
  buildRedactedEvidence,
  createMobilePairingIdentity,
  extractBootstrapCredentials,
  inspectBaselineNodePairing,
  parseConnectChallengePayload,
  parseQrBootstrapJson,
  persistHelloCredential,
  validatePairingAudit,
  verifyDeviceAuthPayloadSignature,
} from "../../scripts/e2e/lib/upgrade-survivor/mobile-pairing-client.mts";

const CLIENT_PATH = "scripts/e2e/lib/upgrade-survivor/mobile-pairing-client.mts";
const RUNNER_PATH = "scripts/e2e/lib/upgrade-survivor/run.sh";

function tokenHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function bootstrapHello(nodeToken: string, operatorToken: string) {
  return {
    type: "hello-ok",
    auth: {
      role: "node",
      scopes: [],
      deviceToken: nodeToken,
      deviceTokens: [
        {
          role: "operator",
          scopes: [
            "operator.approvals",
            "operator.read",
            "operator.talk.secrets",
            "operator.write",
          ],
          deviceToken: operatorToken,
          issuedAtMs: 1,
        },
      ],
    },
  };
}

describe("upgrade survivor mobile pairing client", () => {
  it("uses the node approval CLI backend identity for pairing audits", () => {
    expect(MOBILE_PAIRING_AUDIT_CLIENT).toMatchObject({
      id: "gateway-client",
      version: MOBILE_PAIRING_CLIENT.version,
      instanceId: "c0202128-dbd7-42a5-a8ac-aaf20dc14c9c",
    });
    const request = buildConnectRequest({
      challengePayload: { nonce: "nonce-audit", ts: 1_700_000_000_000 },
      client: MOBILE_PAIRING_AUDIT_CLIENT,
      mode: "backend",
      role: "operator",
      scopes: ["operator.pairing"],
      auth: { password: "audit-password" },
    });
    expect(request.params).toMatchObject({
      client: { id: "gateway-client", mode: "backend" },
      role: "operator",
      scopes: ["operator.pairing"],
      auth: { password: "audit-password" },
    });
    expect(request.params).not.toHaveProperty("device");
  });

  it("pins the shipped iOS 2026.8.10 V2 compatibility payload bytes", () => {
    expect(
      buildDeviceAuthCompatibilityPayloadV2({
        deviceId: "dev-1",
        clientId: "openclaw-ios",
        clientMode: "ui",
        role: "operator",
        scopes: ["operator.read", "operator.write"],
        signedAtMs: 1_700_000_000_001,
        token: "operator-token",
        nonce: "nonce-1",
      }),
    ).toBe(
      "v2|dev-1|openclaw-ios|ui|operator|operator.read,operator.write|1700000000001|operator-token|nonce-1",
    );
  });

  it("uses shipped protocol ranges, challenge time, instance id, and auth.token", () => {
    const identity = createMobilePairingIdentity();
    const challengePayload = { nonce: " nonce-1 ", ts: 1_700_000_000_001 };
    const nodeRequest = buildConnectRequest({
      id: "connect-1",
      challengePayload,
      client: MOBILE_PAIRING_CLIENT,
      mode: "node",
      role: "node",
      scopes: [],
      auth: { token: "node-token" },
      identity,
    });
    const operatorRequest = buildConnectRequest({
      id: "connect-2",
      challengePayload,
      client: MOBILE_PAIRING_CLIENT,
      mode: "ui",
      role: "operator",
      scopes: ["operator.read"],
      auth: { token: "operator-token" },
      identity,
    });
    const nodeParams = nodeRequest.params as {
      minProtocol: number;
      maxProtocol: number;
      client: Record<string, string>;
      caps: string[];
      commands: string[];
      permissions: Record<string, boolean>;
      locale: string;
      userAgent: string;
      auth: Record<string, string>;
      device: { nonce: string; signature: string; signedAt: number };
    };
    const operatorParams = operatorRequest.params as {
      minProtocol: number;
      maxProtocol: number;
      caps: string[];
      auth: Record<string, string>;
    };
    const payload = buildDeviceAuthCompatibilityPayloadV2({
      deviceId: identity.deviceId,
      clientId: MOBILE_PAIRING_CLIENT.id,
      clientMode: "node",
      role: "node",
      scopes: [],
      signedAtMs: challengePayload.ts,
      token: "node-token",
      nonce: "nonce-1",
    });

    expect(nodeParams).toMatchObject({
      minProtocol: 3,
      maxProtocol: 4,
      client: { instanceId: MOBILE_PAIRING_CLIENT.instanceId },
      caps: MOBILE_PAIRING_NODE_CAPS,
      commands: MOBILE_PAIRING_NODE_COMMANDS,
      permissions: MOBILE_PAIRING_NODE_PERMISSIONS,
      locale: "en-US",
      userAgent: "Version 26.6.1",
      auth: { token: "node-token" },
      device: { nonce: "nonce-1", signedAt: challengePayload.ts },
    });
    expect(operatorParams).toMatchObject({
      minProtocol: 4,
      maxProtocol: 4,
      caps: MOBILE_PAIRING_OPERATOR_CAPS,
      auth: { token: "operator-token" },
    });
    expect(operatorParams).not.toHaveProperty("commands");
    expect(operatorParams).not.toHaveProperty("permissions");
    expect(nodeParams.auth).not.toHaveProperty("deviceToken");
    expect(operatorParams.auth).not.toHaveProperty("deviceToken");
    expect(
      verifyDeviceAuthPayloadSignature({
        publicKeyPem: identity.publicKeyPem,
        payload,
        signature: nodeParams.device.signature,
      }),
    ).toBe(true);
  });

  it("requires the connect.challenge timestamp used by the shipped client", () => {
    expect(parseConnectChallengePayload({ nonce: " nonce-1 ", ts: 1_700_000_000_123 })).toEqual({
      nonce: "nonce-1",
      issuedAtMs: 1_700_000_000_123,
    });
    for (const payload of [
      null,
      { nonce: "nonce-1" },
      { nonce: "nonce-1", ts: "1700000000123" },
      { nonce: "nonce-1", ts: -1 },
      { nonce: "nonce-1", ts: 1.5 },
      { nonce: " ", ts: 1_700_000_000_123 },
    ]) {
      expect(() => parseConnectChallengePayload(payload)).toThrow(/Gateway challenge/);
    }
  });

  it("parses the QR bootstrap and extracts both baseline-issued role credentials", () => {
    const nodeToken = "node-token-secret";
    const operatorToken = "operator-token-secret";
    const setupCode = Buffer.from(
      JSON.stringify({
        url: "ws://127.0.0.1:18789",
        bootstrapToken: "bootstrap-token-secret",
      }),
    ).toString("base64url");
    const identity = createMobilePairingIdentity();
    const bootstrap = parseQrBootstrapJson({ setupCode });
    const credentials = extractBootstrapCredentials({
      url: bootstrap.url,
      client: MOBILE_PAIRING_CLIENT,
      identity,
      hello: bootstrapHello(nodeToken, operatorToken),
    });

    expect(bootstrap).toEqual({
      url: "ws://127.0.0.1:18789",
      bootstrapToken: "bootstrap-token-secret",
    });
    expect(credentials.node).toEqual({ token: nodeToken, scopes: [] });
    expect(credentials.operator).toEqual({
      token: operatorToken,
      scopes: ["operator.approvals", "operator.read", "operator.talk.secrets", "operator.write"],
    });
    expect(credentials.operator.scopes).not.toContain("operator.pairing");
    expect(credentials.operator.scopes).not.toContain("operator.admin");
    expect(credentials.client.instanceId).toBe(MOBILE_PAIRING_CLIENT.instanceId);
  });

  it("persists rotated hello tokens and uses the newest credential on the next reconnect", () => {
    const identity = createMobilePairingIdentity();
    const credentials = extractBootstrapCredentials({
      url: "ws://127.0.0.1:18789",
      client: MOBILE_PAIRING_CLIENT,
      identity,
      hello: bootstrapHello("node-token-1", "operator-token-1"),
    });
    const nodeTransition = persistHelloCredential({
      credentials,
      role: "node",
      hello: {
        type: "hello-ok",
        auth: {
          role: "node",
          scopes: [],
          deviceToken: "node-token-2",
        },
      },
    });
    const nextRequest = buildConnectRequest({
      challengePayload: { nonce: "nonce-2", ts: 1_700_000_000_002 },
      client: MOBILE_PAIRING_CLIENT,
      mode: "node",
      role: "node",
      scopes: credentials.node.scopes,
      auth: { token: credentials.node.token },
      identity,
    });
    const nextParams = nextRequest.params as { auth: Record<string, string> };

    expect(nodeTransition).toEqual({
      role: "node",
      scopes: [],
      usedTokenHash: tokenHash("node-token-1"),
      storedTokenHash: tokenHash("node-token-2"),
      deviceTokenReturned: true,
      tokenRotated: true,
    });
    expect(credentials.node).toEqual({ token: "node-token-2", scopes: [] });
    expect(nextParams.auth).toEqual({ token: "node-token-2" });
  });

  it("requires clean paired device and node stores for the mobile identity", () => {
    expect(
      validatePairingAudit({
        devicePairing: { pending: [], paired: [{ deviceId: "device-1" }] },
        nodePairing: { pending: [], paired: [{ nodeId: "device-1" }] },
        deviceId: "device-1",
      }),
    ).toEqual({
      pendingDevicePairingCount: 0,
      pendingNodePairingCount: 0,
      pairedDevicePresent: true,
      pairedNodePresent: true,
    });
    expect(() =>
      validatePairingAudit({
        devicePairing: { pending: [], paired: [{ deviceId: "device-1" }] },
        nodePairing: { pending: [{ nodeId: "device-1" }], paired: [] },
        deviceId: "device-1",
      }),
    ).toThrow(/node pairing left a pending request/);
  });

  it("completes legacy baseline node pairing only for the bootstrapped identity", async () => {
    const approvalRequest = buildConnectRequest({
      challengePayload: { nonce: "nonce-approval", ts: 1_700_000_000_003 },
      client: MOBILE_PAIRING_AUDIT_CLIENT,
      mode: "backend",
      role: "operator",
      scopes: [...MOBILE_PAIRING_APPROVAL_SCOPES],
      auth: { password: "approval-password" },
    });
    expect(approvalRequest.params).toMatchObject({
      client: { id: "gateway-client", mode: "backend" },
      role: "operator",
      scopes: ["operator.pairing", "operator.admin"],
      auth: { password: "approval-password" },
    });
    expect(approvalRequest.params).not.toHaveProperty("device");

    expect(
      inspectBaselineNodePairing(
        {
          pending: [{ requestId: "request-1", nodeId: "device-1" }],
          paired: [],
        },
        "device-1",
      ),
    ).toEqual({ pendingRequestId: "request-1", paired: false });
    expect(
      inspectBaselineNodePairing(
        {
          pending: [],
          paired: [{ nodeId: "device-1" }],
        },
        "device-1",
      ),
    ).toEqual({ pendingRequestId: null, paired: true });
    expect(() =>
      inspectBaselineNodePairing(
        {
          pending: [{ requestId: "request-other", nodeId: "device-2" }],
          paired: [],
        },
        "device-1",
      ),
    ).toThrow(/unexpected pending request/);

    const observed: string[] = [];
    const states = [
      { pending: [], paired: [] },
      { pending: [{ requestId: "request-1", nodeId: "device-1" }], paired: [] },
      { pending: [], paired: [{ nodeId: "device-1" }] },
    ];
    await approveBaselineNodePairing({
      deviceId: "device-1",
      listPairings: async () => {
        observed.push("list");
        return states.shift();
      },
      approvePairing: async (requestId) => {
        observed.push(`approve:${requestId}`);
      },
      wait: async () => {
        observed.push("wait");
      },
    });
    expect(observed).toEqual(["list", "wait", "list", "approve:request-1", "wait", "list"]);
  });

  it("emits only redacted reconnect evidence", () => {
    const nodeToken = "node-token-must-not-leak";
    const operatorToken = "operator-token-must-not-leak";
    const credentials = extractBootstrapCredentials({
      url: "ws://127.0.0.1:18789",
      client: MOBILE_PAIRING_CLIENT,
      identity: createMobilePairingIdentity(),
      hello: bootstrapHello(nodeToken, operatorToken),
    });
    const node = persistHelloCredential({
      credentials,
      role: "node",
      hello: {
        type: "hello-ok",
        auth: { role: "node", scopes: [], deviceToken: "rotated-node-token" },
      },
    });
    const operator = persistHelloCredential({
      credentials,
      role: "operator",
      hello: {
        type: "hello-ok",
        auth: {
          role: "operator",
          scopes: credentials.operator.scopes,
          deviceToken: operatorToken,
        },
      },
    });
    const serialized = JSON.stringify(
      buildRedactedEvidence({
        phase: "candidate-restart",
        credentials,
        node,
        operator,
        pairing: {
          pendingDevicePairingCount: 0,
          pendingNodePairingCount: 0,
          pairedDevicePresent: true,
          pairedNodePresent: true,
        },
      }),
    );

    expect(serialized).not.toContain(nodeToken);
    expect(serialized).not.toContain(operatorToken);
    expect(serialized).not.toContain(credentials.identity.privateKeyPem);
    expect(serialized).not.toContain(credentials.client.instanceId);
    expect(JSON.parse(serialized)).toMatchObject({
      phase: "candidate-restart",
      ok: true,
      connectedDevicePresent: true,
      pendingPairingCount: 0,
      pendingDevicePairingCount: 0,
      pendingNodePairingCount: 0,
      pairedDevicePresent: true,
      pairedNodePresent: true,
      missingPasswordReason: true,
      missingPasswordClose1008: true,
      credentials: {
        node: {
          usedTokenHash: tokenHash(nodeToken),
          storedTokenHash: tokenHash("rotated-node-token"),
          deviceTokenReturned: true,
          tokenRotated: true,
        },
        operator: {
          usedTokenHash: tokenHash(operatorToken),
          storedTokenHash: tokenHash(operatorToken),
          deviceTokenReturned: true,
          tokenRotated: false,
        },
      },
    });
  });

  it("keeps secrets out of CLI failures", () => {
    const password = "password-must-not-leak";
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "./scripts/tsx.mjs",
        CLIENT_PATH,
        "unknown",
        "--package-root",
        "/tmp/openclaw-package",
        "--credentials",
        "/tmp/openclaw-credentials.json",
        "--evidence",
        "/tmp/openclaw-evidence.json",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, GATEWAY_AUTH_PASSWORD_REF: password },
      },
    );

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).not.toContain(password);
    expect(result.stderr).toContain("unknown mobile pairing client command");
  });

  it("checks both candidate starts before Doctor and the final phase after Doctor", () => {
    const source = readFileSync(RUNNER_PATH, "utf8");
    const bootstrap = source.indexOf("phase bootstrap-mobile-pairing bootstrap_mobile_pairing");
    const update = source.indexOf("phase update-candidate update_candidate");
    const candidateFirst = source.indexOf("phase mobile-pairing-candidate-first");
    const candidateRestart = source.indexOf("phase mobile-pairing-candidate-restart");
    const doctor = source.indexOf("phase doctor run_doctor");
    const final = source.indexOf("phase mobile-pairing-final");

    expect(bootstrap).toBeGreaterThan(-1);
    expect(bootstrap).toBeLessThan(update);
    expect(update).toBeLessThan(candidateFirst);
    expect(candidateFirst).toBeLessThan(candidateRestart);
    expect(candidateRestart).toBeLessThan(doctor);
    expect(doctor).toBeLessThan(final);
  });

  it("fails pairing phases when gateway teardown fails", () => {
    const source = readFileSync(RUNNER_PATH, "utf8");
    const bootstrap = source.slice(
      source.indexOf("bootstrap_mobile_pairing()"),
      source.indexOf("verify_mobile_pairing()"),
    );
    const reconnect = source.slice(
      source.indexOf("verify_mobile_pairing_once()"),
      source.indexOf("source scripts/e2e/lib/upgrade-survivor/update-restart-auth.sh"),
    );

    for (const body of [bootstrap, reconnect]) {
      expect(body).toContain("stop_gateway || stop_status=$?");
      expect(body).toContain('return "$stop_status"');
    }
  });
});
