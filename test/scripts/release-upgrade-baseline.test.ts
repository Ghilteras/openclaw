import { describe, expect, it } from "vitest";
import {
  parseArgs,
  resolveReleaseUpgradeBaseline,
} from "../../scripts/lib/release-upgrade-baseline.mjs";

describe("release upgrade baseline resolver", () => {
  it("rejects short flag values before resolving baselines", () => {
    expect(() => parseArgs(["--candidate-version", "-h"])).toThrow(
      "missing value for --candidate-version",
    );
    expect(() => parseArgs(["--versions-json", "-h"])).toThrow("missing value for --versions-json");
  });

  it.each([
    { context: "main", candidate: "2026.8.1", targetContextRef: "", expected: "2026.7.1-2" },
    {
      context: "release branch",
      candidate: "2026.8.1",
      targetContextRef: "release/2026.8.1",
      expected: "2026.7.1-2",
    },
    {
      context: "release tag",
      candidate: "2026.8.1",
      targetContextRef: "v2026.8.1",
      expected: "2026.7.1-2",
    },
    {
      context: "prerelease",
      candidate: "2026.8.1-beta.2",
      targetContextRef: "release/2026.8.1",
      expected: "2026.7.1-2",
    },
    {
      context: "alpha",
      candidate: "2026.8.1-alpha.2",
      targetContextRef: "tideclaw/alpha/2026-09-03-0000Z",
      expected: "2026.7.1-2",
    },
    {
      context: "correction",
      candidate: "2026.7.1-2",
      targetContextRef: "release/2026.7.1",
      expected: "2026.7.1-1",
    },
    {
      context: "first correction",
      candidate: "2026.7.1-1",
      targetContextRef: "release/2026.7.1",
      expected: "2026.7.1",
    },
  ])(
    "selects the newest older stable release for $context",
    ({ candidate, targetContextRef, expected }) => {
      expect(
        resolveReleaseUpgradeBaseline(
          candidate,
          [
            "2026.8.1-beta.1",
            "2026.7.1-1",
            "2026.9.1",
            "2026.8.1-alpha.1",
            "2026.7.1-2",
            "2026.6.34",
            "2026.7.1",
            "2026.8.1",
            "2026.7.1-beta.2",
            "2026.7.1-2",
          ],
          { targetContextRef },
        ),
      ).toBe(`openclaw@${expected}`);
    },
  );

  it.each([
    ["2026.8.1-beta.2", ["2026.8.1-beta.1", "2026.8.1"]],
    ["2026.7.1", ["2026.7.1", "2026.8.1"]],
    ["2026.7.1", ["2026.8.1", "invalid"]],
    ["2026.7.1", []],
  ])("rejects missing stable baselines for %s", (candidate, versions) => {
    expect(() => resolveReleaseUpgradeBaseline(candidate, versions)).toThrow(
      "no published stable OpenClaw baseline",
    );
  });

  it("selects an older final release from the frozen extended-stable line", () => {
    expect(
      resolveReleaseUpgradeBaseline(
        "2026.6.35",
        ["2026.6.34", "2026.6.33", "2026.6.35", "2026.7.1", "2026.6.34-1"],
        {
          targetContextRef: "extended-stable/2026.6.33",
        },
      ),
    ).toBe("openclaw@2026.6.34");
  });

  it("honors an explicit published predecessor from the frozen extended-stable line", () => {
    expect(
      resolveReleaseUpgradeBaseline("2026.6.35", ["2026.6.33", "2026.6.34", "2026.6.35"], {
        previousVersion: "2026.6.33",
        targetContextRef: "extended-stable/2026.6.33",
      }),
    ).toBe("openclaw@2026.6.33");
  });

  it.each(["2026.6.35", "2026.6.34-1", "2026.7.1", "2026.6.32", "2026.6.31"])(
    "rejects an incompatible explicit frozen baseline %s",
    (previousVersion) => {
      expect(() =>
        resolveReleaseUpgradeBaseline("2026.6.35", ["2026.6.33", "2026.6.34", "2026.6.35"], {
          previousVersion,
          targetContextRef: "extended-stable/2026.6.33",
        }),
      ).toThrow("previous_version");
    },
  );

  it.each([
    ["2026.7.1", "extended-stable/2026.6.33"],
    ["2026.6.35-beta.1", "extended-stable/2026.6.33"],
    ["2026.6.33", "extended-stable/2026.6.33"],
    ["2026.6.35", "extended-stable/2026.6.34"],
  ])(
    "rejects incompatible frozen extended-stable targets",
    (candidateVersion, targetContextRef) => {
      expect(() =>
        resolveReleaseUpgradeBaseline(candidateVersion, ["2026.6.34", "2026.6.33"], {
          targetContextRef,
        }),
      ).toThrow();
    },
  );
});
