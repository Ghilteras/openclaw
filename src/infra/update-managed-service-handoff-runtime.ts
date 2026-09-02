import fs from "node:fs";
import path from "node:path";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import {
  MANAGED_HANDOFF_RUNTIME_DIST,
  MANAGED_HANDOFF_RUNTIME_FILES,
} from "./update-managed-service-handoff-runtime-assets.js";

/** Prepare the complete lease owner before launch; the caller owns partial-stage cleanup. */
export function stageManagedHandoffRuntime(directory: string): string[] {
  const anchor = resolveRuntimeWorkerUrl({
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../shared/pid-alive",
    distWorkerPath: `${MANAGED_HANDOFF_RUNTIME_DIST}/src/shared/pid-alive.ts`,
  });
  const sourceRoot = new URL("../../", anchor);
  const staged = MANAGED_HANDOFF_RUNTIME_FILES.map((file) => {
    const destination = path.join(directory, "runtime", file);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.writeFileSync(destination, fs.readFileSync(new URL(file, sourceRoot)), {
      mode: 0o600,
      flag: "wx",
    });
    return destination;
  });
  const moduleFormat = path.join(directory, "runtime", "package.json");
  fs.writeFileSync(moduleFormat, '{"type":"module"}\n', { mode: 0o600, flag: "wx" });
  // These files survive update-to-triage exec, then share the helper's sensitive-file cleanup.
  return [...staged, moduleFormat];
}
