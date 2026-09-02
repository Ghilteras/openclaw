import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { runGlobalPackageUpdateSteps } from "./package-update-steps.js";
import {
  createNpmTarget,
  createRootRunner,
  writePackageRoot,
} from "./package-update-steps.test-support.js";
import type { CommandRunner } from "./update-global.js";

describe("npm lifecycle policy preflight", () => {
  it.each([false, true])(
    "verifies the original package before recovery from preflight refusal (corrupt=%s)",
    async (corrupt) => {
      await withTestDir({ prefix: "openclaw-recovery-preflight-" }, async (base) => {
        const globalRoot = path.join(base, "lib", "node_modules");
        const target = createNpmTarget(globalRoot);
        const packageRoot = path.join(globalRoot, "openclaw");
        await writePackageRoot(packageRoot, "1.0.0");
        if (corrupt) {
          await fs.rm(path.join(packageRoot, "dist", "index.js"));
        }
        target.npmOwner = {
          version: null,
          lifecyclePolicy: null,
          probeError: "version probe failed",
        };
        const runStep = vi.fn();
        const result = await runGlobalPackageUpdateSteps({
          installTarget: target,
          installSpec: "openclaw@2.0.0",
          packageName: "openclaw",
          runCommand: createRootRunner(globalRoot),
          runStep,
          timeoutMs: 1000,
        });
        expect(result.failedStep).not.toBeNull();
        expect(runStep).not.toHaveBeenCalled();
        expect(result.recovery).toEqual(
          corrupt
            ? { serviceRestartSafe: false, reason: "runtime-verification-failed" }
            : { serviceRestartSafe: true, version: "1.0.0" },
        );
      });
    },
  );

  it("stops before mutation when the owning npm version is unknown", async () => {
    const runStep = vi.fn();
    const runCommand = vi.fn<CommandRunner>();
    const installTarget = createNpmTarget("/tmp/npm-policy-test/lib/node_modules");
    installTarget.npmOwner = {
      version: null,
      lifecyclePolicy: null,
      probeError: "version probe failed",
    };

    const result = await runGlobalPackageUpdateSteps({
      installTarget,
      installSpec: "openclaw@2.0.0",
      packageName: "openclaw",
      runCommand,
      runStep,
      timeoutMs: 1000,
    });

    expect(runCommand).not.toHaveBeenCalled();
    expect(result.failedStep?.stderrTail).toContain("Unable to determine the owning npm version");
    expect(runStep).not.toHaveBeenCalled();
  });
});

describe("package update recovery safety", () => {
  it("recovers the verified original when staging preparation fails before hooks run", async () => {
    await withTestDir({ prefix: "openclaw-package-stage-recovery-" }, async (base) => {
      const globalRoot = path.join(base, "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      await writePackageRoot(packageRoot, "1.0.0");
      const stage = vi
        .spyOn(fs, "mkdtemp")
        .mockRejectedValueOnce(Object.assign(new Error("stage denied"), { code: "EACCES" }));
      const runStep = vi.fn();
      try {
        const result = await runGlobalPackageUpdateSteps({
          installTarget: createNpmTarget(globalRoot),
          installSpec: "openclaw@2.0.0",
          packageName: "openclaw",
          packageRoot,
          runCommand: createRootRunner(globalRoot),
          runStep,
          timeoutMs: 1000,
        });
        expect(result.failedStep?.name).toBe("global install stage");
        expect(result.recovery).toEqual({ serviceRestartSafe: true, version: "1.0.0" });
        expect(runStep).not.toHaveBeenCalled();
        expect(await fs.readFile(path.join(packageRoot, "dist", "index.js"), "utf8")).toBe(
          "export {};\n",
        );
      } finally {
        stage.mockRestore();
      }
    });
  });

  it.each(
    (["pnpm", "bun", "npm"] as const).flatMap((manager) =>
      ["install exit", "install throw", "doctor throw"].map((failure) => ({ manager, failure })),
    ),
  )(
    "keeps $manager recovery stopped after $failure mutates the live tree",
    async ({ manager, failure }) => {
      await withTestDir({ prefix: "openclaw-package-recovery-" }, async (base) => {
        const globalRoot = path.join(base, "global");
        const packageRoot = path.join(globalRoot, "openclaw");
        await writePackageRoot(packageRoot, "1.0.0");
        const params = {
          installTarget:
            manager === "npm"
              ? createNpmTarget(globalRoot)
              : { manager, command: manager, globalRoot, packageRoot },
          installSpec: "openclaw@2.0.0",
          packageName: "openclaw",
          packageRoot,
          runCommand: createRootRunner(globalRoot),
          runStep: async ({ name, argv }: { name: string; argv: string[] }) => {
            await writePackageRoot(packageRoot, "2.0.0");
            if (failure === "install throw") {
              throw new Error("install interrupted after replacement");
            }
            return {
              name,
              command: argv.join(" "),
              cwd: globalRoot,
              durationMs: 0,
              exitCode: failure === "install exit" ? 1 : 0,
            };
          },
          postVerifyStep: async () => {
            throw new Error("doctor interrupted after replacement");
          },
          timeoutMs: 1000,
        };
        const result = await runGlobalPackageUpdateSteps(params);

        expect(result.failedStep).not.toBeNull();
        expect(result.recovery).toEqual({
          serviceRestartSafe: false,
          reason: "runtime-verification-failed",
        });
        if (failure === "doctor throw") {
          expect(result.afterVersion).toBe("2.0.0");
        }
        expect(await fs.readFile(path.join(packageRoot, "package.json"), "utf8")).toContain(
          '"version":"2.0.0"',
        );
      });
    },
  );

  it.each(["backup", "activation"] as const)(
    "handles a %s move rejected after staged lifecycle mutates state",
    async (failure) => {
      await withTestDir({ prefix: "openclaw-package-move-recovery-" }, async (base) => {
        const globalRoot = path.join(base, "lib", "node_modules");
        const packageRoot = path.join(globalRoot, "openclaw");
        await writePackageRoot(packageRoot, "1.0.0");
        const stateCanary = path.join(base, "synthetic-state");
        let source = failure === "backup" ? packageRoot : "";
        let copied = false;
        let cleanupRejected = false;
        const rename = fs.rename.bind(fs);
        const unlink = fs.unlink.bind(fs);
        const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
          if (String(args[0]) === source && !copied) {
            copied = true;
            throw Object.assign(new Error("cross-device move"), { code: "EXDEV" });
          }
          return await rename(...args);
        });
        const unlinkSpy = vi.spyOn(fs, "unlink").mockImplementation(async (target) => {
          await unlink(target);
          if (String(target) === path.join(source, "dist", "index.js") && !cleanupRejected) {
            cleanupRejected = true;
            throw Object.assign(new Error("source cleanup failed after commit"), {
              code: "EACCES",
            });
          }
        });
        let result: Awaited<ReturnType<typeof runGlobalPackageUpdateSteps>>;
        try {
          result = await runGlobalPackageUpdateSteps({
            installTarget: createNpmTarget(globalRoot),
            installSpec: "openclaw@2.0.0",
            packageName: "openclaw",
            packageRoot,
            runCommand: createRootRunner(globalRoot),
            timeoutMs: 1000,
            runStep: async ({ name, argv }) => {
              const prefix = argv[argv.indexOf("--prefix") + 1];
              if (!prefix) {
                throw new Error("missing stage prefix");
              }
              const staged = path.join(prefix, "lib", "node_modules", "openclaw");
              await writePackageRoot(staged, "2.0.0");
              await fs.writeFile(stateCanary, "migrated by staged lifecycle");
              if (failure === "activation") {
                source = staged;
              }
              return { name, command: argv.join(" "), cwd: prefix, durationMs: 0, exitCode: 0 };
            },
          });
        } finally {
          renameSpy.mockRestore();
          unlinkSpy.mockRestore();
        }
        expect(cleanupRejected).toBe(true);
        expect(await fs.readFile(stateCanary, "utf8")).toBe("migrated by staged lifecycle");
        // Main's old activation decision allowed anything except an explicit false.
        // Restored package bytes cannot undo the lifecycle's state mutation.
        expect(result.recovery?.serviceRestartSafe).toBe(false);
        expect(result.failedStep?.stderrTail).toContain("source cleanup failed after commit");
        if (failure === "backup") {
          expect(result.recovery?.serviceRestartSafe).toBe(false);
          await expect(
            fs.readFile(path.join(packageRoot, "dist", "index.js")),
          ).rejects.toMatchObject({ code: "ENOENT" });
          const backups = (await fs.readdir(globalRoot)).filter((name) =>
            name.startsWith(`.openclaw.package-backup-${process.pid}-`),
          );
          expect(backups).toHaveLength(1);
          await expect(
            fs.readFile(path.join(globalRoot, backups[0] ?? "", "dist", "index.js"), "utf8"),
          ).resolves.toBe("export {};\n");
        } else {
          expect(result.afterVersion).toBe("1.0.0");
          await expect(
            fs.readFile(path.join(packageRoot, "dist", "index.js"), "utf8"),
          ).resolves.toBe("export {};\n");
        }
      });
    },
  );

  it.each(["blocking", "throwing", "missing", "success"] as const)(
    "commits staged npm only after a %s Doctor outcome",
    async (outcome) => {
      await withTestDir({ prefix: "openclaw-package-recovery-swap-" }, async (base) => {
        const prefix = path.join(base, "prefix");
        const globalRoot = path.join(prefix, "lib", "node_modules");
        const packageRoot = path.join(globalRoot, "openclaw");
        const binDir = path.join(prefix, "bin");
        const shimNames = ["openclaw", "openclaw.cmd", "openclaw.ps1"];
        const stateCanary = path.join(base, "candidate-doctor-state");
        await writePackageRoot(packageRoot, "1.0.0");
        await fs.mkdir(binDir, { recursive: true });
        await Promise.all(
          shimNames.map((name) => fs.writeFile(path.join(binDir, name), `old ${name}\n`, "utf8")),
        );

        const result = await runGlobalPackageUpdateSteps({
          installTarget: createNpmTarget(globalRoot),
          installSpec: "openclaw@2.0.0",
          packageName: "openclaw",
          packageRoot,
          runCommand: createRootRunner(globalRoot),
          runStep: async ({ name, argv }) => {
            const stagePrefix = argv[argv.indexOf("--prefix") + 1];
            if (!stagePrefix) {
              throw new Error("missing stage prefix");
            }
            await writePackageRoot(
              path.join(stagePrefix, "lib", "node_modules", "openclaw"),
              "2.0.0",
            );
            const stagedBinDir = path.join(stagePrefix, "bin");
            await fs.mkdir(stagedBinDir, { recursive: true });
            await Promise.all(
              shimNames.map((shimName) =>
                fs.writeFile(path.join(stagedBinDir, shimName), `new ${shimName}\n`, "utf8"),
              ),
            );
            return {
              name,
              command: argv.join(" "),
              cwd: stagePrefix,
              durationMs: 0,
              exitCode: 0,
            };
          },
          postVerifyStep: async (candidateRoot) => {
            expect(candidateRoot).toBe(packageRoot);
            await expect(
              fs.readFile(path.join(candidateRoot, "package.json"), "utf8"),
            ).resolves.toContain('"version":"2.0.0"');
            for (const shimName of shimNames) {
              await expect(fs.readFile(path.join(binDir, shimName), "utf8")).resolves.toBe(
                `new ${shimName}\n`,
              );
            }
            await fs.writeFile(stateCanary, "mutated by candidate Doctor\n", "utf8");
            if (outcome === "throwing") {
              throw new Error("doctor interrupted after swap");
            }
            if (outcome === "missing") {
              return null;
            }
            return {
              name: "openclaw doctor",
              command: "openclaw doctor --non-interactive --fix",
              cwd: candidateRoot,
              durationMs: 0,
              exitCode: outcome === "blocking" ? 1 : 0,
              stderrTail: outcome === "blocking" ? "doctor rejected candidate" : null,
            };
          },
          timeoutMs: 1000,
        });

        const expectedVersion = outcome === "success" ? "2.0.0" : "1.0.0";
        expect(result.afterVersion).toBe(expectedVersion);
        expect(await fs.readFile(stateCanary, "utf8")).toBe("mutated by candidate Doctor\n");
        await expect(
          fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
        ).resolves.toContain(`"version":"${expectedVersion}"`);
        for (const shimName of shimNames) {
          await expect(fs.readFile(path.join(binDir, shimName), "utf8")).resolves.toBe(
            `${outcome === "success" ? "new" : "old"} ${shimName}\n`,
          );
        }
        expect((await fs.readdir(globalRoot)).filter((entry) => entry.startsWith("."))).toEqual([]);
        if (outcome === "success") {
          expect(result.failedStep).toBeNull();
          expect(result.recovery).toEqual({ serviceRestartSafe: true, version: "2.0.0" });
        } else {
          expect(result.failedStep).not.toBeNull();
          expect(result.recovery).toEqual({
            serviceRestartSafe: false,
            reason: "runtime-verification-failed",
            packageRollbackVerified: true,
          });
          expect(
            result.steps.find((step) => step.name === "global install swap")?.stdoutTail,
          ).toContain("restored previous openclaw package and affected launchers");
          expect(
            result.steps.find((step) => step.name === "global install swap")?.stdoutTail,
          ).toContain("candidate Doctor may have changed persistent state");
        }
      });
    },
  );

  it("verifies rollback after the old package is parked through copy fallback", async () => {
    await withTestDir({ prefix: "openclaw-package-recovery-backup-exdev-" }, async (base) => {
      const globalRoot = path.join(base, "prefix", "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      await writePackageRoot(packageRoot, "1.0.0");

      const rename = fs.rename.bind(fs);
      let forcedCopyFallback = false;
      const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
        const [from, to] = args;
        if (
          !forcedCopyFallback &&
          String(from) === packageRoot &&
          path.basename(String(to)).startsWith(".openclaw.package-backup-")
        ) {
          forcedCopyFallback = true;
          throw Object.assign(new Error("cross-device package backup"), { code: "EXDEV" });
        }
        return await rename(...args);
      });

      let result: Awaited<ReturnType<typeof runGlobalPackageUpdateSteps>>;
      try {
        result = await runGlobalPackageUpdateSteps({
          installTarget: createNpmTarget(globalRoot),
          installSpec: "openclaw@2.0.0",
          packageName: "openclaw",
          packageRoot,
          runCommand: createRootRunner(globalRoot),
          runStep: async ({ name, argv }) => {
            const stagePrefix = argv[argv.indexOf("--prefix") + 1];
            if (!stagePrefix) {
              throw new Error("missing stage prefix");
            }
            await writePackageRoot(
              path.join(stagePrefix, "lib", "node_modules", "openclaw"),
              "2.0.0",
            );
            return {
              name,
              command: argv.join(" "),
              cwd: stagePrefix,
              durationMs: 0,
              exitCode: 0,
            };
          },
          postVerifyStep: async (candidateRoot) => ({
            name: "openclaw doctor",
            command: "openclaw doctor --non-interactive --fix",
            cwd: candidateRoot,
            durationMs: 0,
            exitCode: 1,
            stderrTail: "doctor rejected candidate",
          }),
          timeoutMs: 1000,
        });
      } finally {
        renameSpy.mockRestore();
      }

      expect(forcedCopyFallback).toBe(true);
      expect(result.afterVersion).toBe("1.0.0");
      expect(result.recovery).toEqual({
        serviceRestartSafe: false,
        reason: "runtime-verification-failed",
        packageRollbackVerified: true,
      });
      await expect(fs.readFile(path.join(packageRoot, "dist", "index.js"), "utf8")).resolves.toBe(
        "export {};\n",
      );
      expect((await fs.readdir(globalRoot)).filter((entry) => entry.startsWith("."))).toEqual([]);
    });
  });

  it("retains launcher backup evidence when post-Doctor rollback fails", async () => {
    await withTestDir({ prefix: "openclaw-package-recovery-failed-rollback-" }, async (base) => {
      const prefix = path.join(base, "prefix");
      const globalRoot = path.join(prefix, "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      const binDir = path.join(prefix, "bin");
      const targetShim = path.join(binDir, "openclaw");
      const targetCmdShim = path.join(binDir, "openclaw.cmd");
      await writePackageRoot(packageRoot, "1.0.0");
      await fs.mkdir(binDir, { recursive: true });
      await fs.writeFile(targetShim, "old openclaw\n", "utf8");
      await fs.writeFile(targetCmdShim, "old openclaw.cmd\n", "utf8");
      const copyFile = fs.copyFile.bind(fs);
      const copyFileSpy = vi.spyOn(fs, "copyFile").mockImplementation(async (...args) => {
        const source = String(args[0]);
        if (
          String(args[1]) === targetCmdShim &&
          path.basename(path.dirname(source)).startsWith(".openclaw.shim-backup-")
        ) {
          throw Object.assign(new Error("launcher restoration denied"), { code: "EACCES" });
        }
        return await copyFile(...args);
      });
      let result: Awaited<ReturnType<typeof runGlobalPackageUpdateSteps>>;
      try {
        result = await runGlobalPackageUpdateSteps({
          installTarget: createNpmTarget(globalRoot),
          installSpec: "openclaw@2.0.0",
          packageName: "openclaw",
          packageRoot,
          runCommand: createRootRunner(globalRoot),
          runStep: async ({ name, argv }) => {
            const stagePrefix = argv[argv.indexOf("--prefix") + 1];
            if (!stagePrefix) {
              throw new Error("missing stage prefix");
            }
            await writePackageRoot(
              path.join(stagePrefix, "lib", "node_modules", "openclaw"),
              "2.0.0",
            );
            const stagedBinDir = path.join(stagePrefix, "bin");
            await fs.mkdir(stagedBinDir, { recursive: true });
            await fs.writeFile(path.join(stagedBinDir, "openclaw"), "new openclaw\n", "utf8");
            await fs.writeFile(
              path.join(stagedBinDir, "openclaw.cmd"),
              "new openclaw.cmd\n",
              "utf8",
            );
            return {
              name,
              command: argv.join(" "),
              cwd: stagePrefix,
              durationMs: 0,
              exitCode: 0,
            };
          },
          postVerifyStep: async (candidateRoot) => ({
            name: "openclaw doctor",
            command: "openclaw doctor --non-interactive --fix",
            cwd: candidateRoot,
            durationMs: 0,
            exitCode: 1,
            stderrTail: "doctor rejected candidate",
          }),
          timeoutMs: 1000,
        });
      } finally {
        copyFileSpy.mockRestore();
      }

      expect(result.failedStep).toMatchObject({ name: "global install swap", exitCode: 1 });
      expect(result.failedStep?.stderrTail).toContain("launcher restoration denied");
      expect(result.failedStep?.stderrTail).toContain(`launcher ${targetCmdShim} was not restored`);
      expect(result.recovery).toEqual({
        serviceRestartSafe: false,
        reason: "runtime-verification-failed",
        packageRollbackVerified: false,
      });
      expect(result.afterVersion).toBe("1.0.0");
      await expect(fs.readFile(targetShim, "utf8")).resolves.toBe("old openclaw\n");
      await expect(fs.readFile(targetCmdShim, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      const backupDirs = (await fs.readdir(globalRoot)).filter((entry) =>
        entry.startsWith(".openclaw.shim-backup-"),
      );
      expect(backupDirs).toHaveLength(1);
      await expect(
        fs.readFile(path.join(globalRoot, backupDirs[0] ?? "", "openclaw.cmd"), "utf8"),
      ).resolves.toBe("old openclaw.cmd\n");
    });
  });

  it("restores the old package when post-backup metadata capture fails", async () => {
    await withTestDir({ prefix: "openclaw-package-recovery-backup-stat-" }, async (base) => {
      const globalRoot = path.join(base, "prefix", "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      const packageEntry = path.join(packageRoot, "dist", "index.js");
      await writePackageRoot(packageRoot, "1.0.0");
      await fs.writeFile(packageEntry, "original old package\n", "utf8");
      const lstat = fs.lstat.bind(fs);
      const lstatSpy = vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
        if (path.basename(String(args[0])).startsWith(".openclaw.package-backup-")) {
          throw Object.assign(new Error("backup metadata unavailable"), { code: "EACCES" });
        }
        return await lstat(...args);
      });

      let result: Awaited<ReturnType<typeof runGlobalPackageUpdateSteps>>;
      try {
        result = await runGlobalPackageUpdateSteps({
          installTarget: createNpmTarget(globalRoot),
          installSpec: "openclaw@2.0.0",
          packageName: "openclaw",
          packageRoot,
          runCommand: createRootRunner(globalRoot),
          runStep: async ({ name, argv }) => {
            const stagePrefix = argv[argv.indexOf("--prefix") + 1];
            if (!stagePrefix) {
              throw new Error("missing stage prefix");
            }
            await writePackageRoot(
              path.join(stagePrefix, "lib", "node_modules", "openclaw"),
              "2.0.0",
            );
            return {
              name,
              command: argv.join(" "),
              cwd: stagePrefix,
              durationMs: 0,
              exitCode: 0,
            };
          },
          timeoutMs: 1000,
        });
      } finally {
        lstatSpy.mockRestore();
      }

      expect(result.afterVersion).toBe("1.0.0");
      expect(result.recovery).toMatchObject({
        serviceRestartSafe: false,
        packageRollbackVerified: false,
      });
      expect(result.failedStep?.stderrTail).toContain("backup metadata unavailable");
      await expect(fs.readFile(packageEntry, "utf8")).resolves.toBe("original old package\n");
    });
  });

  it("does not verify rollback when candidate Doctor alters the parked old package", async () => {
    await withTestDir({ prefix: "openclaw-package-recovery-altered-backup-" }, async (base) => {
      const globalRoot = path.join(base, "prefix", "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      const packageEntry = path.join(packageRoot, "dist", "index.js");
      await writePackageRoot(packageRoot, "1.0.0");
      await fs.writeFile(packageEntry, "original old package\n", "utf8");

      const result = await runGlobalPackageUpdateSteps({
        installTarget: createNpmTarget(globalRoot),
        installSpec: "openclaw@2.0.0",
        packageName: "openclaw",
        packageRoot,
        runCommand: createRootRunner(globalRoot),
        runStep: async ({ name, argv }) => {
          const stagePrefix = argv[argv.indexOf("--prefix") + 1];
          if (!stagePrefix) {
            throw new Error("missing stage prefix");
          }
          await writePackageRoot(
            path.join(stagePrefix, "lib", "node_modules", "openclaw"),
            "2.0.0",
          );
          return {
            name,
            command: argv.join(" "),
            cwd: stagePrefix,
            durationMs: 0,
            exitCode: 0,
          };
        },
        postVerifyStep: async (candidateRoot) => {
          expect(candidateRoot).toBe(packageRoot);
          const backupName = (await fs.readdir(globalRoot)).find((entry) =>
            entry.startsWith(".openclaw.package-backup-"),
          );
          if (!backupName) {
            throw new Error("missing old-package backup during candidate Doctor");
          }
          await fs.writeFile(
            path.join(globalRoot, backupName, "dist", "index.js"),
            "altered old package\n",
            "utf8",
          );
          return {
            name: "openclaw doctor",
            command: "openclaw doctor --non-interactive --fix",
            cwd: candidateRoot,
            durationMs: 0,
            exitCode: 1,
            stderrTail: "doctor rejected candidate",
          };
        },
        timeoutMs: 1000,
      });

      expect(result.afterVersion).toBe("1.0.0");
      expect(result.recovery).toEqual({
        serviceRestartSafe: false,
        reason: "runtime-verification-failed",
        packageRollbackVerified: false,
      });
      expect(result.failedStep).toMatchObject({ name: "global install swap", exitCode: 1 });
      expect(result.failedStep?.stderrTail).toContain(
        "rollback verification failed: restored package tree does not match backup",
      );
      await expect(fs.readFile(packageEntry, "utf8")).resolves.toBe("altered old package\n");
    });
  });

  it("does not verify rollback when candidate Doctor alters a parked linked package", async () => {
    await withTestDir({ prefix: "openclaw-package-recovery-altered-link-" }, async (base) => {
      const globalRoot = path.join(base, "prefix", "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      const linkedRoot = path.join(base, "linked-openclaw");
      const linkedEntry = path.join(linkedRoot, "dist", "index.js");
      await writePackageRoot(linkedRoot, "1.0.0");
      await fs.writeFile(linkedEntry, "original linked package\n", "utf8");
      await fs.mkdir(globalRoot, { recursive: true });
      await fs.symlink(linkedRoot, packageRoot, process.platform === "win32" ? "junction" : "dir");

      const result = await runGlobalPackageUpdateSteps({
        installTarget: createNpmTarget(globalRoot),
        installSpec: "openclaw@2.0.0",
        packageName: "openclaw",
        packageRoot,
        runCommand: createRootRunner(globalRoot),
        runStep: async ({ name, argv }) => {
          const stagePrefix = argv[argv.indexOf("--prefix") + 1];
          if (!stagePrefix) {
            throw new Error("missing stage prefix");
          }
          await writePackageRoot(
            path.join(stagePrefix, "lib", "node_modules", "openclaw"),
            "2.0.0",
          );
          return {
            name,
            command: argv.join(" "),
            cwd: stagePrefix,
            durationMs: 0,
            exitCode: 0,
          };
        },
        postVerifyStep: async (candidateRoot) => {
          expect(candidateRoot).toBe(packageRoot);
          await fs.writeFile(linkedEntry, "altered linked package\n", "utf8");
          return {
            name: "openclaw doctor",
            command: "openclaw doctor --non-interactive --fix",
            cwd: candidateRoot,
            durationMs: 0,
            exitCode: 1,
            stderrTail: "doctor rejected candidate",
          };
        },
        timeoutMs: 1000,
      });

      expect(result.afterVersion).toBe("1.0.0");
      expect(result.recovery).toMatchObject({
        serviceRestartSafe: false,
        packageRollbackVerified: false,
      });
      expect(result.failedStep?.stderrTail).toContain(
        "rollback verification failed: restored package tree does not match backup",
      );
      await expect(fs.realpath(packageRoot)).resolves.toBe(linkedRoot);
      await expect(fs.readFile(linkedEntry, "utf8")).resolves.toBe("altered linked package\n");
    });
  });

  it.runIf(process.platform !== "win32")(
    "does not verify rollback when candidate Doctor alters special package mode bits",
    async () => {
      await withTestDir({ prefix: "openclaw-package-recovery-altered-mode-" }, async (base) => {
        const globalRoot = path.join(base, "prefix", "lib", "node_modules");
        const packageRoot = path.join(globalRoot, "openclaw");
        const packageEntry = path.join(packageRoot, "dist", "index.js");
        await writePackageRoot(packageRoot, "1.0.0");
        await fs.chmod(packageEntry, 0o755);

        const result = await runGlobalPackageUpdateSteps({
          installTarget: createNpmTarget(globalRoot),
          installSpec: "openclaw@2.0.0",
          packageName: "openclaw",
          packageRoot,
          runCommand: createRootRunner(globalRoot),
          runStep: async ({ name, argv }) => {
            const stagePrefix = argv[argv.indexOf("--prefix") + 1];
            if (!stagePrefix) {
              throw new Error("missing stage prefix");
            }
            await writePackageRoot(
              path.join(stagePrefix, "lib", "node_modules", "openclaw"),
              "2.0.0",
            );
            return {
              name,
              command: argv.join(" "),
              cwd: stagePrefix,
              durationMs: 0,
              exitCode: 0,
            };
          },
          postVerifyStep: async (candidateRoot) => {
            expect(candidateRoot).toBe(packageRoot);
            const backupName = (await fs.readdir(globalRoot)).find((entry) =>
              entry.startsWith(".openclaw.package-backup-"),
            );
            if (!backupName) {
              throw new Error("missing old-package backup during candidate Doctor");
            }
            await fs.chmod(path.join(globalRoot, backupName, "dist", "index.js"), 0o4755);
            return {
              name: "openclaw doctor",
              command: "openclaw doctor --non-interactive --fix",
              cwd: candidateRoot,
              durationMs: 0,
              exitCode: 1,
              stderrTail: "doctor rejected candidate",
            };
          },
          timeoutMs: 1000,
        });

        expect(result.afterVersion).toBe("1.0.0");
        expect(result.recovery).toMatchObject({
          serviceRestartSafe: false,
          packageRollbackVerified: false,
        });
        expect(result.failedStep?.stderrTail).toContain(
          "rollback verification failed: restored package tree does not match backup",
        );
        expect((await fs.stat(packageEntry)).mode & 0o7777).toBe(0o4755);
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not verify rollback when candidate Doctor alters an intermediate package symlink",
    async () => {
      await withTestDir(
        { prefix: "openclaw-package-recovery-altered-nested-link-" },
        async (base) => {
          const globalRoot = path.join(base, "prefix", "lib", "node_modules");
          const packageRoot = path.join(globalRoot, "openclaw");
          const externalEntry = path.join(base, "external-runtime.js");
          const replacementEntry = path.join(base, "replacement-runtime.js");
          const externalAlias = path.join(base, "external-alias.js");
          const packageLink = path.join(packageRoot, "dist", "external-runtime.js");
          await writePackageRoot(packageRoot, "1.0.0");
          await fs.writeFile(externalEntry, "original external runtime\n", "utf8");
          await fs.writeFile(replacementEntry, "original external runtime\n", "utf8");
          await fs.symlink(externalEntry, externalAlias);
          await fs.symlink(externalAlias, packageLink);

          const result = await runGlobalPackageUpdateSteps({
            installTarget: createNpmTarget(globalRoot),
            installSpec: "openclaw@2.0.0",
            packageName: "openclaw",
            packageRoot,
            runCommand: createRootRunner(globalRoot),
            runStep: async ({ name, argv }) => {
              const stagePrefix = argv[argv.indexOf("--prefix") + 1];
              if (!stagePrefix) {
                throw new Error("missing stage prefix");
              }
              await writePackageRoot(
                path.join(stagePrefix, "lib", "node_modules", "openclaw"),
                "2.0.0",
              );
              return {
                name,
                command: argv.join(" "),
                cwd: stagePrefix,
                durationMs: 0,
                exitCode: 0,
              };
            },
            postVerifyStep: async (candidateRoot) => {
              expect(candidateRoot).toBe(packageRoot);
              await fs.unlink(externalAlias);
              await fs.symlink(replacementEntry, externalAlias);
              return {
                name: "openclaw doctor",
                command: "openclaw doctor --non-interactive --fix",
                cwd: candidateRoot,
                durationMs: 0,
                exitCode: 1,
                stderrTail: "doctor rejected candidate",
              };
            },
            timeoutMs: 1000,
          });

          expect(result.afterVersion).toBe("1.0.0");
          expect(result.recovery).toMatchObject({
            serviceRestartSafe: false,
            packageRollbackVerified: false,
          });
          expect(result.failedStep?.stderrTail).toContain(
            "rollback verification failed: restored package tree does not match backup",
          );
          await expect(fs.readFile(packageLink, "utf8")).resolves.toBe(
            "original external runtime\n",
          );
          await expect(fs.readlink(externalAlias)).resolves.toBe(replacementEntry);
        },
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "verifies a stable rollback with a dangling non-directory symlink target",
    async () => {
      await withTestDir({ prefix: "openclaw-package-recovery-dangling-link-" }, async (base) => {
        const globalRoot = path.join(base, "prefix", "lib", "node_modules");
        const packageRoot = path.join(globalRoot, "openclaw");
        const packageEntry = path.join(packageRoot, "dist", "index.js");
        const danglingLink = path.join(packageRoot, "dist", "dangling.js");
        await writePackageRoot(packageRoot, "1.0.0");
        await fs.symlink(`${packageEntry}/child`, danglingLink);

        const result = await runGlobalPackageUpdateSteps({
          installTarget: createNpmTarget(globalRoot),
          installSpec: "openclaw@2.0.0",
          packageName: "openclaw",
          packageRoot,
          runCommand: createRootRunner(globalRoot),
          runStep: async ({ name, argv }) => {
            const stagePrefix = argv[argv.indexOf("--prefix") + 1];
            if (!stagePrefix) {
              throw new Error("missing stage prefix");
            }
            await writePackageRoot(
              path.join(stagePrefix, "lib", "node_modules", "openclaw"),
              "2.0.0",
            );
            return {
              name,
              command: argv.join(" "),
              cwd: stagePrefix,
              durationMs: 0,
              exitCode: 0,
            };
          },
          postVerifyStep: async (candidateRoot) => ({
            name: "openclaw doctor",
            command: "openclaw doctor --non-interactive --fix",
            cwd: candidateRoot,
            durationMs: 0,
            exitCode: 1,
            stderrTail: "doctor rejected candidate",
          }),
          timeoutMs: 1000,
        });

        expect(result.afterVersion).toBe("1.0.0");
        expect(result.recovery).toMatchObject({
          serviceRestartSafe: false,
          packageRollbackVerified: true,
        });
        await expect(fs.readlink(danglingLink)).resolves.toBe(`${packageEntry}/child`);
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not verify rollback when candidate Doctor splits an old-package hardlink",
    async () => {
      await withTestDir({ prefix: "openclaw-package-recovery-altered-hardlink-" }, async (base) => {
        const globalRoot = path.join(base, "prefix", "lib", "node_modules");
        const packageRoot = path.join(globalRoot, "openclaw");
        const packageEntry = path.join(packageRoot, "dist", "index.js");
        const hardlinkPeer = path.join(packageRoot, "dist", "hardlink-peer.js");
        await writePackageRoot(packageRoot, "1.0.0");
        await fs.link(packageEntry, hardlinkPeer);

        const result = await runGlobalPackageUpdateSteps({
          installTarget: createNpmTarget(globalRoot),
          installSpec: "openclaw@2.0.0",
          packageName: "openclaw",
          packageRoot,
          runCommand: createRootRunner(globalRoot),
          runStep: async ({ name, argv }) => {
            const stagePrefix = argv[argv.indexOf("--prefix") + 1];
            if (!stagePrefix) {
              throw new Error("missing stage prefix");
            }
            await writePackageRoot(
              path.join(stagePrefix, "lib", "node_modules", "openclaw"),
              "2.0.0",
            );
            return {
              name,
              command: argv.join(" "),
              cwd: stagePrefix,
              durationMs: 0,
              exitCode: 0,
            };
          },
          postVerifyStep: async (candidateRoot) => {
            expect(candidateRoot).toBe(packageRoot);
            const backupName = (await fs.readdir(globalRoot)).find((entry) =>
              entry.startsWith(".openclaw.package-backup-"),
            );
            if (!backupName) {
              throw new Error("missing old-package backup during candidate Doctor");
            }
            const backupPeer = path.join(globalRoot, backupName, "dist", "hardlink-peer.js");
            const contents = await fs.readFile(backupPeer);
            const mode = (await fs.stat(backupPeer)).mode;
            await fs.unlink(backupPeer);
            await fs.writeFile(backupPeer, contents);
            await fs.chmod(backupPeer, mode);
            return {
              name: "openclaw doctor",
              command: "openclaw doctor --non-interactive --fix",
              cwd: candidateRoot,
              durationMs: 0,
              exitCode: 1,
              stderrTail: "doctor rejected candidate",
            };
          },
          timeoutMs: 1000,
        });

        expect(result.afterVersion).toBe("1.0.0");
        expect(result.recovery).toMatchObject({
          serviceRestartSafe: false,
          packageRollbackVerified: false,
        });
        expect(result.failedStep?.stderrTail).toContain(
          "rollback verification failed: restored package tree does not match backup",
        );
        expect((await fs.stat(packageEntry)).ino).not.toBe((await fs.stat(hardlinkPeer)).ino);
        await expect(fs.readFile(hardlinkPeer, "utf8")).resolves.toBe("export {};\n");
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "keeps rollback unverified when both package fingerprints exceed the external-tree limit",
    async () => {
      await withTestDir({ prefix: "openclaw-package-recovery-bounded-link-" }, async (base) => {
        const globalRoot = path.join(base, "prefix", "lib", "node_modules");
        const packageRoot = path.join(globalRoot, "openclaw");
        const externalRoot = path.join(base, "external-tree");
        await writePackageRoot(packageRoot, "1.0.0");
        await fs.mkdir(externalRoot);
        for (let index = 0; index < 513; index += 1) {
          await fs.writeFile(path.join(externalRoot, `${index}.txt`), "", "utf8");
        }
        await fs.symlink(externalRoot, path.join(packageRoot, "dist", "external-tree"));

        const result = await runGlobalPackageUpdateSteps({
          installTarget: createNpmTarget(globalRoot),
          installSpec: "openclaw@2.0.0",
          packageName: "openclaw",
          packageRoot,
          runCommand: createRootRunner(globalRoot),
          runStep: async ({ name, argv }) => {
            const stagePrefix = argv[argv.indexOf("--prefix") + 1];
            if (!stagePrefix) {
              throw new Error("missing stage prefix");
            }
            await writePackageRoot(
              path.join(stagePrefix, "lib", "node_modules", "openclaw"),
              "2.0.0",
            );
            return {
              name,
              command: argv.join(" "),
              cwd: stagePrefix,
              durationMs: 0,
              exitCode: 0,
            };
          },
          postVerifyStep: async (candidateRoot) => ({
            name: "openclaw doctor",
            command: "openclaw doctor --non-interactive --fix",
            cwd: candidateRoot,
            durationMs: 0,
            exitCode: 1,
            stderrTail: "doctor rejected candidate",
          }),
          timeoutMs: 1000,
        });

        expect(result.afterVersion).toBe("1.0.0");
        expect(result.recovery).toMatchObject({
          serviceRestartSafe: false,
          packageRollbackVerified: false,
        });
        expect(result.failedStep?.stderrTail).toContain(
          "rollback verification failed: restored package tree does not match backup",
        );
      });
    },
  );
});
