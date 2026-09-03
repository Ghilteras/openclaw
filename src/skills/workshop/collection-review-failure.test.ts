import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CronStoredJob } from "../../cron/types.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { getSkillsSnapshotVersion } from "../runtime/refresh-state.js";
import { latestCommittedBackupId } from "./collection-backup.js";
import { resolveSkillCollectionBackupRoot } from "./collection-paths.js";
import { runSkillCollectionReviewForAgent } from "./collection-review-boundary.js";
import {
  listSkillCollectionReviewOutcomes,
  readSkillReviewOutcomes,
} from "./collection-review-state.js";
import { resolveWorkshopSkillsDir } from "./skills-root.js";

describe("failed Skill Workshop collection reviews", () => {
  it("preserves the prior restore point when a started turn fails unchanged", async () => {
    const testState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-skill-collection-review-unchanged-error-",
    });
    const skillsRoot = resolveWorkshopSkillsDir({}, "main", testState.env);
    try {
      await writeSkill(skillsRoot, "procedure", "Procedure", "# Procedure\n");
      const firstReview = await runSkillCollectionReviewForAgent({
        config: { skills: { workshop: { autonomous: { mode: "auto" } } } },
        agentId: "main",
        job: createReviewJob("skill-review-unchanged-error-initial"),
        env: testState.env,
        runTurn: async () => ({ status: "ok", summary: "reviewed", outputText: "" }),
      });
      expect(firstReview.status).toBe("ok");

      const backupRoot = resolveSkillCollectionBackupRoot({}, "main", testState.env);
      const backupEntriesBefore = await fs.readdir(backupRoot);
      const backupIdBefore = await latestCommittedBackupId(backupRoot);
      const historyBefore = listSkillCollectionReviewOutcomes("main", { env: testState.env });
      const versionBefore = getSkillsSnapshotVersion();
      const error = "started review turn failed";
      const result = await runSkillCollectionReviewForAgent({
        config: { skills: { workshop: { autonomous: { mode: "auto" } } } },
        agentId: "main",
        job: createReviewJob("skill-review-unchanged-error"),
        env: testState.env,
        runTurn: async () => ({ status: "error", error, summary: error }),
      });

      expect(result).toMatchObject({ status: "error", error, summary: error });
      expect(readSkillReviewOutcomes({ env: testState.env }).collectionReviews.main).toEqual(
        expect.objectContaining({ error }),
      );
      expect(getSkillsSnapshotVersion()).toBe(versionBefore);
      expect(listSkillCollectionReviewOutcomes("main", { env: testState.env })).toHaveLength(
        historyBefore.length,
      );
      expect(await latestCommittedBackupId(backupRoot)).toBe(backupIdBefore);
      expect(await fs.readdir(backupRoot)).toEqual(backupEntriesBefore);
      expect((await fs.readdir(backupRoot)).some((entry) => entry.startsWith(".pending-"))).toBe(
        false,
      );
    } finally {
      await testState.cleanup();
    }
  });
});

function createReviewJob(id: string): CronStoredJob {
  return {
    id,
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
}

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
