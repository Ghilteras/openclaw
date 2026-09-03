import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { pathExists } from "../../infra/fs-safe.js";
import type { PluginHookSkillArtifact } from "../../plugins/hook-types.js";
import {
  dispatchCommittedSkillChangeBestEffort,
  hasCommittedSkillChangeHooks,
  snapshotCommittedSkillArtifactBestEffort,
} from "../lifecycle/skill-change-hook.js";
import { loadSingleSkillDirectory } from "../loading/local-loader.js";
import { bumpSkillsSnapshotVersion } from "../runtime/refresh-state.js";
import { latestCommittedBackupId, readCollectionBackupManifest } from "./collection-backup.js";
import type { SkillCollectionRestoreResult } from "./collection-contracts.js";
import { resolveSkillCollectionBackupRoot } from "./collection-paths.js";
import { restoreSkillCollectionBackupTransaction } from "./collection-rollback.js";
import { readSkillProposalTargetTreeSha256 } from "./proposal-bundle.js";
import { resolveWorkshopSkillsDir } from "./skills-root.js";
import { withSkillCollectionLock } from "./target-lock.js";
import { listWritableWorkshopSkillSummaries } from "./workspace-skill-read.js";

export async function restoreLatestSkillCollectionBackup(params: {
  workspaceDir: string;
  config: OpenClawConfig;
  agentId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<SkillCollectionRestoreResult> {
  const commit = await withSkillCollectionLock(
    async (lease) => {
      const skillsRoot = resolveWorkshopSkillsDir(params.config, params.agentId, params.env);
      const backupRoot = resolveSkillCollectionBackupRoot(
        params.config,
        params.agentId,
        params.env,
      );
      const backupId = await latestCommittedBackupId(backupRoot);
      if (!backupId) {
        throw new Error("No skill collection backup is available.");
      }
      const backupDir = path.join(backupRoot, backupId);
      const manifest = await readCollectionBackupManifest({ backupDir, backupId, skillsRoot });
      lease.assertOwned();
      for (const relativeDir of manifest.resultSkillDirs) {
        const currentHash = await readSkillProposalTargetTreeSha256(
          path.join(skillsRoot, relativeDir),
        );
        if (currentHash !== manifest.resultSkillHashes[relativeDir]) {
          throw new Error(`Skill collection changed after cleanup: ${relativeDir}`);
        }
      }
      for (const relativeDir of manifest.skillDirs) {
        if (
          !manifest.resultSkillDirs.includes(relativeDir) &&
          (await pathExists(path.join(skillsRoot, relativeDir)))
        ) {
          throw new Error(`Skill collection changed after cleanup: ${relativeDir}`);
        }
      }
      lease.assertOwned();
      const currentSkills = listWritableWorkshopSkillSummaries({
        config: params.config,
        agentId: params.agentId,
        env: params.env,
      });
      lease.assertOwned();
      const affectedDirs = [...new Set([...manifest.skillDirs, ...manifest.resultSkillDirs])];
      const shouldDispatch = hasCommittedSkillChangeHooks();
      const before = new Map<string, PluginHookSkillArtifact | undefined>();
      const affectedSkills: Array<{
        relativeDir: string;
        skillDir: string;
        skillKey: string;
        liveExists: boolean;
      }> = [];
      for (const relativeDir of affectedDirs) {
        lease.assertOwned();
        const skillDir = path.join(skillsRoot, relativeDir);
        const liveExists = await pathExists(skillDir);
        const keySourceDir = liveExists ? skillDir : path.join(backupDir, "skills", relativeDir);
        const loaded = loadSingleSkillDirectory({
          skillDir: keySourceDir,
          source: "openclaw-workshop",
          rootRealPath: await fs.realpath(keySourceDir),
        });
        if (!loaded) {
          throw new Error(`Could not load Workshop skill: ${relativeDir}`);
        }
        const affectedSkill = {
          relativeDir,
          skillDir,
          skillKey: loaded.skill.name,
          liveExists,
        };
        affectedSkills.push(affectedSkill);
        if (shouldDispatch) {
          before.set(
            relativeDir,
            await snapshotCommittedSkillArtifactBestEffort({
              skillDir,
              skillKey: affectedSkill.skillKey,
              source: "workshop",
            }),
          );
        }
      }
      lease.assertOwned();
      await restoreSkillCollectionBackupTransaction({
        skillsRoot,
        backupDir,
        skillDirs: manifest.skillDirs,
        resultSkillDirs: manifest.resultSkillDirs,
      });
      lease.assertOwned();
      bumpSkillsSnapshotVersion({ reason: "workshop" });
      lease.assertOwned();
      const restoredSkills = listWritableWorkshopSkillSummaries({
        config: params.config,
        agentId: params.agentId,
        env: params.env,
      });
      const changes: Array<{
        action: "created" | "updated" | "removed";
        before?: PluginHookSkillArtifact;
        after?: PluginHookSkillArtifact;
      }> = [];
      if (shouldDispatch) {
        for (const affectedSkill of affectedSkills) {
          lease.assertOwned();
          const afterExists = await pathExists(affectedSkill.skillDir);
          if (!affectedSkill.liveExists && !afterExists) {
            continue;
          }
          changes.push({
            action: !affectedSkill.liveExists ? "created" : afterExists ? "updated" : "removed",
            before: before.get(affectedSkill.relativeDir),
            after: afterExists
              ? await snapshotCommittedSkillArtifactBestEffort({
                  skillDir: affectedSkill.skillDir,
                  skillKey: affectedSkill.skillKey,
                  source: "workshop",
                })
              : undefined,
          });
        }
      }
      return {
        result: {
          backupId,
          restored: restoredSkills
            .filter((skill) =>
              manifest.skillDirs.includes(path.relative(skillsRoot, skill.baseDir)),
            )
            .map((skill) => skill.name),
          removed: currentSkills
            .filter(
              (skill) =>
                manifest.resultSkillDirs.includes(path.relative(skillsRoot, skill.baseDir)) &&
                !manifest.skillDirs.includes(path.relative(skillsRoot, skill.baseDir)),
            )
            .map((skill) => skill.name),
        },
        changes,
      };
    },
    { config: params.config, agentId: params.agentId, ...(params.env ? { env: params.env } : {}) },
  );
  for (const change of commit.changes) {
    await dispatchCommittedSkillChangeBestEffort({
      ...change,
      source: "workshop",
      workspaceDir: params.workspaceDir,
    });
  }
  return commit.result;
}
