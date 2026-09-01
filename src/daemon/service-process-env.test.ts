import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveServiceManagerEnv } from "./service-process-env.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("resolveServiceManagerEnv", () => {
  it("keeps native context without accepting arbitrary names or prefixes", () => {
    const native = {
      PATH: "/native/bin",
      HOME: "/home/native",
      USER: "native",
      LOGNAME: "native",
      TMPDIR: "/tmp/native",
      TMP: "/tmp",
      TEMP: "/tmp",
      LANG: "C",
      LANGUAGE: "en",
      LC_ALL: "C",
      LC_CTYPE: "C",
      LC_MESSAGES: "C",
      LC_COLLATE: "C",
      LC_NUMERIC: "C",
      LC_MONETARY: "C",
      LC_TIME: "C",
      TZ: "UTC",
      TERM: "dumb",
      COLORTERM: "",
      NO_COLOR: "",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/bus",
      DBUS_SYSTEM_BUS_ADDRESS: "unix:path=/system",
      XDG_RUNTIME_DIR: "/run/native",
      XDG_CONFIG_HOME: "/config",
      XDG_CONFIG_DIRS: "/configs",
      XDG_DATA_HOME: "/data",
      XDG_DATA_DIRS: "/shared",
      SYSTEMD_UNIT_PATH: "/units",
      SUDO_USER: "caller",
      SUDO_UID: "1000",
      SUDO_GID: "1000",
      SYSTEMD_OFFLINE: "0",
      SYSTEMD_IN_CHROOT: "0",
      SYSTEMD_BUS_TIMEOUT: "3s",
    };
    const source = {
      ...native,
      BOUNDARY_PARENT_ONLY: "synthetic",
      OPENCLAW_PROFILE: "private",
      SYSTEMD_APPLICATION: "synthetic",
      DBUS_APPLICATION: "synthetic",
      XDG_APPLICATION: "synthetic",
      LC_APPLICATION: "synthetic",
      " PATH": "invalid",
      "PATH ": "invalid",
      NODE_OPTIONS: "--inspect",
      SHELL: "/bin/sh",
      LD_PRELOAD: "synthetic",
      DYLD_INSERT_LIBRARIES: "synthetic",
      HTTPS_PROXY: "synthetic",
      SSH_AUTH_SOCK: "synthetic",
      SYSTEMD_PAGER: "synthetic",
      EDITOR: "synthetic",
      SUDO_COMMAND: "synthetic",
      SUDO_ASKPASS: "synthetic",
    };
    expect(resolveServiceManagerEnv(source)).toEqual(native);
    expect(source.BOUNDARY_PARENT_ONLY).toBe("synthetic");
  });

  it("defaults only an omitted source and preserves explicit empty and undefined values", () => {
    vi.stubEnv("HOME", "/parent/home");
    vi.stubEnv("BOUNDARY_PARENT_ONLY", "synthetic");
    expect(resolveServiceManagerEnv().HOME).toBe("/parent/home");
    expect(resolveServiceManagerEnv(undefined).HOME).toBe("/parent/home");
    expect(resolveServiceManagerEnv().BOUNDARY_PARENT_ONLY).toBeUndefined();
    expect(resolveServiceManagerEnv({})).toEqual({});
    expect(resolveServiceManagerEnv({ HOME: undefined, PATH: "", NO_COLOR: "" })).toEqual({
      PATH: "",
      NO_COLOR: "",
    });
  });

  it.each(["linux", "darwin", "win32"] as const)(
    "preserves %s casing and first-key undefined semantics",
    (platform) => {
      vi.spyOn(process, "platform", "get").mockReturnValue(platform);
      const source = {
        Path: "later",
        PATH: undefined,
        hOmE: "/mixed",
        HOME: "/first",
        path: "last",
      };
      expect(resolveServiceManagerEnv(source)).toEqual({ HOME: "/first" });
      expect(source.Path).toBe("later");
      expect(
        resolveServiceManagerEnv({ Path: "mixed", path: "last", SystemRoot: "C:\\Windows" }),
      ).toEqual(platform === "win32" ? { Path: "mixed", SystemRoot: "C:\\Windows" } : {});
    },
  );

  it("retains Windows executable, profile and account context", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const native = {
      SystemRoot: "C:\\Windows",
      windir: "C:\\Windows",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      SystemDrive: "C:",
      UserProfile: "C:\\Users\\native",
      HomeDrive: "C:",
      HomePath: "\\Users\\native",
      AppData: "roaming",
      LocalAppData: "local",
      ProgramData: "shared",
      ProgramFiles: "programs",
      "ProgramFiles(x86)": "programs-x86",
      ProgramW6432: "programs-64",
      UserName: "native",
      UserDomain: "machine",
    };
    expect(resolveServiceManagerEnv({ ...native, BOUNDARY_APPLICATION: "synthetic" })).toEqual(
      native,
    );
  });
});
