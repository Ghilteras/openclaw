// Stageable process and boot identity probes shared by every handoff lease owner.
export const HANDOFF_IDENTITY_FACTORY_SOURCE = String.raw`function (builtins, options) {
  const { fs, spawnSync, process } = builtins;
  const { serviceManagerEnv, validBoot } = options;
  function isPidAlive(pid) {
    if (!pid || typeof pid !== "number") {
      return false;
    }
    try {
      process.kill(pid, 0);
    } catch (err) {
      return Boolean(err && err.code !== "ESRCH");
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

  function readProcessStartIdentity(pid) {
    if (!isPidAlive(pid)) {
      return null;
    }
    if (process.platform === "linux") {
      try {
        const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
        const commEndIndex = stat.lastIndexOf(")");
        if (commEndIndex < 0) return null;
        const fields = stat
          .slice(commEndIndex + 1)
          .trimStart()
          .split(/\s+/);
        const starttime = Number(fields[19]);
        return Number.isInteger(starttime) && starttime >= 0 ? String(starttime) : null;
      } catch {
        return null;
      }
    }
    const windows = process.platform === "win32";
    if (!windows && process.platform !== "darwin") return null;
    const args = windows
      ? [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "(Get-Process -Id " + pid + ").StartTime.ToString('o')",
        ]
      : ["-o", "lstart=", "-p", String(pid)];
    const result = spawnSync(windows ? "powershell.exe" : "/bin/ps", args, {
      encoding: "utf8",
      env: { ...serviceManagerEnv, LC_ALL: "C", TZ: "UTC" },
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
      killSignal: "SIGKILL",
      windowsHide: windows,
    });
    const startedAt = Date.parse(String(result.stdout || "").trim() + (windows ? "" : " UTC"));
    return !result.error && result.status === 0 && Number.isFinite(startedAt)
      ? String(Math.floor(startedAt / (windows ? 1 : 1000)))
      : null;
  }

  function processState(value) {
    if (!isPidAlive(value.pid)) return "dead";
    const start = readProcessStartIdentity(value.pid);
    return start === null ? "unknown" : start === value.startIdentity ? "live" : "dead";
  }
  function processIdentity(pid = process.pid) {
    const startIdentity = readProcessStartIdentity(pid);
    if (!startIdentity) throw new Error("managed handoff process start identity is unavailable");
    return { pid, startIdentity };
  }
  function bootIdentity() {
    let value;
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
      if (!result.error && result.status === 0) value = String(result.stdout).trim();
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
      if (!result.error && result.status === 0) value = String(result.stdout).trim();
    }
    // Unknown boot identities cannot be replaced with uptime or a wall-clock guess.
    const boot = {
      platform: process.platform,
      identity: process.platform === "win32" ? value : value?.toLowerCase(),
    };
    if (!validBoot(boot))
      throw new Error("OS boot identity unavailable; run openclaw triage manually");
    return boot;
  }
  return { isPidAlive, readProcessStartIdentity, processState, processIdentity, bootIdentity };
}`;
