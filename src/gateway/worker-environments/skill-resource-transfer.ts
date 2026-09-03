import path from "node:path";
import { prepareSkillBundle } from "../../skills/library/bundle.js";
import { formatSkillsForPromptBounded } from "../../skills/loading/skill-prompt-limits.js";
import { prepareSkillResourceDelivery } from "../../skills/runtime/resources.js";
import type { SkillSnapshot } from "../../skills/types.js";
import {
  parseWorkerSkillResourceLocator,
  WORKER_SKILL_RESOURCE_CHUNK_BYTES,
  WORKER_SKILL_RESOURCE_COMMAND,
  type WorkerSkillResourceOperation,
} from "../../worker/skill-resource-protocol.js";
import type { WorkerWorkspaceTunnelHandle } from "./tunnel-contract.js";

/** Transfers the prepared catalog through either SSH or node placement transport, outside Git state. */
export async function transferSkillResources(params: {
  snapshot?: SkillSnapshot;
  workspaceDir: string;
  generation: number;
  tunnel: Pick<WorkerWorkspaceTunnelHandle, "runWorkspaceCommand">;
  assertCurrent: () => void;
  signal?: AbortSignal;
  explicitSelections?: readonly import("../../skills/types.js").ExplicitSkillSelection[];
}) {
  const check = () => {
    params.signal?.throwIfAborted();
    params.assertCurrent();
  };
  const delivery = await prepareSkillResourceDelivery(
    params.snapshot,
    check,
    params.explicitSelections,
  );
  if (!delivery || !params.snapshot) {
    return undefined;
  }
  const execute = async (operation: WorkerSkillResourceOperation, input?: string) => {
    const cleanup = operation.operation === "cleanup";
    const assertDispatchCurrent = cleanup ? params.assertCurrent : check;
    assertDispatchCurrent();
    const result = await params.tunnel.runWorkspaceCommand({
      argv: [WORKER_SKILL_RESOURCE_COMMAND],
      skillResources: {
        workspaceDir: params.workspaceDir,
        generation: params.generation,
        operation,
      },
      input,
      transportRetry: "never",
      assertCurrent: assertDispatchCurrent,
      signal: cleanup ? undefined : params.signal,
      timeoutMs: cleanup ? 5000 : 60000,
    });
    // Preserve the accepted cleanup locator before observing turn cancellation.
    // The exact placement must still own every command, including cleanup.
    if (operation.operation === "init") {
      params.assertCurrent();
    } else {
      assertDispatchCurrent();
    }
    if (result.termination !== "exit" || result.code !== 0) {
      throw new Error(
        "Skill resource transfer failed. Retry this turn after reconnecting the execution environment.",
      );
    }
    return result.stdout;
  };
  const initialized = parseWorkerSkillResourceLocator(
    JSON.parse(await execute({ operation: "init" })),
  );
  const locator = { resourceId: initialized.resourceId, identity: initialized.identity };
  const cleanup = async () => {
    await execute({ operation: "cleanup", ...locator });
  };
  try {
    const parent = path.posix.dirname(params.workspaceDir.replaceAll("\\", "/"));
    if (
      initialized.root.replaceAll("\\", "/") !==
      `${parent}/.${params.generation}.skill-resources-${initialized.resourceId}`
    ) {
      throw new Error("Skill resource location does not match its workspace owner");
    }
    check();
    const deliveredSourcePaths = new Set(
      delivery.skills
        .map((skill) => skill.sourcePath)
        .filter((sourcePath): sourcePath is string => sourcePath !== undefined),
    );
    const resolvedSkills = structuredClone(params.snapshot.resolvedSkills ?? []).filter(
      (skill) => skill.filePath.startsWith("node://") || deliveredSourcePaths.has(skill.filePath),
    );
    const skippedSkillNames = new Set(
      (params.snapshot.resolvedSkills ?? [])
        .filter(
          (skill) =>
            !skill.filePath.startsWith("node://") && !deliveredSourcePaths.has(skill.filePath),
        )
        .map((skill) => skill.name),
    );
    const retainedSkillNames = new Set([
      ...resolvedSkills.map((skill) => skill.name),
      ...delivery.skills.map((skill) => skill.name),
    ]);
    const skills = structuredClone(params.snapshot.skills).filter(
      (skill) => !skippedSkillNames.has(skill.name) || retainedSkillNames.has(skill.name),
    );
    const mounts: Array<{ hostPath: string; containerPath: string }> = [];
    for (const [index, skill] of delivery.skills.entries()) {
      const bundle = prepareSkillBundle(skill.files);
      for (const file of bundle.files) {
        for (
          let offset = 0;
          offset === 0 || offset < file.bytes.length;
          offset += WORKER_SKILL_RESOURCE_CHUNK_BYTES
        ) {
          await execute(
            {
              operation: "write",
              ...locator,
              path: `${index}/${file.path}`,
              offset,
              sizeBytes: file.sizeBytes,
              sha256: file.sha256,
              executable: file.executable,
            },
            file.bytes
              .subarray(offset, offset + WORKER_SKILL_RESOURCE_CHUNK_BYTES)
              .toString("base64"),
          );
        }
      }
      const selected = resolvedSkills.find((candidate) => candidate.filePath === skill.sourcePath);
      const sourceBase =
        selected?.baseDir ?? (skill.sourcePath ? path.dirname(skill.sourcePath) : undefined);
      if (!sourceBase) {
        throw new Error("Resource source path missing.");
      }
      const remoteBase = `${initialized.root.replaceAll("\\", "/")}/${index}`;
      mounts.push({ hostPath: sourceBase, containerPath: remoteBase });
      if (selected) {
        selected.locationNote = `Read instructions at the location above. For remote execution, this exact bundle's scripts and resources are at ${remoteBase}; resolve relative execution paths against that directory.`;
      }
    }
    check();
    return {
      source: params.snapshot,
      snapshot: {
        ...params.snapshot,
        skills,
        resolvedSkills,
        prompt: formatSkillsForPromptBounded({ skills: resolvedSkills, preserveOrder: true }),
      },
      mounts,
      assertCurrent: check,
      cleanup,
    };
  } catch (error) {
    await cleanup().catch(() => undefined);
    throw error;
  }
}
