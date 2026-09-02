import fs from "node:fs/promises";
import path from "node:path";
import { removePathWithinRoot } from "../../infra/fs-safe-remove.js";
import { pathExists } from "../../infra/fs-safe.js";
import { logWarn } from "../../logger.js";

export async function restoreSkillCollectionBackupTransaction(params: {
  skillsRoot: string;
  backupDir: string;
  skillDirs: readonly string[];
  resultSkillDirs: readonly string[];
}): Promise<void> {
  const rollbackDir = path.join(params.backupDir, `.restore-${Date.now()}`);
  await fs.mkdir(rollbackDir, { recursive: true });
  try {
    if (await pathExists(params.skillsRoot)) {
      await fs.cp(params.skillsRoot, path.join(rollbackDir, "skills"), {
        recursive: true,
        errorOnExist: true,
        force: false,
        preserveTimestamps: true,
      });
    }
    await restoreTrackedSkillCollection({
      skillsRoot: params.skillsRoot,
      snapshotRoot: path.join(params.backupDir, "skills"),
      restoreDirs: params.skillDirs,
      removeDirs: params.resultSkillDirs.filter((dir) => !params.skillDirs.includes(dir)),
    });
  } catch (error) {
    try {
      await restoreTrackedSkillCollection({
        skillsRoot: params.skillsRoot,
        snapshotRoot: path.join(rollbackDir, "skills"),
        restoreDirs: [...new Set([...params.skillDirs, ...params.resultSkillDirs])],
        removeDirs: [],
      });
    } catch (rollbackError) {
      const failure = new Error(
        "Skill collection restore failed and the current collection was not restored.",
        { cause: error },
      );
      Object.assign(failure, { rollbackError });
      throw failure;
    }
    throw error;
  } finally {
    await removePathWithinRoot({
      rootDir: params.backupDir,
      relativePath: path.basename(rollbackDir),
      recursive: true,
      force: true,
    }).catch((error: unknown) => {
      logWarn(`skill-workshop: failed to discard restore snapshot: ${String(error)}`);
    });
  }
}

export async function restoreSkillCollectionDirectoryFromBackup(params: {
  skillsRoot: string;
  backupDir: string;
  relativeDir: string;
  existedBefore: boolean;
}): Promise<void> {
  const liveDir = path.join(params.skillsRoot, params.relativeDir);
  if (await pathExists(liveDir)) {
    await removePathWithinRoot({
      rootDir: params.skillsRoot,
      relativePath: params.relativeDir,
      recursive: true,
      force: true,
    });
  }
  if (params.existedBefore) {
    await fs.mkdir(path.dirname(liveDir), { recursive: true });
    await fs.cp(path.join(params.backupDir, "skills", params.relativeDir), liveDir, {
      recursive: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
    });
  }
}

async function restoreTrackedSkillCollection(params: {
  skillsRoot: string;
  snapshotRoot: string;
  restoreDirs: readonly string[];
  removeDirs: readonly string[];
}): Promise<void> {
  await fs.mkdir(params.skillsRoot, { recursive: true });
  for (const relativeDir of params.restoreDirs) {
    const liveDir = path.join(params.skillsRoot, relativeDir);
    if (await pathExists(liveDir)) {
      await removePathWithinRoot({
        rootDir: params.skillsRoot,
        relativePath: relativeDir,
        recursive: true,
        force: true,
      });
    }
    const snapshotDir = path.join(params.snapshotRoot, relativeDir);
    if (await pathExists(snapshotDir)) {
      await fs.mkdir(path.dirname(liveDir), { recursive: true });
      await fs.cp(snapshotDir, liveDir, {
        recursive: true,
        errorOnExist: true,
        force: false,
        preserveTimestamps: true,
      });
    }
  }
  for (const relativeDir of params.removeDirs) {
    if (!(await pathExists(path.join(params.skillsRoot, relativeDir)))) {
      continue;
    }
    await removePathWithinRoot({
      rootDir: params.skillsRoot,
      relativePath: relativeDir,
      recursive: true,
      force: true,
    });
  }
}
