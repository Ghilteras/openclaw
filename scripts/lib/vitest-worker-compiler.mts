// Native Node/Bun entry: the invocation parent never imports this compiler graph.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  MANAGED_HANDOFF_RUNTIME_DIST,
  MANAGED_HANDOFF_RUNTIME_FILES,
} from "../../src/infra/update-managed-service-handoff-runtime-assets.ts";
import { createStateSchemaInlinePlugin } from "./state-schema-inline-plugin.mts";
import {
  hashVitestWorkerArtifact,
  verifyVitestWorkerArtifacts,
  vitestWorkerDeclarationEntries,
  type VitestWorkerManifest,
} from "./vitest-worker-artifacts.mts";
import {
  vitestMaintenanceBuildEntries,
  vitestWorkerBuildEntries,
} from "./vitest-worker-build-entries.mts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(import.meta.url);

async function compileVitestWorkerArtifacts(directory: string): Promise<void> {
  const started = performance.now();
  // The native child owns the compiler module graph for this one preparation.
  const { build }: typeof import("tsdown") = require("tsdown");
  const inputs: Record<string, string> = {};
  const outputs: Record<string, string> = {};
  const recordInput = (id: string) => {
    const normalized = id.replaceAll("\\", "/");
    if (!path.isAbsolute(normalized) || normalized.split("/").includes("node_modules")) {
      return;
    }
    if (normalized.split("/").includes("dist")) {
      throw new Error(`Compiled subprocess build tried to read dist: ${id}`);
    }
    const filename = path.normalize(normalized);
    if (fs.statSync(filename).isFile()) {
      inputs[filename] ??= hashVitestWorkerArtifact(fs.readFileSync(filename));
    }
  };
  for (const name of [
    "tsconfig.json",
    "package.json",
    "pnpm-lock.yaml",
    "scripts/lib/vitest-worker-artifacts.mts",
    "scripts/lib/vitest-worker-run.mts",
    "scripts/lib/vitest-worker-compiler.mts",
    "scripts/lib/managed-child-process.mts",
    "scripts/lib/vitest-resource-ownership.mts",
    "scripts/lib/windows-taskkill.mjs",
    "scripts/windows-cmd-helpers.mjs",
    "scripts/lib/runtime-process-build-entries.mts",
    "scripts/lib/runtime-process-core-build-entries.mts",
    "scripts/lib/vitest-worker-build-entries.mts",
    "scripts/lib/state-schema-inline-plugin.mts",
    "scripts/lib/vitest-cli-mode.mts",
    "src/infra/update-managed-service-handoff-runtime-assets.ts",
    ...MANAGED_HANDOFF_RUNTIME_FILES,
  ]) {
    recordInput(path.join(root, name));
  }
  const entry = {
    ...vitestWorkerBuildEntries,
    ...vitestWorkerDeclarationEntries,
    ...vitestMaintenanceBuildEntries,
  };
  const schemaPlugin = createStateSchemaInlinePlugin(root);
  const outDir = path.join(directory, "dist");
  const serviceUrl = pathToFileURL(path.join(outDir, "triage-maintenance/service.js")).href;
  await build({
    config: false,
    cwd: root,
    entry,
    outDir,
    format: "esm",
    platform: "node",
    tsconfig: path.join(root, "tsconfig.json"),
    dts: false,
    envPrefix: [],
    clean: false,
    copy: ({ cwd, outDir: copyOutDir }) =>
      MANAGED_HANDOFF_RUNTIME_FILES.map((file) => ({
        from: path.join(cwd, file),
        to: path.join(copyOutDir, MANAGED_HANDOFF_RUNTIME_DIST, path.dirname(file)),
      })),
    outExtensions: () => ({ js: ".js" }),
    deps: {
      // Root runtime dependencies stay external; bundled workspace code owns its private deps.
      alwaysBundle: (id) =>
        (id.startsWith("@openclaw/") || id.startsWith("openclaw/")) &&
        id !== "@openclaw/fs-safe" &&
        !id.startsWith("@openclaw/fs-safe/"),
    },
    logLevel: "warn",
    plugins: [
      {
        name: "openclaw:maintenance-service-boundary",
        resolveId(id, importer) {
          // Native mocks bind this generation's URL, not bundled local functions.
          // All real consumers keep the same service edge in the shared graph.
          if (
            importer &&
            id.startsWith(".") &&
            path.resolve(path.dirname(importer), id).replace(/\.js$/u, ".ts") ===
              vitestMaintenanceBuildEntries["triage-maintenance/service"]
          ) {
            return { id: serviceUrl, external: "absolute" };
          }
          return null;
        },
      },
      {
        name: "openclaw:worker-build-inputs",
        load(id) {
          recordInput(id);
          return null;
        },
        generateBundle(_options, bundle) {
          for (const id of Object.keys(inputs)) {
            let packageDirectory = path.dirname(id);
            while (packageDirectory.startsWith(root)) {
              const manifest = path.join(packageDirectory, "package.json");
              if (fs.existsSync(manifest)) {
                recordInput(manifest);
                break;
              }
              packageDirectory = path.dirname(packageDirectory);
            }
          }
          for (const [name, output] of Object.entries(bundle)) {
            outputs[name] = hashVitestWorkerArtifact(
              output.type === "chunk" ? output.code : Buffer.from(output.source),
            );
          }
        },
      },
      {
        ...schemaPlugin,
        load(id) {
          return schemaPlugin.load.call(
            {
              addWatchFile: (file) => {
                recordInput(file);
                this.addWatchFile(file);
              },
            },
            id,
          );
        },
      },
    ],
  });
  // tsdown copies after generateBundle. Bind those bytes to the pre-build source
  // snapshot before they join the invocation's existing verified output set.
  for (const file of MANAGED_HANDOFF_RUNTIME_FILES) {
    const output = path.posix.join(MANAGED_HANDOFF_RUNTIME_DIST, file);
    const hash = hashVitestWorkerArtifact(fs.readFileSync(path.join(outDir, output)));
    if (hash !== inputs[path.join(root, file)]) {
      throw new Error(`Copied handoff runtime changed during preparation: ${file}`);
    }
    outputs[output] = hash;
  }
  for (const name of Object.keys(entry)) {
    fs.accessSync(path.join(directory, "dist", `${name}.js`));
  }
  const sortedInputs = Object.fromEntries(
    Object.entries(inputs).toSorted(([a], [b]) => a.localeCompare(b)),
  );
  const sortedOutputs = Object.fromEntries(
    Object.entries(outputs).toSorted(([a], [b]) => a.localeCompare(b)),
  );
  const manifest: VitestWorkerManifest = {
    identity: hashVitestWorkerArtifact(JSON.stringify([sortedInputs, sortedOutputs])),
    inputs: sortedInputs,
    outputs: sortedOutputs,
    durationMs: performance.now() - started,
  };
  await verifyVitestWorkerArtifacts(directory, manifest);
  manifest.durationMs = performance.now() - started;
  fs.writeFileSync(path.join(directory, "manifest.json"), `${JSON.stringify(manifest)}\n`, {
    flag: "wx",
  });
}

if (import.meta.main) {
  try {
    const directory = fs.realpathSync(process.argv[2]!);
    const parent = fs.realpathSync(path.join(root, ".artifacts/vitest-workers"));
    if (
      process.argv.length !== 3 ||
      path.dirname(directory) !== parent ||
      !path.basename(directory).startsWith("run-") ||
      fs.readdirSync(directory).some((name) => name !== "package.json")
    ) {
      throw new Error("Compiled subprocess compiler requires a fresh invocation directory");
    }
    await compileVitestWorkerArtifacts(directory);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
