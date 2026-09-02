export const MANAGED_HANDOFF_RUNTIME_DIST = "managed-handoff-runtime";
export const MANAGED_HANDOFF_RUNTIME_ENTRY =
  "src/infra/update-managed-service-handoff-lease-runtime.ts";

// Preserve these relative imports in both packaged assets and the private helper snapshot.
export const MANAGED_HANDOFF_RUNTIME_FILES = [
  MANAGED_HANDOFF_RUNTIME_ENTRY,
  "src/infra/update-managed-service-handoff-cleanup.ts",
  "src/infra/update-managed-service-handoff-identity-runtime.ts",
  "src/infra/update-managed-service-handoff-lease-state.ts",
  "src/shared/pid-alive.ts",
  "src/infra/windows-process-start.ts",
  "src/infra/process-env.ts",
  "packages/normalization-core/src/record-coerce.ts",
] as const;
