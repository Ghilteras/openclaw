import { describe, expect, it } from "vitest";
import {
  parseWorkerSkillResourceGeneration,
  parseWorkerSkillResourceLocator,
} from "./skill-resource-protocol.js";

const resourceId = "abcdef0123456789".repeat(2);

describe("worker skill resource locators", () => {
  it.each(["/worker/session/.3.skill-resources-", "C:\\worker\\session\\.3.skill-resources-"])(
    "preserves the remote host path and full inode identity %s",
    (prefix) => {
      const locator = {
        resourceId,
        identity: "1:18446744073709551615",
        root: `${prefix}${resourceId}`,
      };
      expect(parseWorkerSkillResourceLocator(locator)).toEqual(locator);
    },
  );

  it.each([
    { resourceId: "../outside" },
    { identity: "1:NaN" },
    { root: "relative/root" },
    { root: "/tmp/\0outside" },
    { root: "/" + "a".repeat(1_024) },
    { extra: true },
  ])("rejects invalid or open locator %#", (invalid) => {
    expect(() =>
      parseWorkerSkillResourceLocator({
        resourceId,
        identity: "1:2",
        root: `/worker/.3.skill-resources-${resourceId}`,
        ...invalid,
      }),
    ).toThrow("Invalid skill resource location");
  });
});

describe("worker skill resource retention identity", () => {
  it.each([0, 3, Number.MAX_SAFE_INTEGER])("recognizes exact generation %s", (generation) => {
    expect(parseWorkerSkillResourceGeneration(`.${generation}.skill-resources-${resourceId}`)).toBe(
      generation,
    );
  });

  it.each([
    `.03.skill-resources-${resourceId}`,
    `.-1.skill-resources-${resourceId}`,
    `.9007199254740992.skill-resources-${resourceId}`,
    `.3.skill-resources-${resourceId.toUpperCase()}`,
    `.3.skill-resources-short`,
    `.3.skill-resources-${resourceId}/child`,
    `.3.workspace-transfer-${resourceId}`,
    `3`,
    `.openclaw-worker`,
  ])("does not collect unrelated or ambiguous name %s", (name) => {
    expect(parseWorkerSkillResourceGeneration(name)).toBeUndefined();
  });
});
