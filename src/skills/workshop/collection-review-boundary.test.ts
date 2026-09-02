import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CronStoredJob } from "../../cron/types.js";
import type { PluginHookSkillChangedEvent } from "../../plugins/hook-types.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { getSkillsSnapshotVersion } from "../runtime/refresh-state.js";
import { restoreLatestSkillCollectionBackup } from "./collection-reconcile.js";
import { runSkillCollectionReviewForAgent } from "./collection-review-boundary.js";
import {
  listSkillCollectionReviewOutcomes,
  readSkillReviewOutcomes,
} from "./collection-review-state.js";
import { resolveWorkshopSkillsDir } from "./skills-root.js";

type ReviewChange = Pick<PluginHookSkillChangedEvent, "action">;

const dispatchCommittedSkillChangeBestEffort = vi.hoisted(() =>
  vi.fn(async (_change: ReviewChange) => {}),
);
const snapshotCommittedSkillArtifactBestEffort = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../lifecycle/skill-change-hook.js", () => ({
  dispatchCommittedSkillChangeBestEffort,
  hasCommittedSkillChangeHooks: () => true,
  snapshotCommittedSkillArtifactBestEffort,
}));

const tempDirs = createTrackedTempDirs();

beforeEach(() => {
  dispatchCommittedSkillChangeBestEffort.mockClear();
  snapshotCommittedSkillArtifactBestEffort.mockClear();
});

describe("skill collection review boundary", () => {
  it("snapshots, scans, records tree changes, and restores the pre-turn tree", async () => {
    const testState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-skill-collection-review-boundary-",
    });
    const workspaceDir = await tempDirs.make("openclaw-skill-collection-review-workspace-");
    const skillsRoot = resolveWorkshopSkillsDir(testState.env);
    const config: OpenClawConfig = {
      skills: { workshop: { autonomous: { mode: "auto" } } },
    };
    const job = {
      id: "skill-review",
      declarationKey: "skill-collection-review:main",
      name: "skill review",
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 1,
      agentId: "main",
      schedule: { kind: "every", everyMs: 604_800_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: {
        kind: "agentTurn",
        message: "review",
        toolsAllow: ["read", "write", "edit", "apply_patch", "exec", "process"],
      },
      state: {},
    } satisfies CronStoredJob;

    try {
      await writeSkill(skillsRoot, "keep", "Keep procedure", "# Keep\n");
      await writeSkill(skillsRoot, "rewrite", "Rewrite procedure", "# Before\n");
      await writeSkill(skillsRoot, "drop", "Stale fragment", "# Drop\n");
      await writeSkill(skillsRoot, "silent-drop", "Unclear fragment", "# Silent\n");
      await writeSkill(skillsRoot, "unsafe", "Unsafe procedure", "# Unsafe\n");
      const beforeVersion = getSkillsSnapshotVersion();

      const result = await runSkillCollectionReviewForAgent({
        config,
        agentId: "main",
        job,
        env: testState.env,
        runTurn: async ({ job: reviewJob, message, executionRoot }) => {
          expect(reviewJob.payload.kind).toBe("agentTurn");
          expect(reviewJob.payload).toEqual({
            kind: "agentTurn",
            message,
            toolsAllow: ["read", "write", "edit", "apply_patch", "exec", "process"],
          });
          expect(message).toContain(`Workshop directory: ${skillsRoot}`);
          expect(message).toContain("Total skills: 5");
          expect(message).toContain("List the Workshop directory for the full inventory");
          expect(message).toContain("Recorded usage (name useCount lastUsedDaysAgo):");
          expect(message).not.toContain("Current Workshop skills");
          expect(message).not.toContain("description");
          expect(executionRoot).toEqual({
            workspaceDir: skillsRoot,
            cwd: skillsRoot,
            sessionRoot: skillsRoot,
            requireWritableSandbox: true,
          });
          await fs.writeFile(
            path.join(skillsRoot, "rewrite", "SKILL.md"),
            "---\nname: rewrite\ndescription: Rewritten procedure\n---\n\n# After\n",
          );
          await fs.rm(path.join(skillsRoot, "drop"), { recursive: true });
          await fs.rm(path.join(skillsRoot, "silent-drop"), { recursive: true });
          await fs.mkdir(path.join(skillsRoot, "added"), { recursive: true });
          await fs.writeFile(
            path.join(skillsRoot, "added", "SKILL.md"),
            "---\nname: added\ndescription: Added procedure\n---\n\n# Added\n",
          );
          await fs.writeFile(
            path.join(skillsRoot, "unsafe", "SKILL.md"),
            '---\nname: unsafe\ndescription: Unsafe procedure\n---\n\n```js\nconst cp = require("child_process");\ncp.exec("bad");\n```\n',
          );
          return {
            status: "ok",
            summary: "reviewed",
            outputText: "DROP drop: stale fragment",
          };
        },
      });

      expect(result.status).toBe("error");
      expect(result.error).toBe(
        "Skill collection review completed with errors: security scan rejected unsafe",
      );
      expect(getSkillsSnapshotVersion()).toBeGreaterThan(beforeVersion);
      expect(listSkillCollectionReviewOutcomes({ env: testState.env })[0]).toMatchObject({
        kept: ["keep", "unsafe"],
        written: ["added", "rewrite"],
        dropped: [
          { name: "drop", reason: "stale fragment" },
          { name: "silent-drop", reason: "no reason given" },
        ],
      });
      await expect(
        fs.readFile(path.join(skillsRoot, "unsafe", "SKILL.md"), "utf8"),
      ).resolves.toContain("# Unsafe");

      const restored = await restoreLatestSkillCollectionBackup({
        workspaceDir,
        env: testState.env,
      });
      expect(restored.restored).toContain("drop");
      await expect(fs.access(path.join(skillsRoot, "added"))).rejects.toThrow();
      await expect(
        fs.readFile(path.join(skillsRoot, "rewrite", "SKILL.md"), "utf8"),
      ).resolves.toContain("# Before");
      await expect(
        fs.readFile(path.join(skillsRoot, "drop", "SKILL.md"), "utf8"),
      ).resolves.toContain("# Drop");
    } finally {
      await testState.cleanup();
      await tempDirs.cleanup();
    }
  });

  it("records a failed turn after scanning and keeps partial edits in the review history", async () => {
    const testState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-skill-collection-review-error-",
    });
    const skillsRoot = resolveWorkshopSkillsDir(testState.env);
    const skillFile = path.join(skillsRoot, "partial", "SKILL.md");
    const job = {
      id: "skill-review-error",
      declarationKey: "skill-collection-review:main",
      name: "skill review",
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 1,
      agentId: "main",
      schedule: { kind: "every", everyMs: 604_800_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "review" },
      state: {},
    } satisfies CronStoredJob;
    try {
      await writeSkill(skillsRoot, "partial", "Partial procedure", "# Before\n");
      await writeSkill(skillsRoot, "removed", "Removed procedure", "# Removed\n");
      const result = await runSkillCollectionReviewForAgent({
        config: { skills: { workshop: { autonomous: { mode: "auto" } } } },
        agentId: "main",
        job,
        env: testState.env,
        runTurn: async () => {
          await fs.writeFile(
            skillFile,
            "---\nname: partial\ndescription: Partial procedure\n---\n\n# After\n",
          );
          await fs.rm(path.join(skillsRoot, "removed"), { recursive: true });
          await writeSkill(skillsRoot, "added", "Added procedure", "# Added\n");
          return { status: "error", error: "turn failed", summary: "turn failed" };
        },
      });

      expect(result).toMatchObject({
        status: "error",
        error: "Skill collection review failed: turn failed",
      });
      expect(listSkillCollectionReviewOutcomes({ env: testState.env })[0]).toMatchObject({
        written: ["added", "partial"],
        dropped: [{ name: "removed" }],
      });
      expect(readSkillReviewOutcomes({ env: testState.env }).collectionReviews.workshop).toEqual(
        expect.objectContaining({ error: "Skill collection review failed: turn failed" }),
      );
      expect(
        readSkillReviewOutcomes({ env: testState.env }).collectionReviews.workshop,
      ).not.toHaveProperty("succeededAtMs");
      expect(dispatchCommittedSkillChangeBestEffort).toHaveBeenCalledWith(
        expect.objectContaining({ action: "updated" }),
      );
      expect(
        dispatchCommittedSkillChangeBestEffort.mock.calls.map(([change]) => change.action),
      ).toEqual(["created", "updated", "removed"]);
    } finally {
      await testState.cleanup();
      await tempDirs.cleanup();
    }
  });

  it("records a sandbox refusal without committing a backup or advancing the snapshot", async () => {
    const testState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-skill-collection-review-sandbox-",
    });
    const skillsRoot = resolveWorkshopSkillsDir(testState.env);
    const beforeVersion = getSkillsSnapshotVersion();
    const job = {
      id: "skill-review-sandbox",
      declarationKey: "skill-collection-review:main",
      name: "skill review",
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 1,
      agentId: "main",
      schedule: { kind: "every", everyMs: 604_800_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "review" },
      state: {},
    } satisfies CronStoredJob;
    try {
      await writeSkill(skillsRoot, "procedure", "Procedure", "# Procedure\n");
      const result = await runSkillCollectionReviewForAgent({
        config: { skills: { workshop: { autonomous: { mode: "auto" } } } },
        agentId: "main",
        job,
        env: testState.env,
        runTurn: async () => {
          throw new Error("sandbox workspace is not read-write; collection review skipped");
        },
      });

      expect(result.status).toBe("error");
      expect(readSkillReviewOutcomes({ env: testState.env }).collectionReviews.workshop).toEqual(
        expect.objectContaining({
          error: "sandbox workspace is not read-write; collection review skipped",
        }),
      );
      expect(getSkillsSnapshotVersion()).toBe(beforeVersion);
      expect(listSkillCollectionReviewOutcomes({ env: testState.env })).toEqual([]);
    } finally {
      await testState.cleanup();
      await tempDirs.cleanup();
    }
  });
});

async function writeSkill(
  skillsRoot: string,
  name: string,
  description: string,
  body: string,
): Promise<void> {
  const skillDir = path.join(skillsRoot, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`,
  );
}
