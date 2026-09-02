// Diagnostic branch only: no runtime imports, mock replacement, or assertion changes.
/* oxlint-disable no-underscore-dangle -- Read Vitest's own worker, mocker, and mock identity fields without replacing its runner or bindings. */
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { threadId } from "node:worker_threads";

type ModuleNode = {
  id: string;
  file: string | null;
  evaluated: boolean;
  promise?: unknown;
  exports?: Record<string, unknown>;
  meta?: { mockedModule?: object };
  imports: Set<string>;
  importers: Set<string>;
};
type WorkerState = {
  filepath?: string;
  ctx: { workerId: number };
  evaluatedModules: { idToModuleMap: Map<string, ModuleNode> };
  moduleExecutionInfo: Map<string, object>;
};
type TraceEvent = {
  stage: string;
  provider?: string;
  storedProvider?: string;
  profileId?: string;
  resolver?: unknown;
  fixtureResolver?: unknown;
};
type TraceState = { record: (event: TraceEvent) => void };
const stateKey = Symbol.for("openclaw.ciAuthAliasTrace");
const globals = globalThis as typeof globalThis & {
  __vitest_worker__?: WorkerState;
  __vitest_mocker__?: { getDependencyMock: (id: string) => object | undefined };
  [stateKey]?: TraceState;
};

function createAliasTrace(): TraceState {
  const directory = process.env.OPENCLAW_CI_ALIAS_TRACE_DIR;
  if (!directory) {
    throw new Error("The diagnostic trace requires its explicit artifact directory");
  }
  mkdirSync(directory, { recursive: true });
  const output = path.join(directory, `worker-${process.pid}-${threadId}.jsonl`);
  const write = appendFileSync;
  const identities = new WeakMap<object, number>();
  const history: string[] = [];
  let nextId = 1;
  let sequence = 0;
  function identity(value: unknown) {
    if ((typeof value !== "object" || value === null) && typeof value !== "function") {
      return undefined;
    }
    let id = identities.get(value);
    if (id === undefined) {
      id = nextId++;
      identities.set(value, id);
    }
    return id;
  }
  function describeFunction(value: unknown) {
    if (typeof value !== "function") {
      return { id: identity(value), isMock: false };
    }
    const mock = value as typeof value & {
      _isMockFunction?: boolean;
      mock?: { calls: unknown[][] };
    };
    const calls = mock._isMockFunction === true ? mock.mock?.calls : undefined;
    return {
      id: identity(value),
      isMock: mock._isMockFunction === true,
      callCount: calls?.length,
      providers: calls
        ?.slice(0, 100)
        .map((args) => (typeof args[0] === "string" ? args[0] : typeof args[0])),
    };
  }
  function readExport(exports: Record<string, unknown> | undefined, key: string) {
    return exports && Object.hasOwn(exports, key) ? exports[key] : undefined;
  }
  return {
    record(event) {
      const worker = globals.__vitest_worker__;
      if (!worker) {
        throw new Error("Missing Vitest worker for diagnostic trace");
      }
      if (worker.filepath && history.at(-1) !== worker.filepath) {
        history.push(worker.filepath);
      }
      sequence += 1;
      if (sequence > 4000) {
        if (sequence === 4001) {
          write(output, JSON.stringify({ stage: "trace-limit", threadId, sequence }) + "\n");
        }
        return;
      }
      const modules = [];
      for (const [key, node] of worker.evaluatedModules.idToModuleMap) {
        if (
          !/(?:provider-auth-aliases|auth-profiles\/(?:order|profile-list|session-override))/.test(
            key,
          )
        ) {
          continue;
        }
        const fixture = readExport(node.exports, "authStoreMocks") as
          | { resolveProviderIdForAuth?: unknown }
          | undefined;
        modules.push({
          key,
          evaluated: node.evaluated,
          pending: Boolean(node.promise),
          namespaceId: identity(node.exports),
          executionId: identity(worker.moduleExecutionInfo.get(node.id)),
          metadataMockId: identity(node.meta?.mockedModule),
          registryMockId: identity(globals.__vitest_mocker__?.getDependencyMock(node.id)),
          imports: [...node.imports],
          importers: [...node.importers],
          alias: describeFunction(readExport(node.exports, "resolveProviderIdForAuth")),
          fixtureAlias: describeFunction(fixture?.resolveProviderIdForAuth),
        });
      }
      write(
        output,
        JSON.stringify({
          stage: event.stage,
          sequence,
          threadId,
          workerId: worker.ctx.workerId,
          file: worker.filepath,
          history,
          provider: event.provider,
          storedProvider: event.storedProvider,
          profileId: event.profileId,
          resolver: describeFunction(event.resolver),
          fixtureResolver: describeFunction(event.fixtureResolver),
          modules,
        }) + "\n",
      );
    },
  };
}

if (!globals[stateKey]) {
  const trace = createAliasTrace();
  globals[stateKey] = trace;
  process.on("openclaw:ci-auth-alias", (event: TraceEvent) => trace.record(event));
}
globals[stateKey]?.record({ stage: "setup" });
