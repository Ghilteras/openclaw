// Release Check tests cover release check script behavior.
import { execFileSync } from "node:child_process";
import {
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildSync } from "esbuild";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  collectRootPackageExcludedExtensionDirs,
  listBundledPluginPackArtifacts,
} from "../../scripts/lib/bundled-plugin-build-entries.mjs";
import {
  createPackedTarballInstallArgs,
  prepareReleaseCheckLocalPackageTarballs,
  RELEASE_CHECK_LOCAL_PACKAGE_TARBALL_DIR_ENV,
  resolveReleaseCheckLocalPackageTarballs,
  writePackedTarballInstallManifest,
  writePackedBundledPluginActivationConfig,
} from "../../scripts/release-check.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.ts";

const generatedPackCapabilities = [
  ["src/agents/compaction-planning.worker.ts", "dist/agents/compaction-planning.worker.js"],
  ["src/agents/model-provider-auth.worker.ts", "dist/agents/model-provider-auth.worker.js"],
  ["src/agents/prepared-model-catalog.worker.ts", "dist/agents/prepared-model-catalog.worker.js"],
  [
    "extensions/memory-core/src/memory/manager-search-knn-entrypoint.ts",
    "dist/extensions/memory-core/memory-search-knn.child.js",
  ],
  [
    "src/config/sessions/session-accessor.sqlite-archive.worker.ts",
    "dist/config/sessions/session-accessor.sqlite-archive.worker.js",
  ],
  [
    "src/config/sessions/session-transcript-reconcile.worker.ts",
    "dist/config/sessions/session-transcript-reconcile.worker.js",
  ],
  ["src/state/openclaw-database-verify.worker.ts", "dist/state/openclaw-database-verify.worker.js"],
  [
    "src/system-agent/setup-inference-detection.worker.ts",
    "dist/system-agent/setup-inference-detection.worker.js",
  ],
  ["src/tasks/task-registry-control.runtime.ts", "dist/task-registry-control.runtime.js"],
  [
    "extensions/telegram/src/telegram-ingress-worker.runtime.ts",
    "dist/telegram-ingress-worker.runtime.js",
  ],
] as const;
const conditionalPackPaths = [
  "scripts/lib/recommended-tool-installs.json",
  "scripts/lib/guard-inventory-utils.mjs",
  ...generatedPackCapabilities.map(([, outputPath]) => outputPath),
] as const;
const legacySdkPackPaths = [
  "dist/extensionAPI.js",
  "dist/extensionAPI.d.ts",
  "dist/plugin-sdk/compat.js",
  "dist/plugin-sdk/compat.d.ts",
  "dist/plugin-sdk/index.js",
  "dist/plugin-sdk/index.d.ts",
  "dist/plugin-sdk/root-alias.cjs",
] as const;
const legacySdkSourcePaths = [
  "src/extensionAPI.ts",
  "src/plugin-sdk/compat.ts",
  "src/plugin-sdk/index.ts",
  "src/plugin-sdk/root-alias.cjs",
  "scripts/copy-plugin-sdk-root-alias.mjs",
] as const;
const legacySdkExports = {
  "./extension-api": "./dist/extensionAPI.js",
  "./plugin-sdk": {
    types: "./dist/plugin-sdk/index.d.ts",
    default: "./dist/plugin-sdk/index.js",
  },
  "./plugin-sdk/compat": {
    types: "./dist/plugin-sdk/compat.d.ts",
    default: "./dist/plugin-sdk/compat.js",
  },
} as const;
const sharedTempDirs = useAutoCleanupTempDirTracker(afterAll);
const targetTempDirs = useAutoCleanupTempDirTracker(afterEach);
let sparseReleaseToolingRoot: string | undefined;

function requirePluginEntries(config: { plugins?: { entries?: Record<string, unknown> } }) {
  if (!config.plugins?.entries) {
    throw new Error("Expected plugin entries in packaged activation config");
  }
  return config.plugins.entries;
}

function getSparseReleaseToolingRoot() {
  if (sparseReleaseToolingRoot) {
    return sparseReleaseToolingRoot;
  }
  const toolingRoot = sharedTempDirs.make("openclaw-release-check-tooling-");
  const workflow = parse(readFileSync(".github/workflows/openclaw-npm-preflight.yml", "utf8"));
  const checkout = workflow.jobs.check_contents_npm.steps.find(
    (step: { name?: string }) => step.name === "Checkout trusted Plugin SDK API tooling",
  );
  const sparseRoots = checkout.with["sparse-checkout"].trim().split(/\s+/u) as string[];
  const trackedPaths = [
    ...Object.keys(
      buildSync({
        entryPoints: ["scripts/release-check.ts", "scripts/tsx.mjs"],
        bundle: true,
        format: "esm",
        logLevel: "silent",
        metafile: true,
        outdir: toolingRoot,
        packages: "external",
        platform: "node",
        write: false,
      }).metafile!.inputs,
    ),
    "package.json",
    "scripts/fixtures/packed-plugin-sdk-type-smoke.ts",
    "tsconfig.json",
  ];
  expect(
    trackedPaths.every(
      (path) =>
        path === "package.json" ||
        path === "tsconfig.json" ||
        sparseRoots.some((root) => path.startsWith(`${root}/`)),
    ),
  ).toBe(true);
  for (const relativePath of trackedPaths) {
    const destination = join(toolingRoot, relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    linkSync(relativePath, destination);
  }
  symlinkSync(resolve("node_modules"), join(toolingRoot, "node_modules"), "junction");
  sparseReleaseToolingRoot = toolingRoot;
  return toolingRoot;
}

function runSparseReleaseToolingFixture(params: {
  files: unknown;
  inspectWorkerCapabilities?: boolean;
  packageExports?: unknown;
  packPaths?: readonly string[];
  pluginSdkEntries?: unknown;
  privatePluginSdkEntries?: unknown;
  sourcePaths?: readonly string[];
  workerBundleSource?: string;
}) {
  const root = targetTempDirs.make("openclaw-release-check-target-");
  try {
    const toolingRoot = getSparseReleaseToolingRoot();
    mkdirSync(join(root, "scripts", "lib"), { recursive: true });
    mkdirSync(join(root, "extensions"));
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ files: params.files, exports: params.packageExports }),
    );
    writeFileSync(
      join(root, "scripts/lib/plugin-sdk-entrypoints.json"),
      JSON.stringify(params.pluginSdkEntries ?? ["target-private", "target-public"]),
    );
    writeFileSync(
      join(root, "scripts/lib/plugin-sdk-private-local-only-subpaths.json"),
      JSON.stringify(params.privatePluginSdkEntries ?? ["target-private"]),
    );
    for (const sourcePath of params.sourcePaths ?? []) {
      const destination = join(root, sourcePath);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, "export {};\n");
    }
    if (params.workerBundleSource !== undefined) {
      const workerBundlePath = join(root, "src/shared/worker-bundle-hash.ts");
      mkdirSync(dirname(workerBundlePath), { recursive: true });
      writeFileSync(workerBundlePath, params.workerBundleSource);
    }
    mkdirSync(join(root, "scripts", "fixtures"));
    writeFileSync(
      join(root, "scripts/fixtures/packed-plugin-sdk-type-smoke.ts"),
      "stale target fixture",
    );
    const moduleUrl = pathToFileURL(join(toolingRoot, "scripts/release-check.ts")).href;
    const packPaths = params.packPaths ?? [
      "dist/plugin-sdk/target-private.js",
      "dist/plugin-sdk/target-private.d.ts",
      "dist/plugin-sdk/target-public.js",
      "dist/plugin-sdk/target-public.d.ts",
    ];
    const output = execFileSync(
      process.execPath,
      [
        "--import",
        join(toolingRoot, "scripts/tsx.mjs"),
        "--input-type=module",
        "--eval",
        `import { readFileSync } from "node:fs";\n` +
          `const releaseCheck = await import(${JSON.stringify(moduleUrl)});\n` +
          `const { collectForbiddenPackPaths, collectMissingPackPaths, createPackedPluginSdkTypescriptSmokeProject } = releaseCheck;\n` +
          `createPackedPluginSdkTypescriptSmokeProject({ consumerDir: "consumer", packageSpec: "file:fixture.tgz" });\n` +
          `const conditional = ${JSON.stringify(conditionalPackPaths)};\n` +
          `const packPaths = ${JSON.stringify(packPaths)};\n` +
          `const workers = ${params.inspectWorkerCapabilities ? "releaseCheck.resolveTargetWorkerEntrypoints()" : "undefined"};\n` +
          `console.log(JSON.stringify({ conditional: collectMissingPackPaths([]).filter(path => conditional.includes(path)), forbidden: collectForbiddenPackPaths(packPaths), required: collectMissingPackPaths([]).filter(path => packPaths.includes(path)), fixture: readFileSync("consumer/src/index.ts", "utf8"), workers }));`,
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, TSX_TSCONFIG_PATH: join(toolingRoot, "tsconfig.json") },
      },
    );
    return {
      output: JSON.parse(output) as {
        conditional: string[];
        fixture: string;
        forbidden: string[];
        required: string[];
        workers?: string[];
      },
      toolingFixture: readFileSync(
        join(toolingRoot, "scripts/fixtures/packed-plugin-sdk-type-smoke.ts"),
        "utf8",
      ),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("release-check", () => {
  it("loads sparse release tooling and checks the separate target SDK inventory", () => {
    const { output, toolingFixture } = runSparseReleaseToolingFixture({ files: ["dist"] });
    expect(output).toEqual({
      conditional: [],
      fixture: toolingFixture,
      forbidden: ["dist/plugin-sdk/target-private.d.ts"],
      required: [
        "dist/plugin-sdk/target-private.js",
        "dist/plugin-sdk/target-public.d.ts",
        "dist/plugin-sdk/target-public.js",
      ],
    });
  });

  it("uses exact target package exclusions for private SDK artifacts", () => {
    const exact = runSparseReleaseToolingFixture({
      files: ["dist", "!dist/plugin-sdk/target-private.js"],
      packPaths: ["dist/plugin-sdk/target-private.js", "dist/plugin-sdk/target-private.d.ts"],
    }).output;
    expect(exact).toMatchObject({
      forbidden: ["dist/plugin-sdk/target-private.d.ts", "dist/plugin-sdk/target-private.js"],
      required: [],
    });

    const near = runSparseReleaseToolingFixture({
      files: [
        "dist",
        "!dist/plugin-sdk/target-private.*",
        "!dist/plugin-sdk/target-private.js.map",
        "!dist/plugin-sdk/nested/target-private.js",
      ],
      packPaths: ["dist/plugin-sdk/target-private.js", "dist/plugin-sdk/target-private.d.ts"],
    }).output;
    expect(near).toMatchObject({
      forbidden: ["dist/plugin-sdk/target-private.d.ts"],
      required: ["dist/plugin-sdk/target-private.js"],
    });
  });

  it("requires private SDK runtime artifacts when the exact exclusion is removed", () => {
    const { output } = runSparseReleaseToolingFixture({
      files: ["dist"],
      packPaths: ["dist/plugin-sdk/target-private.js", "dist/plugin-sdk/target-private.d.ts"],
    });
    expect(output).toMatchObject({
      forbidden: ["dist/plugin-sdk/target-private.d.ts"],
      required: ["dist/plugin-sdk/target-private.js"],
    });
  });

  it("allows and requires the seven target-owned legacy SDK outputs", () => {
    const { output } = runSparseReleaseToolingFixture({
      files: ["dist"],
      packageExports: legacySdkExports,
      packPaths: legacySdkPackPaths,
      pluginSdkEntries: ["index", "compat"],
      privatePluginSdkEntries: [],
      sourcePaths: legacySdkSourcePaths,
    });
    expect(output).toMatchObject({
      forbidden: [],
      required: [...legacySdkPackPaths].toSorted(),
    });
  });

  it("keeps legacy SDK outputs forbidden for modern targets", () => {
    const { output } = runSparseReleaseToolingFixture({
      files: ["dist"],
      packPaths: legacySdkPackPaths,
      pluginSdkEntries: [],
      privatePluginSdkEntries: [],
    });
    expect(output).toMatchObject({
      forbidden: [...legacySdkPackPaths].toSorted(),
      required: [],
    });
  });

  it.each([
    {
      name: "source-only",
      packageExports: undefined,
      packPaths: legacySdkPackPaths,
      pluginSdkEntries: ["index", "compat"],
      sourcePaths: legacySdkSourcePaths.filter(
        (path) => path !== "scripts/copy-plugin-sdk-root-alias.mjs",
      ),
    },
    {
      name: "export-only",
      packageExports: legacySdkExports,
      packPaths: legacySdkPackPaths,
      pluginSdkEntries: ["index", "compat"],
      sourcePaths: [],
    },
    {
      name: "partial inventory",
      packageExports: legacySdkExports,
      packPaths: ["dist/plugin-sdk/compat.js", "dist/plugin-sdk/compat.d.ts"],
      pluginSdkEntries: ["index"],
      sourcePaths: legacySdkSourcePaths,
    },
    {
      name: "near-match export",
      packageExports: {
        ...legacySdkExports,
        "./plugin-sdk/compat": {
          types: "./dist/plugin-sdk/compat.d.ts.map",
          default: "./dist/plugin-sdk/compat.js",
        },
      },
      packPaths: ["dist/plugin-sdk/compat.js", "dist/plugin-sdk/compat.d.ts"],
      pluginSdkEntries: ["compat"],
      sourcePaths: ["src/plugin-sdk/compat.ts"],
    },
    {
      name: "unknown inventory entry",
      packageExports: legacySdkExports,
      packPaths: ["dist/plugin-sdk/compat.js", "dist/plugin-sdk/compat.d.ts"],
      pluginSdkEntries: ["compatibility"],
      sourcePaths: ["src/plugin-sdk/compat.ts"],
    },
  ])("fails closed for $name legacy SDK ownership", (fixture) => {
    const { output } = runSparseReleaseToolingFixture({
      files: ["dist"],
      packageExports: fixture.packageExports,
      packPaths: fixture.packPaths,
      pluginSdkEntries: fixture.pluginSdkEntries,
      privatePluginSdkEntries: [],
      sourcePaths: fixture.sourcePaths,
    });
    expect(output.forbidden).toEqual([...fixture.packPaths].toSorted());
  });

  it("fails closed on malformed target SDK inventory", () => {
    expect(() =>
      runSparseReleaseToolingFixture({
        files: ["dist"],
        packageExports: legacySdkExports,
        packPaths: legacySdkPackPaths,
        pluginSdkEntries: { index: true, compat: true },
        privatePluginSdkEntries: [],
        sourcePaths: legacySdkSourcePaths,
      }),
    ).toThrow();
  });

  it("forbids orphan private SDK inventory artifacts", () => {
    const packPaths = ["dist/plugin-sdk/orphan.js", "dist/plugin-sdk/orphan.d.ts"];
    const { output } = runSparseReleaseToolingFixture({
      files: ["dist"],
      packPaths,
      pluginSdkEntries: [],
      privatePluginSdkEntries: ["orphan"],
    });
    expect(output).toMatchObject({ forbidden: packPaths.toSorted(), required: [] });
  });

  it("exempts only exact authorized legacy SDK paths from forbidden prefixes", () => {
    const nearMatches = [
      "dist/extensionAPI.js.map",
      "dist/plugin-sdk/compat.js.map",
      "dist/plugin-sdk/index.d.ts.map",
      "dist/plugin-sdk/root-alias.cjs.map",
      "dist/plugin-sdk/compat.js/nested",
      "dist/plugin-sdk/index.js/nested",
    ];
    const { output } = runSparseReleaseToolingFixture({
      files: ["dist"],
      packageExports: legacySdkExports,
      packPaths: [...legacySdkPackPaths, ...nearMatches],
      pluginSdkEntries: ["index", "compat"],
      privatePluginSdkEntries: [],
      sourcePaths: legacySdkSourcePaths,
    });
    expect(output.forbidden).toEqual(nearMatches.toSorted());
  });

  it("derives support and generated package requirements from target capabilities", () => {
    const { output } = runSparseReleaseToolingFixture({
      files: ["dist", "scripts/lib/recommended-tool-installs.json"],
      sourcePaths: generatedPackCapabilities.map(([sourcePath]) => sourcePath),
    });
    expect(output.conditional).toEqual(
      conditionalPackPaths
        .filter((path) => path !== "scripts/lib/guard-inventory-utils.mjs")
        .toSorted(),
    );
  });

  it("derives frozen worker requirements from the target bundle manifest", () => {
    const historical = runSparseReleaseToolingFixture({
      files: ["dist"],
      inspectWorkerCapabilities: true,
      sourcePaths: ["src/worker/github-exec-launcher.ts"],
      workerBundleSource: `
        export const WORKER_BUNDLE_ENTRY_PATH = "worker.mjs";
        export const WORKER_BUNDLE_RSYNC_RECEIVER_PATH = "workspace-rsync-receiver.mjs";
      `,
    }).output;
    const modern = runSparseReleaseToolingFixture({
      files: ["dist"],
      inspectWorkerCapabilities: true,
      workerBundleSource: `
        export const WORKER_BUNDLE_ENTRY_PATH = "worker.mjs";
        export const WORKER_BUNDLE_GITHUB_EXEC_LAUNCHER_PATH = "github-exec-launcher.mjs";
        export const WORKER_BUNDLE_RSYNC_RECEIVER_PATH = "workspace-rsync-receiver.mjs";
      `,
    }).output;

    expect(historical.workers).toEqual([
      "dist/worker/worker.mjs",
      "dist/worker/workspace-rsync-receiver.mjs",
    ]);
    expect(modern.workers).toEqual([
      "dist/worker/github-exec-launcher.mjs",
      "dist/worker/worker.mjs",
      "dist/worker/workspace-rsync-receiver.mjs",
    ]);
  });

  it("fails closed on malformed frozen worker bundle contracts", () => {
    const cases = [
      {
        source: 'export const WORKER_BUNDLE_FUTURE_PATH = "future.mjs";',
        message: "unknown path constant WORKER_BUNDLE_FUTURE_PATH",
      },
      {
        source: 'export let WORKER_BUNDLE_ENTRY_PATH = "worker.mjs";',
        message: "must be an exported string const",
      },
      {
        source:
          'export const { WORKER_BUNDLE_ENTRY_PATH } = { WORKER_BUNDLE_ENTRY_PATH: "worker.mjs" };',
        message: "must use identifier declarations",
      },
      {
        source:
          'const workerPath = "worker.mjs";\n' +
          "export { workerPath as WORKER_BUNDLE_ENTRY_PATH };",
        message: "must use direct declarations",
      },
      {
        source: 'export const WORKER_BUNDLE_ENTRY_PATH = "../worker.mjs";',
        message: "has an invalid path",
      },
      {
        source:
          'export const WORKER_BUNDLE_ENTRY_PATH = "worker.mjs";\n' +
          'export const WORKER_BUNDLE_RSYNC_RECEIVER_PATH = "worker.mjs";',
        message: "has duplicate paths",
      },
    ];

    for (const fixture of cases) {
      expect(() =>
        runSparseReleaseToolingFixture({
          files: ["dist"],
          inspectWorkerCapabilities: true,
          workerBundleSource: fixture.source,
        }),
      ).toThrow(fixture.message);
    }
    expect(
      runSparseReleaseToolingFixture({
        files: ["dist"],
        inspectWorkerCapabilities: true,
      }).output.workers,
    ).toEqual([]);
  });

  it("rejects malformed target package file declarations", () => {
    expect(() => runSparseReleaseToolingFixture({ files: ["dist", 42] })).toThrow(
      "release-check: target package.json files must be an array of strings.",
    );
  });

  it("installs the prepared tarball with its real package lifecycle", () => {
    expect(createPackedTarballInstallArgs("/tmp/prefix")).toEqual([
      "install",
      "--prefix",
      "/tmp/prefix",
      "--no-audit",
      "--no-fund",
    ]);
  });

  it("resolves prepacked publishable core package tarballs", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-release-check-tarball-test-"));
    try {
      writeFileSync(join(root, "openclaw-ai-2026.6.33.tgz"), "fixture");
      writeFileSync(join(root, "openclaw-gateway-client-2026.6.33.tgz"), "fixture");
      writeFileSync(join(root, "openclaw-gateway-protocol-2026.6.33.tgz"), "fixture");
      writeFileSync(join(root, "SHA256SUMS"), "fixture");
      expect(resolveReleaseCheckLocalPackageTarballs(root)).toEqual([
        join(root, "openclaw-ai-2026.6.33.tgz"),
        join(root, "openclaw-gateway-client-2026.6.33.tgz"),
        join(root, "openclaw-gateway-protocol-2026.6.33.tgz"),
      ]);
      expect(resolveReleaseCheckLocalPackageTarballs(undefined)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts gateway core packages when the root does not require AI", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-release-check-tarball-test-"));
    try {
      const gatewayTarball = join(root, "openclaw-gateway-protocol-2026.7.2.tgz");
      const gatewayClientTarball = join(root, "openclaw-gateway-client-2026.7.2.tgz");
      writeFileSync(gatewayTarball, "fixture");
      writeFileSync(gatewayClientTarball, "fixture");
      expect(resolveReleaseCheckLocalPackageTarballs(root, false)).toEqual([
        gatewayClientTarball,
        gatewayTarball,
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes an explicit local project for unpublished core package tarballs", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-release-check-install-test-"));
    try {
      writePackedTarballInstallManifest(root, "/tmp/openclaw.tgz", [
        "/tmp/openclaw-ai.tgz",
        "/tmp/openclaw-gateway-client.tgz",
        "/tmp/openclaw-gateway-protocol.tgz",
      ]);
      const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
        dependencies?: Record<string, string>;
        private?: boolean;
      };
      expect(manifest.private).toBe(true);
      expect(manifest.dependencies).toEqual({
        "@openclaw/ai": "file:///tmp/openclaw-ai.tgz",
        "@openclaw/gateway-client": "file:///tmp/openclaw-gateway-client.tgz",
        "@openclaw/gateway-protocol": "file:///tmp/openclaw-gateway-protocol.tgz",
        openclaw: "file:///tmp/openclaw.tgz",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes a gateway-packages-only local project when the root does not require AI", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-release-check-install-test-"));
    try {
      writePackedTarballInstallManifest(
        root,
        "/tmp/openclaw.tgz",
        ["/tmp/openclaw-gateway-client.tgz", "/tmp/openclaw-gateway-protocol.tgz"],
        false,
      );
      const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
        dependencies?: Record<string, string>;
      };
      expect(manifest.dependencies).toEqual({
        "@openclaw/gateway-client": "file:///tmp/openclaw-gateway-client.tgz",
        "@openclaw/gateway-protocol": "file:///tmp/openclaw-gateway-protocol.tgz",
        openclaw: "file:///tmp/openclaw.tgz",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("packs the local AI workspace when no prepared tarball is supplied", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-release-check-ai-pack-test-"));
    try {
      const tarballs = prepareReleaseCheckLocalPackageTarballs({
        tmpRoot: root,
        packLocalAi: (packDestination) => {
          const filename = "openclaw-ai-2026.7.1-beta.3.tgz";
          writeFileSync(join(packDestination, filename), "fixture");
          return [{ filename }];
        },
      });
      expect(tarballs).toEqual([join(root, "ai-pack", "openclaw-ai-2026.7.1-beta.3.tgz")]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prefers prepared core package tarballs over packing the AI workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-release-check-ai-pack-test-"));
    try {
      const preparedDir = join(root, "prepared");
      mkdirSync(preparedDir);
      const preparedTarball = join(preparedDir, "openclaw-ai-2026.7.1-beta.3.tgz");
      const gatewayProtocolTarball = join(
        preparedDir,
        "openclaw-gateway-protocol-2026.7.1-beta.3.tgz",
      );
      const gatewayClientTarball = join(preparedDir, "openclaw-gateway-client-2026.7.1-beta.3.tgz");
      writeFileSync(preparedTarball, "fixture");
      writeFileSync(gatewayClientTarball, "fixture");
      writeFileSync(gatewayProtocolTarball, "fixture");
      const tarballs = prepareReleaseCheckLocalPackageTarballs({
        tmpRoot: root,
        tarballDir: preparedDir,
        packLocalAi: () => {
          throw new Error("workspace pack should not run");
        },
      });
      expect(tarballs).toEqual([preparedTarball, gatewayClientTarball, gatewayProtocolTarball]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a packed install without the local AI tarball", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-release-check-install-test-"));
    try {
      expect(() => writePackedTarballInstallManifest(root, "/tmp/openclaw.tgz", [])).toThrow(
        "requires exactly one @openclaw/ai tarball",
      );
      expect(() =>
        writePackedTarballInstallManifest(root, "/tmp/openclaw.tgz", [
          "/tmp/openclaw-ai-one.tgz",
          "/tmp/openclaw-ai-two.tgz",
        ]),
      ).toThrow("requires exactly one @openclaw/ai tarball");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects missing, incomplete, or ambiguous local package tarball directories", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-release-check-tarball-test-"));
    try {
      expect(() => resolveReleaseCheckLocalPackageTarballs(join(root, "missing"))).toThrow(
        RELEASE_CHECK_LOCAL_PACKAGE_TARBALL_DIR_ENV,
      );
      const empty = join(root, "empty");
      mkdirSync(empty);
      expect(() => resolveReleaseCheckLocalPackageTarballs(empty)).toThrow(
        "must contain exactly one @openclaw/ai tarball",
      );
      writeFileSync(join(empty, "one.tgz"), "fixture");
      writeFileSync(join(empty, "two.tgz"), "fixture");
      expect(() => resolveReleaseCheckLocalPackageTarballs(empty)).toThrow(
        "contains an unsupported package tarball",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("seeds packaged activation smoke with an included channel plugin", () => {
    const homeDir = mkdtempSync(join(tmpdir(), "openclaw-release-check-test-"));
    try {
      writePackedBundledPluginActivationConfig(homeDir);
      const config = JSON.parse(
        readFileSync(join(homeDir, ".openclaw", "openclaw.json"), "utf8"),
      ) as {
        channels?: Record<string, unknown>;
        plugins?: { entries?: Record<string, unknown> };
      };

      const pluginEntries = requirePluginEntries(config);
      const channels = Object.keys(config.channels ?? {});
      expect(channels.length).toBeGreaterThan(0);
      const excluded = collectRootPackageExcludedExtensionDirs();
      const artifacts = listBundledPluginPackArtifacts();
      for (const channel of channels) {
        expect(pluginEntries).toHaveProperty(channel);
        expect(excluded.has(channel)).toBe(false);
        const manifest = JSON.parse(
          readFileSync(join("extensions", channel, "openclaw.plugin.json"), "utf8"),
        ) as { channels: string[] };
        expect(manifest.channels).toContain(channel);
        expect(artifacts).toContain(`dist/extensions/${channel}/openclaw.plugin.json`);
      }
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
