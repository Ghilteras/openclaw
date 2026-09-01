// Real child imports share the invocation build before readiness budgets begin.
const currentModuleUrl = import.meta.url;

export const triageTestRuntimeEntrypoints = {
  continuation: {
    currentModuleUrl,
    sourceWorkerName: "triage-continuation",
    distWorkerPath: "infra/triage-continuation.js",
  },
  failure: {
    currentModuleUrl,
    sourceWorkerName: "../commands/triage-failure",
    distWorkerPath: "commands/triage-failure.js",
  },
  exec: {
    currentModuleUrl,
    sourceWorkerName: "../process/exec-runner",
    distWorkerPath: "process/exec-runner.js",
  },
  identity: {
    currentModuleUrl,
    sourceWorkerName: "../shared/pid-alive",
    distWorkerPath: "shared/pid-alive.js",
  },
  respawn: {
    currentModuleUrl,
    sourceWorkerName: "../entry.respawn",
    distWorkerPath: "entry.respawn.js",
  },
} as const;
