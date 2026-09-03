import { t } from "../../i18n/index.ts";
import type { DraftBranches } from "./discovery.ts";

export function worktreeAllocationBlockedReason(
  status: DraftBranches["allocationStatus"],
): string | undefined {
  if (status === "insufficient-space") {
    return t("newSession.worktreeCapacityInsufficient");
  }
  return status === "unavailable" ? t("newSession.worktreeCapacityUnavailable") : undefined;
}
