import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { NodeWorkerWorkspaceRuntime } from "../../node-host/node-worker-workspace.js";
import type { SpawnResult } from "../../process/exec.js";
import { loadWorkspaceSkills } from "../../skills/loading/workspace-skill-loader.js";
import { buildSkillSnapshot } from "../../skills/loading/workspace-skill-prompt.js";
import { applySkillEnvOverridesFromSnapshot } from "../../skills/runtime/env-overrides.js";
import { buildSkillResourceCommand } from "../../worker/skill-resource-receiver.js";
import { transferSkillResources } from "./skill-resource-transfer.js";
import type { WorkerWorkspaceCommand, WorkerWorkspaceTunnelHandle } from "./tunnel-contract.js";

const temps = useAutoCleanupTempDirTracker(afterEach);
const runCommand = async (command: WorkerWorkspaceCommand): Promise<SpawnResult> => {
  command.assertCurrent?.();
  return new Promise((resolve, reject) => {
    const child = spawn(command.argv[0]!, command.argv.slice(1), {
      stdio: "pipe",
      signal: command.signal,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (bytes) => {
      stdout += bytes;
    });
    child.stderr.on("data", (bytes) => {
      stderr += bytes;
    });
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({ stdout, stderr, code, termination: "exit", signal: null, killed: false }),
    );
    child.stdin.end(command.input);
  });
};
const tunnel: Pick<WorkerWorkspaceTunnelHandle, "runWorkspaceCommand"> = {
  runWorkspaceCommand: async (command) => {
    const context = command.skillResources;
    if (!context) {
      throw new Error("Missing skill resource operation");
    }
    return runCommand({
      ...command,
      argv: buildSkillResourceCommand({
        parentDir: path.dirname(context.workspaceDir),
        generation: context.generation,
        operation: context.operation,
      }),
    });
  },
};

async function createSource() {
  const workspace = await fs.realpath(temps.make("remote-skill-source-"));
  const baseDir = path.join(workspace, "skills", "source");
  await fs.mkdir(path.join(baseDir, "scripts"), { recursive: true });
  const filePath = path.join(baseDir, "SKILL.md");
  await fs.writeFile(
    filePath,
    "---\ndescription: Resource transfer test\n---\n# Resource\nRead data.bin and run scripts/check.sh.\n",
  );
  const binary = Buffer.alloc(150000, 129);
  await fs.writeFile(path.join(baseDir, "data.bin"), binary);
  await fs.writeFile(path.join(baseDir, "scripts/check.sh"), "#!/bin/sh\nprintf ready\n", {
    mode: 0o700,
  });
  const remoteRoot = await fs.realpath(temps.make("remote-skill-worker-"));
  const workspaceDir = path.join(remoteRoot, "workspace");
  await fs.mkdir(workspaceDir);
  return {
    workspace,
    workspaceDir,
    generation: 1,
    filePath,
    binary,
    snapshot: buildSkillSnapshot(workspace, {
      entries: loadWorkspaceSkills(workspace, { workspaceOnly: true }),
    }),
  };
}

describe("remote-exec skill resources", () => {
  it("transfers resources through the real node workspace guard and cleans only its owned bundle", async () => {
    const { filePath, binary, snapshot } = await createSource();
    const nodeRoot = await fs.realpath(temps.make("remote-skill-node-"));
    const tempDir = path.join(nodeRoot, "tmp");
    await fs.mkdir(tempDir);
    const runtime = new NodeWorkerWorkspaceRuntime({
      root: path.join(nodeRoot, "state", "node-host"),
      env: {
        ...process.env,
        HOME: nodeRoot,
        TMPDIR: tempDir,
        TMP: tempDir,
        TEMP: tempDir,
      },
    });
    const identity = {
      gatewayNamespace: "skill-resource-test",
      environmentId: "skill-environment",
      sessionId: "skill-session",
      generation: 1,
    };
    const { workspaceDir } = await runtime.exec({ ...identity, argv: ["node", "-e", ""] });
    await fs.writeFile(path.join(workspaceDir, "project.txt"), "project remains unchanged\n");
    const sibling = path.join(path.dirname(workspaceDir), ".1.skill-resources-" + "a".repeat(32));
    await fs.mkdir(sibling);
    await fs.writeFile(path.join(sibling, "keep.txt"), "another owner");
    const resources = await transferSkillResources({
      snapshot,
      workspaceDir,
      generation: identity.generation,
      assertCurrent: () => {},
      tunnel: {
        runWorkspaceCommand: async (command) => {
          command.assertCurrent?.();
          const execution = runtime.exec(
            {
              ...identity,
              argv: [...command.argv],
              input: command.input,
              timeoutMs: command.timeoutMs,
              skillResources: command.skillResources?.operation,
            },
            command.signal,
          );
          await expect(
            execution,
            `node resource operation=${command.skillResources?.operation.operation}`,
          ).resolves.toMatchObject({ code: 0 });
          command.assertCurrent?.();
          return await execution;
        },
      },
    });
    expect(resources).toBeDefined();
    const remote = resources!.mounts[0]!.containerPath;
    expect(path.relative(workspaceDir, remote)).toMatch(/^\.\.[/\\]/);
    expect(await fs.readFile(path.join(remote, "SKILL.md"))).toEqual(await fs.readFile(filePath));
    expect(await fs.readFile(path.join(remote, "data.bin"))).toEqual(binary);
    expect((await fs.stat(path.join(remote, "scripts/check.sh"))).mode & 0o777).toBe(0o500);
    expect((await fs.stat(path.join(remote, "data.bin"))).mode & 0o777).toBe(0o400);
    await expect(runtime.exec({ ...identity, argv: ["node", "-e", "", nodeRoot] })).rejects.toThrow(
      "workspace command argv resolves outside its workspace",
    );
    await resources!.cleanup();
    await expect(fs.stat(remote)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(path.join(sibling, "keep.txt"), "utf8")).toBe("another owner");
    expect(await fs.readdir(workspaceDir)).toEqual(["project.txt"]);
    expect(await fs.readFile(path.join(workspaceDir, "project.txt"), "utf8")).toBe(
      "project remains unchanged\n",
    );
  });

  it("rejects remote directory identities that collide when rounded to numbers", async () => {
    const { snapshot, workspaceDir, generation } = await createSource();
    let initializedRoot: string | undefined;
    try {
      await expect(
        transferSkillResources({
          snapshot,
          workspaceDir,
          generation,
          assertCurrent: () => {},
          tunnel: {
            runWorkspaceCommand: async (command) => {
              // Model adjacent Windows file indexes while retaining the real filesystem flow.
              const identityShim = `{
                const fs = require('node:fs');
                for (const method of ['lstatSync', 'statSync']) {
                  const original = fs[method];
                  fs[method] = (...args) => {
                    const stat = original(...args);
                    const ino = 9007199254740992n + (JSON.parse(process.argv[3]).operation === 'init' ? 0n : 1n);
                    stat.ino = typeof stat.ino === 'bigint' ? ino : Number(ino);
                    return stat;
                  };
                }
              }`;
              const argv = buildSkillResourceCommand({
                parentDir: path.dirname(workspaceDir),
                generation,
                operation: command.skillResources!.operation,
              });
              const result = await runCommand({
                ...command,
                argv: [...argv.slice(0, 2), identityShim + argv[2], ...argv.slice(3)],
              });
              if (command.skillResources?.operation.operation === "init") {
                initializedRoot = JSON.parse(result.stdout).root;
              }
              return result;
            },
          },
        }),
      ).rejects.toThrow("Skill resource transfer failed");
      expect(initializedRoot).toBeDefined();
      await expect(fs.readdir(initializedRoot!)).resolves.toEqual([]);
    } finally {
      if (initializedRoot) {
        await fs.rm(initializedRoot, { recursive: true, force: true });
      }
    }
  });

  it.each(["complete", "cancelled", "retired"] as const)(
    "preserves complete resources outside the project and cleans up only its current owner (%s)",
    async (outcome) => {
      const { workspace, workspaceDir, generation, filePath, binary, snapshot } =
        await createSource();
      const controller = new AbortController();
      let current = true;
      const resources = await transferSkillResources({
        tunnel,
        workspaceDir,
        generation,
        signal: controller.signal,
        assertCurrent: () => {
          if (!current) {
            throw new Error("placement retired");
          }
        },
        snapshot,
      });
      expect(resources).toBeDefined();
      const remote = resources!.mounts[0]!.containerPath;
      try {
        expect(remote.startsWith(workspace)).toBe(false);
        expect(await fs.readFile(path.join(remote, "SKILL.md"))).toEqual(
          await fs.readFile(filePath),
        );
        expect(resources!.snapshot.resolvedSkills![0]!.name).toBe("source");
        expect(await fs.readFile(path.join(remote, "data.bin"))).toEqual(binary);
        expect((await fs.stat(path.join(remote, "scripts/check.sh"))).mode & 0o777).toBe(0o500);
        expect((await fs.stat(path.join(remote, "data.bin"))).mode & 0o777).toBe(0o400);
        expect(resources!.snapshot.prompt).toContain(remote);
        expect(resources!.snapshot.resolvedSkills![0]!.filePath).toBe(filePath);
        if (outcome === "cancelled") {
          controller.abort();
        } else if (outcome === "retired") {
          current = false;
        }
        if (outcome === "retired") {
          await expect(resources!.cleanup()).rejects.toThrow("placement retired");
          expect(await fs.readFile(path.join(remote, "data.bin"))).toEqual(binary);
        } else {
          await expect(resources!.cleanup()).resolves.toBeUndefined();
          await expect(fs.stat(remote)).rejects.toMatchObject({ code: "ENOENT" });
        }
      } finally {
        await fs.rm(path.dirname(remote), { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "omits a stale discovered skill from the transferred snapshot and prompt",
    async () => {
      const { workspace, workspaceDir, generation, snapshot } = await createSource();
      const staleBaseDir = path.join(workspace, "skills", "stale");
      await fs.mkdir(staleBaseDir, { recursive: true });
      await fs.writeFile(
        path.join(staleBaseDir, "SKILL.md"),
        "---\ndescription: Stale resource\n---\n# Stale\n",
      );
      const sourceSkill = snapshot.resolvedSkills?.[0];
      expect(sourceSkill).toBeDefined();
      snapshot.resolvedSkills!.push({
        ...sourceSkill!,
        name: "stale",
        filePath: path.join(staleBaseDir, "SKILL.md"),
        baseDir: staleBaseDir,
      });
      snapshot.skills.push({
        name: "stale",
        skillKey: "stale",
        primaryEnv: "STALE_SKILL_API_KEY",
      });
      snapshot.prompt += "\nstale";
      await fs.rm(staleBaseDir, { recursive: true });
      await fs.symlink(path.join(workspace, "missing-stale-target"), staleBaseDir, "dir");

      const resources = await transferSkillResources({
        tunnel,
        workspaceDir,
        generation,
        assertCurrent: () => {},
        snapshot,
      });
      const remoteRoot = path.dirname(resources!.mounts[0]!.containerPath);
      try {
        expect(resources!.mounts).toHaveLength(1);
        expect(resources!.snapshot.skills.map((skill) => skill.name)).toEqual(["source"]);
        expect(resources!.snapshot.resolvedSkills?.map((skill) => skill.name)).toEqual(["source"]);
        expect(resources!.snapshot.prompt).not.toContain("stale");
        const restoreEnv = applySkillEnvOverridesFromSnapshot({
          snapshot: resources!.snapshot,
          config: {
            skills: {
              entries: { stale: { apiKey: "must-not-apply" } }, // pragma: allowlist secret
            },
          },
        });
        try {
          expect(process.env.STALE_SKILL_API_KEY).toBeUndefined();
        } finally {
          restoreEnv();
        }
      } finally {
        await fs.rm(remoteRoot, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "retains a skill identity when a same-named node skill remains active",
    async () => {
      const { workspace, workspaceDir, generation } = await createSource();
      const staleBaseDir = path.join(workspace, "skills", "stale");
      await fs.mkdir(staleBaseDir, { recursive: true });
      await fs.writeFile(
        path.join(staleBaseDir, "SKILL.md"),
        "---\ndescription: Stale resource\n---\n# Stale\n",
      );
      const snapshot = buildSkillSnapshot(workspace, {
        entries: loadWorkspaceSkills(workspace, { workspaceOnly: true }),
      });
      const sourceSkill = snapshot.resolvedSkills?.[0];
      expect(sourceSkill).toBeDefined();
      snapshot.skills.push({ name: "stale", skillKey: "stale" });
      snapshot.resolvedSkills?.push(
        {
          ...structuredClone(sourceSkill!),
          name: "stale",
          filePath: path.join(staleBaseDir, "SKILL.md"),
          baseDir: staleBaseDir,
        },
        {
          ...structuredClone(sourceSkill!),
          name: "stale",
          filePath: "node://worker/skills/stale/SKILL.md",
          baseDir: "node://worker/skills/stale",
        },
      );
      await fs.rm(staleBaseDir, { recursive: true });
      await fs.symlink(path.join(workspace, "missing-stale-target"), staleBaseDir, "dir");

      const resources = await transferSkillResources({
        tunnel,
        workspaceDir,
        generation,
        assertCurrent: () => {},
        snapshot,
      });
      const remoteRoot = path.dirname(resources!.mounts[0]!.containerPath);
      try {
        expect(resources!.snapshot.skills.map((skill) => skill.name)).toEqual(["source", "stale"]);
        expect(resources!.snapshot.resolvedSkills?.map((skill) => skill.name)).toEqual([
          "source",
          "stale",
        ]);
      } finally {
        await fs.rm(remoteRoot, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "removes every stale skill from the transferred snapshot when no bundles remain",
    async () => {
      const { filePath, workspaceDir, generation, snapshot } = await createSource();
      const baseDir = path.dirname(filePath);
      await fs.rm(baseDir, { recursive: true });
      await fs.symlink(path.join(path.dirname(baseDir), "missing-source-target"), baseDir, "dir");

      const resources = await transferSkillResources({
        tunnel,
        workspaceDir,
        generation,
        assertCurrent: () => {},
        snapshot,
      });
      try {
        expect(resources?.mounts).toEqual([]);
        expect(resources?.snapshot.skills).toEqual([]);
        expect(resources?.snapshot.resolvedSkills).toEqual([]);
        expect(resources?.snapshot.prompt).not.toContain("source");
      } finally {
        await resources?.cleanup();
      }
    },
  );

  it("cleans the accepted remote directory when cancellation arrives with initialization", async () => {
    const { snapshot, workspaceDir, generation } = await createSource();
    const controller = new AbortController();
    let initializedRoot: string | undefined;
    try {
      await expect(
        transferSkillResources({
          snapshot,
          workspaceDir,
          generation,
          signal: controller.signal,
          assertCurrent: () => {},
          tunnel: {
            runWorkspaceCommand: async (command) => {
              const result = await tunnel.runWorkspaceCommand(command);
              if (!initializedRoot) {
                const initialized: { root: string } = JSON.parse(result.stdout);
                initializedRoot = initialized.root;
                controller.abort();
              }
              return result;
            },
          },
        }),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(initializedRoot).toBeDefined();
      await expect(fs.stat(initializedRoot!)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (initializedRoot) {
        await fs.rm(initializedRoot, { recursive: true, force: true });
      }
    }
  });
});
