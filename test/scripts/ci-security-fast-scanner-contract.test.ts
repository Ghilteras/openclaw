import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const contractPath = ".github/security-fast-scanners.json";
const compilerPath = ".github/actions/security-fast-scanners/compile.py";

function compile(contract = contractPath) {
  const root = tempDirs.make("security-fast-scanner-contract-");
  const outputConfig = join(root, "pre-commit.json");
  const outputRequirements = join(root, "requirements.txt");
  const trustedZizmorConfig = join(root, "zizmor.yml");
  writeFileSync(trustedZizmorConfig, "rules: {}\n");
  const result = spawnSync(
    "python3",
    [
      compilerPath,
      "--contract",
      contract,
      "--trusted-zizmor-config",
      trustedZizmorConfig,
      "--output-config",
      outputConfig,
      "--output-requirements",
      outputRequirements,
    ],
    { encoding: "utf8" },
  );
  return { outputConfig, outputRequirements, result, root, trustedZizmorConfig };
}

describe("security-fast scanner contract", () => {
  it("materializes the pinned effective hooks with only the system adapter applied", () => {
    const contract = JSON.parse(readFileSync(contractPath, "utf8")) as {
      preCommitPackage: string;
      scanners: Array<{
        hook: Record<string, unknown>;
        package: string;
        source: { repository: string; revision: string };
      }>;
    };
    expect(contract.preCommitPackage).toBe("pre-commit==4.6.2");
    expect(contract.scanners.map((scanner) => scanner.package)).toEqual([
      "pre-commit-hooks==6.0.0",
      "zizmor==1.29.0",
    ]);
    expect(contract.scanners.map((scanner) => scanner.source)).toEqual([
      {
        repository: "https://github.com/pre-commit/pre-commit-hooks",
        revision: "v6.0.0",
      },
      {
        repository: "https://github.com/zizmorcore/zizmor-pre-commit",
        revision: "451b56af716f9f0d0c2b816503a3fd0cf8b036fa",
      },
    ]);

    const compiled = compile();
    expect(compiled.result.status, compiled.result.stderr).toBe(0);
    expect(readFileSync(compiled.outputRequirements, "utf8")).toBe(
      "pre-commit==4.6.2\npre-commit-hooks==6.0.0\nzizmor==1.29.0\n",
    );

    const output = JSON.parse(readFileSync(compiled.outputConfig, "utf8")) as {
      repos: Array<{ hooks: Array<Record<string, unknown>>; repo: string }>;
    };
    expect(output.repos).toHaveLength(1);
    expect(output.repos[0]?.repo).toBe("local");
    expect(output.repos[0]?.hooks).toHaveLength(contract.scanners.length);
    for (const [index, scanner] of contract.scanners.entries()) {
      const adapted = output.repos[0]?.hooks[index];
      expect(adapted).toEqual({
        ...scanner.hook,
        language: "system",
        args:
          scanner.hook.id === "zizmor"
            ? [
                "--config",
                compiled.trustedZizmorConfig,
                "--persona=regular",
                "--min-severity=medium",
                "--min-confidence=medium",
              ]
            : scanner.hook.args,
      });
    }
  });

  it("rejects incomplete contracts before publishing scanner outputs", () => {
    const root = tempDirs.make("security-fast-scanner-contract-invalid-");
    const invalidContract = join(root, "contract.json");
    mkdirSync(root, { recursive: true });
    const contract = JSON.parse(readFileSync(contractPath, "utf8")) as Record<string, unknown>;
    delete contract.scanners;
    writeFileSync(invalidContract, JSON.stringify(contract));

    const compiled = compile(invalidContract);
    expect(compiled.result.status).not.toBe(0);
    expect(compiled.result.stderr).toContain("contract schema mismatch");
    expect(() => readFileSync(compiled.outputConfig, "utf8")).toThrow();
    expect(() => readFileSync(compiled.outputRequirements, "utf8")).toThrow();
  });
});
