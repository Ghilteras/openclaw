import { readFileLockProcessStartTime } from "../shared/pid-alive.ts";
import {
  isManagedHandoffBoot,
  type HandoffBootIdentity,
  type HandoffProcessIdentity,
  type HandoffRuntimeBuiltins,
} from "./update-managed-service-handoff-lease-state.ts";

/** Process and boot identities shared by preloaded and staged lease owners. */
export function createHandoffProcessIdentity(
  { fs, spawnSync, process }: HandoffRuntimeBuiltins,
  serviceManagerEnv: Record<string, string>,
) {
  // Lease reclamation needs ESRCH evidence; other probe errors cannot prove absence.
  function isPidAlive(pid: number) {
    if (!pid || typeof pid !== "number") {
      return false;
    }
    try {
      process.kill(pid, 0);
    } catch (err) {
      // SAFETY: the native process.kill boundary throws Node system errors with an errno code.
      return Boolean(err && (err as NodeJS.ErrnoException).code !== "ESRCH");
    }
    if (process.platform === "linux") {
      try {
        const status = fs.readFileSync("/proc/" + pid + "/status", "utf8");
        return !/^State:\s+Z/m.test(status);
      } catch {
        return true;
      }
    }
    return true;
  }

  function readProcessStartIdentity(pid: number): string | null {
    if (!isPidAlive(pid)) {
      return null;
    }
    const start = readFileLockProcessStartTime(
      pid,
      { ...serviceManagerEnv, LC_ALL: "C", TZ: "UTC" },
      1000,
    );
    return start === null ? null : String(start);
  }

  function processState(value: HandoffProcessIdentity) {
    if (!isPidAlive(value.pid)) {
      return "dead";
    }
    const start = readProcessStartIdentity(value.pid);
    return start === null ? "unknown" : start === value.startIdentity ? "live" : "dead";
  }
  function processIdentity(pid = process.pid): HandoffProcessIdentity {
    const startIdentity = readProcessStartIdentity(pid);
    if (!startIdentity) {
      throw new Error("managed handoff process start identity is unavailable");
    }
    return { pid, startIdentity };
  }
  function bootIdentity(): HandoffBootIdentity {
    let value: string | undefined;
    if (process.platform === "linux") {
      value = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    } else if (process.platform === "darwin") {
      const result = spawnSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], {
        env: serviceManagerEnv,
        encoding: "utf8",
        timeout: 1000,
        killSignal: "SIGKILL",
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (!result.error && result.status === 0) {
        value = result.stdout.trim();
      }
    } else if (process.platform === "win32") {
      const result = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "(Get-CimInstance -ClassName Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')",
        ],
        {
          env: serviceManagerEnv,
          encoding: "utf8",
          windowsHide: true,
          timeout: 5000,
          killSignal: "SIGKILL",
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      if (!result.error && result.status === 0) {
        value = result.stdout.trim();
      }
    }
    // Unknown boot identities cannot be replaced with uptime or a wall-clock guess.
    const boot = {
      platform: process.platform,
      identity: process.platform === "win32" ? value : value?.toLowerCase(),
    };
    if (!isManagedHandoffBoot(boot)) {
      throw new Error("OS boot identity unavailable; run openclaw triage manually");
    }
    return boot;
  }
  return { isPidAlive, readProcessStartIdentity, processState, processIdentity, bootIdentity };
}
