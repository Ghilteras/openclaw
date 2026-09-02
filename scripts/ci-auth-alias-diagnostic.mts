// One-shot diagnostic branch tooling; not a production repair or release gate.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const targetSha = "5e6117d17d92dcac2ef6da6d609eb423b089a77a";
const root = process.cwd();
const tooling = path.resolve(import.meta.dirname, "..");
const artifacts = path.join(root, ".artifacts", "ci-auth-alias-diagnostic");
const tracerPath = "test/ci-auth-alias-trace.ts";
const eventName = "openclaw:ci-auth-alias";
const digest = (content: string | Buffer) => createHash("sha256").update(content).digest("hex");
type Entry = { file: string; before: string; after: string };
type Receipt = { sourceSha: string; entries: Entry[]; tracerHash: string };

function replaceOnce(source: string, oldText: string, newText: string): string {
  if (!source.includes(oldText) || source.indexOf(oldText) !== source.lastIndexOf(oldText)) {
    throw new Error(`Diagnostic anchor is missing or ambiguous: ${oldText.slice(0, 100)}`);
  }
  return source.replace(oldText, newText);
}

function prepareDiagnostic(): void {
  const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (sourceSha !== targetSha) {
    throw new Error(`Expected frozen diagnostic source ${targetSha}; got ${sourceSha}`);
  }
  if (fs.existsSync(artifacts) || fs.existsSync(path.join(root, tracerPath))) {
    throw new Error("Diagnostic artifacts already exist; inspect rather than overwrite them");
  }
  if (fs.statfsSync(root).type === 0x01021994) {
    throw new Error("Refusing tmpfs diagnostic proof");
  }
  const edits: Array<[string, (source: string) => string]> = [
    ["test/setup.ts", (source) => `import "./ci-auth-alias-trace.js";\n${source}`],
    [
      "test/non-isolated-runner.ts",
      (source) => {
        const before = replaceOnce(
          source,
          "  override async onAfterRunFiles() {\n    await super.onAfterRunFiles();",
          `  override async onAfterRunFiles() {\n    process.emit("${eventName}", { stage: "before-cleanup" });\n    await super.onAfterRunFiles();`,
        );
        return replaceOnce(
          before,
          "      internals.workerState.moduleExecutionInfo,\n    );\n  }",
          `      internals.workerState.moduleExecutionInfo,\n    );\n    process.emit("${eventName}", { stage: "after-cleanup" });\n  }`,
        );
      },
    ],
    [
      "src/agents/auth-profiles/order.ts",
      (source) =>
        replaceOnce(
          source,
          "): boolean {\n  return isProfileProviderCompatibleWithAuthProvider({",
          `): boolean {\n  process.emit("${eventName}", { stage: "compatibility", provider: params.provider, storedProvider: params.credential.provider, resolver: resolveProviderIdForAuth });\n  return isProfileProviderCompatibleWithAuthProvider({`,
        ),
    ],
    [
      "src/agents/auth-profiles/session-override.test-support.ts",
      (source) => {
        let updated = replaceOnce(
          source,
          'vi.mock("../provider-auth-aliases.js", () => ({\n  resolveProviderIdForAuth: authStoreMocks.resolveProviderIdForAuth,\n}));',
          `vi.mock("../provider-auth-aliases.js", () => {\n  process.emit("${eventName}", { stage: "alias-mock-factory", resolver: authStoreMocks.resolveProviderIdForAuth });\n  return { resolveProviderIdForAuth: authStoreMocks.resolveProviderIdForAuth };\n});`,
        );
        updated = replaceOnce(
          updated,
          "  return (\n    await resolveSessionAuthSelection({",
          "  const selection = await resolveSessionAuthSelection({",
        );
        return replaceOnce(
          updated,
          "    })\n  )?.profileId;",
          `    });\n  process.emit("${eventName}", { stage: "selection", provider: params.provider ?? "openai", profileId: selection?.profileId, fixtureResolver: authStoreMocks.resolveProviderIdForAuth });\n  return selection?.profileId;`,
        );
      },
    ],
  ];
  // Validate every input and anchor before the first source write.
  const changes = edits.map(([file, transform]) => {
    const before = fs.readFileSync(path.join(root, file), "utf8");
    const canonical = execFileSync("git", ["show", `${targetSha}:${file}`], { encoding: "utf8" });
    if (before !== canonical) {
      throw new Error(`Unexpected source edit: ${file}`);
    }
    return { file, before, after: transform(before) };
  });
  const tracer = fs.readFileSync(path.join(tooling, tracerPath));
  const plan = fs.readFileSync(path.join(tooling, "test/ci-auth-alias-plan.json"), "utf8");
  fs.mkdirSync(artifacts, { recursive: true });
  const receipt: Receipt = {
    sourceSha,
    entries: changes.map(({ file, before, after }) => ({
      file,
      before: digest(before),
      after: digest(after),
    })),
    tracerHash: digest(tracer),
  };
  for (const { file, before, after } of changes) {
    const original = path.join(artifacts, "original", file);
    fs.mkdirSync(path.dirname(original), { recursive: true });
    fs.writeFileSync(original, before);
    fs.writeFileSync(path.join(root, file), after);
  }
  fs.writeFileSync(path.join(root, tracerPath), tracer);
  fs.writeFileSync(path.join(artifacts, "receipt.json"), JSON.stringify(receipt, null, 2));
  fs.writeFileSync(path.join(artifacts, "plan.json"), plan);
  const environment: Record<string, string> = {
    HOME: path.join(artifacts, "home"),
    USERPROFILE: path.join(artifacts, "home"),
    TMPDIR: path.join(artifacts, "tmp"),
    TMP: path.join(artifacts, "tmp"),
    TEMP: path.join(artifacts, "tmp"),
    XDG_CONFIG_HOME: path.join(artifacts, "xdg-config"),
    XDG_DATA_HOME: path.join(artifacts, "xdg-data"),
    XDG_CACHE_HOME: path.join(artifacts, "xdg-cache"),
    OPENCLAW_STATE_DIR: path.join(artifacts, "state"),
    OPENCLAW_CONFIG_PATH: path.join(artifacts, "state", "openclaw.json"),
    OPENCLAW_CI_ALIAS_TRACE_DIR: path.join(artifacts, "trace"),
    OPENCLAW_NODE_TEST_GROUPS_JSON: JSON.stringify(JSON.parse(plan)),
    OPENCLAW_NODE_TEST_PLAN_CONCURRENCY: "1",
    OPENCLAW_VITEST_MAX_WORKERS: "2",
    OPENCLAW_VITEST_NO_OUTPUT_RETRY: "0",
    NODE_OPTIONS: "--max-old-space-size=8192",
  };
  for (const [key, value] of Object.entries(environment)) {
    if (
      key.endsWith("HOME") ||
      key === "HOME" ||
      key === "TMPDIR" ||
      key === "OPENCLAW_STATE_DIR" ||
      key === "OPENCLAW_CI_ALIAS_TRACE_DIR"
    ) {
      fs.mkdirSync(value, { recursive: true });
    }
  }
  fs.writeFileSync(path.join(artifacts, "environment.json"), JSON.stringify(environment, null, 2));
  if (process.env.GITHUB_ENV) {
    fs.appendFileSync(
      process.env.GITHUB_ENV,
      Object.entries(environment)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(""),
    );
  }
  console.log(
    JSON.stringify({
      sourceSha,
      node: process.version,
      instrumentedFiles: receipt.entries.map(({ file }) => file),
    }),
  );
}

function restoreDiagnostic(): void {
  const receipt: Receipt = JSON.parse(
    fs.readFileSync(path.join(artifacts, "receipt.json"), "utf8"),
  );
  for (const entry of receipt.entries) {
    if (digest(fs.readFileSync(path.join(root, entry.file))) !== entry.after) {
      throw new Error(`Refusing to overwrite unexpected diagnostic changes: ${entry.file}`);
    }
    if (digest(fs.readFileSync(path.join(artifacts, "original", entry.file))) !== entry.before) {
      throw new Error(`Corrupt diagnostic original: ${entry.file}`);
    }
  }
  if (digest(fs.readFileSync(path.join(root, tracerPath))) !== receipt.tracerHash) {
    throw new Error("Unexpected trace-module edit");
  }
  for (const entry of receipt.entries) {
    fs.copyFileSync(path.join(artifacts, "original", entry.file), path.join(root, entry.file));
  }
  fs.unlinkSync(path.join(root, tracerPath));
}

try {
  if (process.argv[2] === "prepare") {
    prepareDiagnostic();
  } else if (process.argv[2] === "restore") {
    restoreDiagnostic();
  } else {
    throw new Error("Expected prepare or restore");
  }
} catch (error) {
  console.error(error);
  console.error("[ci-alias] FAILED (exit 1)");
  process.exitCode = 1;
}
