import { readCronScheduledToolProjection } from "../exec-tool-target-pinning.js";
import { normalizeToolPolicyName } from "../tool-policy.js";
import type { CronCreatorToolAllowlistEntry, CronToolsAllowCaptureRef } from "./cron-tool.types.js";

/** Legacy SDK capture helper. Scheduled execution no longer replays this snapshot. */
export function replaceWithEffectiveCronCreatorToolAllowlist<T extends { name: string }>(
  target: CronCreatorToolAllowlistEntry[],
  tools: readonly T[],
  toolMeta?: (tool: T) => { pluginId?: string } | undefined,
): void {
  target.length = 0;
  // Host-created alias projections (for example a Codex gateway shell alias) are
  // recorded under their canonical core tool name so scheduled runtimes rebuild
  // the same capability. The alias name is kept for explicit-cap matching only.
  const indexByName = new Map<string, number>();
  for (const tool of tools) {
    const projection = readCronScheduledToolProjection(tool);
    const name = normalizeToolPolicyName(projection ? projection.targetTool : tool.name);
    if (!name) {
      continue;
    }
    const aliasName = projection ? normalizeToolPolicyName(tool.name) : undefined;
    const existingIndex = indexByName.get(name);
    const existing = existingIndex === undefined ? undefined : target[existingIndex];
    if (existing !== undefined) {
      // Merge duplicate grants of one canonical tool: alias names stay matchable,
      // and the restrict-only target survives only when every grantor pins it.
      if (typeof existing === "string") {
        continue;
      }
      if (aliasName && !existing.aliasName) {
        existing.aliasName = aliasName;
      }
      if (existing.execTarget && !projection?.execTarget) {
        delete existing.execTarget;
      } else if (
        existing.execTarget?.ask === "always" &&
        projection?.execTarget?.ask !== "always"
      ) {
        delete existing.execTarget.ask;
      }
      continue;
    }
    const meta = toolMeta?.(tool);
    const pluginId =
      typeof meta?.pluginId === "string" ? normalizeToolPolicyName(meta.pluginId) : undefined;
    indexByName.set(name, target.length);
    target.push({
      name,
      ...(pluginId ? { pluginId } : {}),
      ...(aliasName && aliasName !== name ? { aliasName } : {}),
      ...(projection?.execTarget ? { execTarget: { ...projection.execTarget } } : {}),
    });
  }
}

/** Records the creator cap only after every runtime policy and schema quarantine has run. */
export function captureFinalEffectiveCronCreatorToolAllowlist<T extends { name: string }>(
  target: CronCreatorToolAllowlistEntry[],
  captureRef: CronToolsAllowCaptureRef,
  tools: readonly T[],
  toolMeta?: (tool: T) => { pluginId?: string } | undefined,
): void {
  replaceWithEffectiveCronCreatorToolAllowlist(target, tools, toolMeta);
  captureRef.value = { version: 1, source: "final-executable-surface" };
}
