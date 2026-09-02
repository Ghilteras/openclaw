import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CronStoredJob } from "../../cron/types.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { restoreLatestSkillCollectionBackup } from "./collection-reconcile.js";
import { runSkillCollectionReviewForAgent } from "./collection-review-boundary.js";
import { resolveWorkshopSkillsDir } from "./skills-root.js";

const dispatchCommittedSkillChangeBestEffort = vi.hoisted(() => vi.fn(async () => {}));
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

describe("skill collection restore", () => {
  it("refuses to overwrite a skill changed after the review", async () => {
    const testState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-skill-collection-restore-state-",
    });
    const workspaceDir = await tempDirs.make("openclaw-skill-collection-restore-");
    const skillsRoot = resolveWorkshopSkillsDir(testState.env);
    const skillFile = path.join(skillsRoot, "procedure", "SKILL.md");
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
      payload: { kind: "agentTurn", message: "review" },
      state: {},
    } satisfies CronStoredJob;
    try {
      await fs.mkdir(path.dirname(skillFile), { recursive: true });
      await fs.writeFile(
        skillFile,
        "---\nname: procedure\ndescription: Procedure\n---\n\n# Original\n",
      );
      await runSkillCollectionReviewForAgent({
        config: { skills: { workshop: { autonomous: { mode: "auto" } } } },
        agentId: "main",
        job,
        env: testState.env,
        runTurn: async () => {
          await fs.writeFile(
            skillFile,
            "---\nname: procedure\ndescription: Procedure\n---\n\n# Reviewed\n",
          );
          return { status: "ok", summary: "reviewed", outputText: "done" };
        },
      });
      await fs.appendFile(skillFile, "\nOperator edit.\n");

      await expect(
        restoreLatestSkillCollectionBackup({ workspaceDir, env: testState.env }),
      ).rejects.toThrow("changed after cleanup");
      await expect(fs.readFile(skillFile, "utf8")).resolves.toContain("Operator edit.");
    } finally {
      await testState.cleanup();
      await tempDirs.cleanup();
    }
  });

  it("dispatches committed skill changes after restoring the collection", async () => {
    const testState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-skill-collection-restore-hooks-",
    });
    const workspaceDir = await tempDirs.make("openclaw-skill-collection-restore-hooks-");
    const skillsRoot = resolveWorkshopSkillsDir(testState.env);
    const skillFile = path.join(skillsRoot, "procedure", "SKILL.md");
    const job = {
      id: "skill-review-hooks",
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
      await fs.mkdir(path.dirname(skillFile), { recursive: true });
      await fs.writeFile(
        skillFile,
        "---\nname: procedure\ndescription: Procedure\n---\n\n# Before\n",
      );
      await runSkillCollectionReviewForAgent({
        config: { skills: { workshop: { autonomous: { mode: "auto" } } } },
        agentId: "main",
        job,
        env: testState.env,
        runTurn: async () => {
          await fs.writeFile(
            skillFile,
            "---\nname: procedure\ndescription: Procedure\n---\n\n# Reviewed\n",
          );
          return { status: "ok", summary: "reviewed", outputText: "done" };
        },
      });
      dispatchCommittedSkillChangeBestEffort.mockClear();
      await fs.mkdir(path.join(skillsRoot, "late"), { recursive: true });
      await fs.writeFile(
        path.join(skillsRoot, "late", "SKILL.md"),
        "---\nname: late\ndescription: Late procedure\n---\n\n# Late\n",
      );

      await restoreLatestSkillCollectionBackup({ workspaceDir, env: testState.env });

      await expect(fs.access(path.join(skillsRoot, "late", "SKILL.md"))).resolves.toBeUndefined();
      expect(dispatchCommittedSkillChangeBestEffort).toHaveBeenCalledWith(
        expect.objectContaining({ action: "updated", source: "workshop", workspaceDir }),
      );
    } finally {
      await testState.cleanup();
      await tempDirs.cleanup();
    }
  });
});
