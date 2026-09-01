import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { resolveServiceManagerEnv } from "../daemon/service-process-env.js";
import { HANDOFF_LEASE_FACTORY_SOURCE } from "./update-managed-service-handoff-lease-script.js";
import type {
  createManagedHandoffLeaseStore,
  ManagedHandoffLease,
} from "./update-managed-service-handoff-lease.js";

const scratch: string[] = [];
afterEach(() => {
  for (const root of scratch.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
const unix = process.platform === "win32" ? it.skip : it;
const action = {
  kind: "triage",
  phase: "reserved",
  lifetime: {
    kind: "native",
    unit: "openclaw-gateway.service",
    scope: "openclaw-triage-test.scope",
    placement: { kind: "pending" },
  },
} as const;
type Store = ReturnType<typeof createManagedHandoffLeaseStore>;
// oxlint-disable-next-line typescript/no-implied-eval -- Exercises the exact trusted staged literal with fault-injected builtins.
const createStore = new Function(
  "builtins",
  "options",
  `return (${HANDOFF_LEASE_FACTORY_SOURCE})(builtins, options)`,
) as (
  builtins: {
    fs: typeof fs;
    path: typeof path;
    spawnSync: typeof spawnSync;
    DatabaseSync: typeof DatabaseSync;
    process: typeof process;
  },
  options: { databasePath: string; serviceManagerEnv: Record<string, string> },
) => Store;

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "retarget-")));
  scratch.push(root);
  const from = path.join(root, "package"),
    to = path.join(root, "checkout");
  fs.mkdirSync(from);
  fs.mkdirSync(to);
  const options = {
    databasePath: path.join(root, "lease", "state.sqlite"),
    serviceManagerEnv: resolveServiceManagerEnv(),
  };
  const builtins = { fs, path, spawnSync, DatabaseSync, process };
  const store = createStore(builtins, options);
  const acquired = store.acquire(from, "original-helper", { kind: "update" });
  if (acquired.kind !== "acquired") {
    throw new Error("fixture busy");
  }
  // Exercise the transaction's observation window using real owner operations.
  const racing = (beforeBegin: () => void) => {
    let pending: (() => void) | undefined = beforeBegin;
    class RacingDatabase extends DatabaseSync {
      override exec(sql: string) {
        if (sql === "BEGIN IMMEDIATE;" && pending) {
          const operation = pending;
          pending = undefined;
          operation();
        }
        return super.exec(sql);
      }
    }
    return createStore({ ...builtins, DatabaseSync: RacingDatabase }, options);
  };
  const closedDestination = () => {
    // Both independent processes finish through bind/activate/complete, then exit
    // without deleting the closed row. No fabricated lease grants reclamation.
    const common = `const fs=require('node:fs'),path=require('node:path'),{spawn,spawnSync}=require('node:child_process'),{DatabaseSync}=require('node:sqlite');
const store=(${HANDOFF_LEASE_FACTORY_SOURCE})({fs,path,spawnSync,DatabaseSync,process},${JSON.stringify(options)});`;
    const executor =
      common +
      `process.once('message',lease=>{const closed=store.complete(lease);if(!closed)throw new Error('complete failed');process.send(closed,()=>process.disconnect());});`;
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        common +
          `
const acquired=store.acquire(${JSON.stringify(to)},'finished-owner',{kind:'triage',phase:'reserved',lifetime:{kind:'foreground',boot:store.bootIdentity()}});
if(acquired.kind!=='acquired')throw new Error('destination busy');
const child=spawn(process.execPath,['-e',${JSON.stringify(executor)}],{stdio:['ignore','ignore','inherit','ipc']});
child.once('message',lease=>process.stdout.write(JSON.stringify(lease)));
const bound=store.bind(acquired.lease,child.pid),running=bound&&store.activate(bound);
if(!running)throw new Error('activation failed');child.send(running);
`,
      ],
      { encoding: "utf8", timeout: 10_000, env: options.serviceManagerEnv },
    );
    expect(result.status, result.stderr).toBe(0);
    const closed = JSON.parse(result.stdout) as ManagedHandoffLease;
    expect(closed.action).toMatchObject({ phase: "closed" });
    return closed;
  };
  return { from, to, store, source: acquired.lease, racing, closedDestination, builtins, options };
}

unix("moves the captured source key after its realpath changes and preserves the helper", () => {
  const { from, to, store, source } = fixture();
  fs.rmdirSync(from);
  fs.symlinkSync(to, from, "dir");
  const moved = store.retarget(source, to, action);
  expect(moved?.kind).toBe("acquired");
  if (moved?.kind !== "acquired") {
    throw new Error("retarget refused");
  }
  expect(store.read(from)).toEqual({ kind: "absent" });
  expect(moved.lease).toMatchObject({
    key: to,
    owner: source.owner,
    helper: source.helper,
    executor: source.helper,
    action,
  });
  expect(store.current(source)).toBe(false);
  expect(store.current(moved.lease)).toBe(true);
});

unix("keeps same-root transition in the existing binding flow", () => {
  const { from, store, source } = fixture();
  const moved = store.retarget(source, from, action);
  expect(moved?.kind).toBe("acquired");
  if (moved?.kind !== "acquired") {
    throw new Error("retarget refused");
  }
  expect(moved.lease.key).toBe(from);
  expect(moved.lease.updatedAt).toBeGreaterThan(source.updatedAt);
  expect(store.current(moved.lease)).toBe(true);
});

unix("refuses retarget while the update executor is still a child", async () => {
  const { to, store, source } = fixture();
  const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
    stdio: ["pipe", "ignore", "ignore"],
  });
  const exited = new Promise((resolve) => {
    child.once("exit", resolve);
  });
  try {
    const bound = store.bind(source, child.pid!)!;
    expect(store.retarget(bound, to, action)).toBeNull();
    expect(store.current(bound)).toBe(true);
    expect(store.read(to)).toEqual({ kind: "absent" });
  } finally {
    child.kill();
    await exited;
  }
});

unix("does not touch a destination after the source generation is lost", () => {
  const { to, store, source, racing, closedDestination } = fixture();
  closedDestination();
  const before = store.read(to);
  let current: ManagedHandoffLease | null = null;
  const other = racing(() => {
    current = store.bind(source, process.pid);
  });
  expect(() => other.retarget(source, to, action)).toThrow("source changed");
  expect(store.read(to)).toEqual(before);
  expect(store.current(current!)).toBe(true);
  expect(store.retarget(source, to, action)).toBeNull();
});

unix.each(["arrival", "generation"] as const)(
  "leaves a destination %s winner unchanged",
  (race) => {
    const { to, store, source, racing, closedDestination } = fixture();
    if (race === "generation") {
      closedDestination();
    }
    let winner: ReturnType<Store["read"]>;
    const other = racing(() => {
      expect(store.acquire(to, "winner", { kind: "update" }).kind).toBe("acquired");
      winner = store.read(to);
    });
    expect(other.retarget(source, to, action)).toEqual({ kind: "busy", owner: "winner" });
    expect(store.read(to)).toEqual(winner!);
    expect(store.current(source)).toBe(true);
  },
);

unix("reclaims a closed destination only after its real helper and executor exit", () => {
  const { from, to, store, source, closedDestination } = fixture();
  closedDestination();
  expect(store.retarget(source, to, action)?.kind).toBe("acquired");
  expect(store.read(from)).toEqual({ kind: "absent" });
  expect(store.read(to)).toMatchObject({
    kind: "current",
    lease: { owner: source.owner, helper: source.helper, action },
  });
});

unix("leaves source and destination unchanged when destination inspection is unreadable", () => {
  const { to, store, source, builtins, options } = fixture();
  expect(store.acquire(to, "winner", { kind: "update" }).kind).toBe("acquired");
  const before = store.read(to);
  class UnreadableDatabase extends DatabaseSync {
    override prepare(sql: string) {
      const statement = super.prepare(sql);
      if (sql.startsWith("SELECT owner")) {
        const get = statement.get.bind(statement);
        statement.get = (...args) => {
          if (args[0] === to) {
            throw new Error("destination unreadable");
          }
          return Reflect.apply(get, statement, args);
        };
      }
      return statement;
    }
  }
  const other = createStore({ ...builtins, DatabaseSync: UnreadableDatabase }, options);
  expect(() => other.retarget(source, to, action)).toThrow("destination unreadable");
  expect(store.current(source)).toBe(true);
  expect(store.read(to)).toEqual(before);
});
