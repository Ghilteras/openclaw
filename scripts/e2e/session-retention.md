# Prove session retention at scale

`scripts/bench-session-retention.ts` creates fresh synthetic state, exercises production
retention owners, and optionally supervises a normal built Gateway and Chromium.
It never opens operator state, leases a machine, authenticates a provider, or publishes
anything. Failed runs retain their evidence and return nonzero.

## Run the small proof first

Use the repository's installed Node/pnpm dependencies. Node must support `node:sqlite`.
Run from the repository root:

```bash
node --import tsx scripts/bench-session-retention.ts --profile smoke --mode owner --output-dir .artifacts/session-retention
```

Both modes run source-owner seeding and age/count retention. `owner` also runs source
disk eviction and explicit deletion. `live` instead drives disk eviction and explicit
deletion through the built Gateway's public `sessions.cleanup` and `sessions.delete`
RPCs, after real RPC bursts, provider admission/deduplication, Control UI
pagination/history/restore/send, graceful restart, and abrupt crash recovery.
Live mode requires an exact-candidate `pnpm build`, including `dist/control-ui`,
and installed Playwright Chromium. The runner refuses missing build stamps; it does
not rebuild. The parent must verify the materialized synced candidate tree and build
it immediately before running. A clean Git index is neither required nor sufficient.
Chromium's installed executable is resolved before HOME isolation;
the browser profile and every Gateway path are invocation-owned. A short system-temp
tree, linked from `runtime/tmp`, keeps Chromium's Unix socket paths within platform
limits even when the retained artifact directory is deeply nested.

| Profile | Existing archives | Fresh active rows | Extra lifecycle rows | Primary windows/events | RPC clients/rounds | Deadline |
| ------- | ----------------: | ----------------: | -------------------: | ---------------------: | -----------------: | -------: |
| smoke   |                20 |                40 |                   23 |              166 / 830 |              4 / 1 |    4 min |
| scale   |            10,000 |             6,000 |                   23 |       32,046 / 160,230 |             64 / 2 |   30 min |
| massive |           100,000 |             6,000 |                   23 |    212,046 / 1,060,230 |             64 / 4 |   60 min |

The 23 extra rows are eight non-dashboard durable conversations older than 30 days,
nine protected cases, and six disposable cases. Protected cases cover main, pin,
direct/group/thread routing, model lock, running status, a real process-local admission,
and recent activity. Disposable cases cover cron, hook, ACP, subagent, heartbeat,
and the strict one-shot model-run UUID key. Fresh cap victims are two days old,
not accidentally eligible for seven-day dashboard or 30-day archival.

Every primary row has two windows and ten events. Current entries deliberately omit
explicit old-window references. The canonical session/transcript writers seed batches
of 100 logical rows without per-row maintenance. Integrity, row/projection identities,
streaming full-history hashes, and exact population counts verify the seed.

Scale/massive additionally use a separate threshold agent: 500 archived + 5,499 active
rows aged two days, followed by one recent production lifecycle upsert. With the
one-hour recent-preservation window still enabled, default, non-forced maintenance
must leave 5,499 alone and archive exactly 500 at 5,500, preserving the new row.
Smoke uses an explicit cap
of 32 and does not claim the default threshold proof. Disk proof adds one two-window
unprotected candidate and verifies an independent three-window explicit-delete target.

Live disk preparation happens only after stopping the owned Gateway. It seeds both
controls, records all protected history, and stages existing maintenance fields:
`pruneAfter: "36500d"`, `archiveDashboardAfter: false`, `preserveRecent: false`,
`maxEntries: <seeded logical population + 64>`, `maxDiskBytes: 1`, and
`highWaterBytes: 1`, in enforce mode. `pruneAfter` is positive-only; this cutoff is
beyond every synthetic fixture age, isolating disk pressure from age/count archival.
The restarted built Gateway owns every subsequent mutation. The harness opens only
read-only state connections for verification. Startup may kick the budget before the
cleanup RPC arrives, so full authoritative before/after deltas—not a guessed per-RPC
removal count—prove reclamation. Protected identity/window/event hashes, repeated
cleanup, all three explicit-delete generations, and integrity checks remain mandatory.

## Run on the parent's Crabbox lease

The parent owns preparation, lease lifecycle, credentials, and collection. Follow
`docs/reference/test.md#crabbox-repository-setup`; preserve the configured provider
resolution (`blacksmith-testbox`) and do
not pass `--browser`. The prepared workflow owns Linux and its toolchains; provision
the repository-pinned Chromium revision when the browser cache is missing. Build the
synced exact candidate before live runs; the local Mac build is not a Linux build.
The commands below do not create or stop a lease:

```bash
node scripts/crabbox-wrapper.mjs run --id <tbx_id> --timing-json -- bash -lc 'node_modules/.bin/playwright install --with-deps chromium'
node scripts/crabbox-wrapper.mjs run --id <tbx_id> --timing-json -- bash -lc 'pnpm build'
node scripts/crabbox-wrapper.mjs run --id <tbx_id> --timing-json -- node --import tsx scripts/bench-session-retention.ts --profile smoke --mode live --output-dir .artifacts/session-retention
node scripts/crabbox-wrapper.mjs run --id <tbx_id> --timing-json -- node --import tsx scripts/bench-session-retention.ts --profile scale --mode live --output-dir .artifacts/session-retention
node scripts/crabbox-wrapper.mjs run --id <tbx_id> --timing-json -- node --import tsx scripts/bench-session-retention.ts --profile massive --mode live --output-dir .artifacts/session-retention
```

Do not proceed from a failed smoke/scale run to massive. Measure the built disk phase
before budgeting massive. Source-owner workers include TypeScript loader startup;
their timings are semantic-proof measurements, not built-Gateway performance evidence.
Reports label both execution modes explicitly. A slow built phase or deadline failure
is evidence to investigate with the parent, not permission to reduce generations,
skip disk assertions, raise deadlines, or change production.

Working estimates, not measured Linux requirements: reserve 8 GiB RAM and 10 GiB
free disk for scale/massive, plus the prepared checkout/build. Every run is fresh;
retained runs accumulate disk usage. The watchdog records the active phase and stops
invocation-owned resources at its profile deadline, with a 10-second teardown allowance.

## Collect and inspect evidence

The final stdout line identifies the fresh `<profile>-<suffix>/summary.json`.
Each summary contains the source commit prefix when available, proof-file hashes,
build metadata/stamps and artifact hashes in live mode, exact counts, invariant
results, phase durations, and failures. The runner checks agreement of recorded
commits where present, runtime build-ID resolution, unchanged selected build artifacts
at each Gateway start and after proof, authenticated hello build IDs, and served UI
entry-asset bytes. These checks bind the serving build to its recorded artifacts;
they do not attest that synced source bytes correspond to HEAD or to those artifacts.
The parent owns that materialized-tree/build binding; the report states it is not
verified by this runner.

`live-metrics.json` reports per-method RPC and health p50/p95/max plus Gateway RSS.
A two-second sampler runs throughout live phases, pauses around intentional stops,
and is aborted/joined in teardown. It retains at most 2,000 timestamped resource samples
in `resource-samples.json`, plus failure counts and at most 32 failure samples.
There is no latency/RSS success threshold. RPC receipts are bounded at 10,000.
`receipts.json` distinguishes acknowledged, typed-rejected, typed-rate-limited,
transport-unknown, and pending requests; recovery also counts crash-window messages
actually present or absent.
Acknowledged injects and completed normal sends are checked after each restart.

The control-plane limiter in `src/gateway/control-plane-rate-limit.ts` allows 30
writes per method/device/IP per 60 seconds. The methods selected here are not marked
`controlPlaneWrite` in `src/gateway/methods/core-descriptors.ts`. The proof nevertheless
recognizes the exact typed `UNAVAILABLE`/retryable/retry-after/method/limit response
from `src/gateway/server-methods.ts`, reports it separately, and fails required-mutation
phases instead of pretending a rejected write was acknowledged or silently retrying.
Only socket-issued transport-unknown crash writes may be present or absent after
recovery; typed rejections are not attributed to crash loss.

The runner retains raw synthetic runtime state under the invocation's `runtime/`.
It contains generated authentication material and is **not a publication artifact**.
The `.artifacts` tree is excluded from Crabbox sync; collect it explicitly before
stopping the parent's lease. On the remote host, create a bounded evidence archive
of the exact invocation, excluding runtime state:

```bash
tar --exclude=runtime -czf /tmp/session-retention-<profile-suffix>.tgz -C .artifacts/session-retention <profile-suffix>
```

Collect through the native Blacksmith CLI (verified in 0.4.57). The parent supplies
the exact lease ID and its SSH private-key path; no guessed SSH connection tuple is
needed:

```bash
blacksmith testbox download --id <tbx_id> /tmp/session-retention-<profile-suffix>.tgz .artifacts/session-retention-<profile-suffix>.tgz --ssh-private-key <lease-key-path>
```

Inspect every screenshot/video before publication. Reports intentionally leave
`capturesInspected: false`; generation is not visual verification. Raw logs and
provider request bodies also require inspection/redaction before external sharing.

## Proof limits

The provider is the maintained HTTP fixture, not an authenticated external model.
The parent owns any real-provider continuation lane. The crash is synchronized to
actual socket issuance with at least one pending request; it does not claim a
precisely instrumented SQLite commit interruption. Unknown transport outcomes may
be present or absent after recovery, but acknowledged messages must survive exactly
once. Disk pressure permits an above-budget result when only protected data remains.

Owner-mode admission is real but process-local; live mode additionally observes a
held provider request during cleanup. The running metadata fixture alone is not a
live runtime claim. The UI uses the public token-fragment/pairing flow and the
bundled UI; there is no mocked WebSocket, storage spoof, or auth bypass.

Authoring validation is not a massive/live result. Run these commands on the selected
Linux lease and use its reports for landing judgment.
