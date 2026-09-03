// Compile retention runtime roots before the children's bounded heap measurements.
const currentModuleUrl = import.meta.url;

export const sessionTitleRetentionEntrypoints = {
  titleReader: {
    currentModuleUrl,
    sourceWorkerName: "session-transcript-title-reader",
    distWorkerPath: "gateway/session-transcript-title-reader.js",
  },
  sessionUtils: {
    currentModuleUrl,
    sourceWorkerName: "session-utils-core",
    distWorkerPath: "gateway/session-utils-core.js",
  },
  childCache: {
    currentModuleUrl,
    sourceWorkerName: "session-utils.child-cache-retention.test-support",
    distWorkerPath: "gateway/session-utils.child-cache-retention.test-support.js",
  },
} as const;
