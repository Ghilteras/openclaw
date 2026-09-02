import { describe, expect, it, vi } from "vitest";
import {
  createCronCreatorAuthorityRunScope,
  mintCronCreatorAuthorityGrant,
  revokeCronCreatorAuthorityRunScope,
} from "./cron-creator-authority-grant.js";

// Legacy SDK callbacks can still hold a capture scope. Its lifecycle must close
// cleanly even though scheduled jobs no longer consume or replay captured grants.
describe("legacy cron creator scope cleanup", () => {
  it("revokes retained grants and rejects captures after run settlement", () => {
    const scope = createCronCreatorAuthorityRunScope("run-1");
    mintCronCreatorAuthorityGrant(scope);
    expect(scope.grantTokens.size).toBe(1);

    revokeCronCreatorAuthorityRunScope(scope);

    expect(scope.signal.aborted).toBe(true);
    expect(scope.grantTokens.size).toBe(0);
    expect(() => mintCronCreatorAuthorityGrant(scope)).toThrow(
      "Configured MCP cron authority is no longer active",
    );
  });

  it("releases a legacy grant when its exact operation aborts", () => {
    const scope = createCronCreatorAuthorityRunScope("run-1");
    const operation = new AbortController();
    mintCronCreatorAuthorityGrant(scope, operation.signal);

    operation.abort(new Error("tool call timed out"));

    expect(scope.grantTokens.size).toBe(0);
    expect(() => mintCronCreatorAuthorityGrant(scope, operation.signal)).toThrow(
      "Configured MCP cron authority is no longer active",
    );
    revokeCronCreatorAuthorityRunScope(scope);
  });

  it("cleans operation abort listeners on run revocation", () => {
    const scope = createCronCreatorAuthorityRunScope("run-revoke");
    const operation = new AbortController();
    const removeListener = vi.spyOn(operation.signal, "removeEventListener");
    mintCronCreatorAuthorityGrant(scope, operation.signal);

    revokeCronCreatorAuthorityRunScope(scope);

    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});
