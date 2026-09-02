# Joinery Regression Test Harness

Test pyramid for catching regressions across all supported engines and the full Electron app.

| Tier           | Runner                  | Scope                             | Lives in                                   |
| -------------- | ----------------------- | --------------------------------- | ------------------------------------------ |
| 1. Unit        | Vitest                  | Pure logic, no I/O                | `packages/*/src/**/*.{test,spec}.{ts,tsx}` |
| 2. Integration | Vitest + Docker Compose | Real DBs, SSH tunnel, AI plumbing | `tests/integration/**`                     |
| 3. E2E         | Playwright + Electron   | Functional E2E specs              | `tests/e2e-react/**`                       |
| 4. Visual      | Playwright + Electron   | Pixel-diff baselines, macOS-only  | `tests/e2e-react-visual/**`                |
| 5. Performance | Playwright + Electron   | Slow-by-construction budget gates | `tests/e2e-react-perf/**`                  |

The `-react` suffixes are historical — they told these tiers apart from the Angular ones while the
two renderers coexisted. Task 24 deleted the Angular renderer and its tiers; the names stay because
the committed baseline tree (`tests/__snapshots__/visual-react/`) is keyed by them.

## Quick start

Two ways to run the suite. Pick by workflow:

### Live dashboard (for active dev)

```bash
pnpm run test:dashboard      # opens http://127.0.0.1:5188
```

Brings the harness up, runs `vitest --watch` for both tiers, and serves a live-updating dashboard. Edit code → vitest reruns affected tests → dashboard updates via Server-Sent Events. Per-file state is merged across runs so a single-file rerun doesn't blank out the rest of the suite.

Pair with `pnpm run dev` in another terminal so you have the app running and the test dashboard updating side-by-side. Ctrl+C to stop the watchers; Docker stays up.

### One-shot static report (for CI / agents / pre-release)

```bash
pnpm run test:full           # runs everything once, writes HTML, exits
```

Self-contained HTML report at `tests/reports/latest.html` (timestamped copy alongside). Reports are gitignored — local-only.

### Piecewise (manual)

```bash
pnpm run test                  # unit tier only (no infrastructure)
pnpm run test:harness:up       # start the Docker network
pnpm run test:integration      # run integration tier once
pnpm run test:harness:down     # tear down when done
```

## The report

`pnpm run test:full` produces a single self-contained HTML file styled to match Joinery's purple-tinted theme.

- **Hero counters** — passed / failed / skipped / duration
- **Synopsis** — one-line business-language summary
- **Failure focus list** — every failed test surfaced at the top with full error + stack
- **Tier sections** — collapsible per-tier (Unit, Integration, E2E, Visual, Performance)
- **Suite sections** — collapsible per-spec-file with pass/fail counts
- **Copy for LLM** — every section has its own button. Click it on a failed test to grab a token-efficient markdown summary (file path, test name, git context, error + truncated stack) ready to paste into a Claude session along with your fix request.

## Available scripts

| Script                            | What it does                                                             |
| --------------------------------- | ------------------------------------------------------------------------ |
| `pnpm run test`                   | Unit tier only (no infrastructure required)                              |
| `pnpm run test:integration`       | Integration tier — requires harness up                                   |
| `pnpm run test:integration:watch` | Integration in watch mode for active dev                                 |
| `pnpm run test:full`              | All tiers + HTML report. Brings harness up automatically.                |
| `pnpm run test:dashboard`         | Live HTML dashboard at http://127.0.0.1:5188, vitest watch on both tiers |
| `pnpm run test:e2e:react`         | Functional E2E tier (`tests/e2e-react/`)                                 |
| `pnpm run test:e2e:react:live`    | Same, but stream events to the dashboard                                 |
| `pnpm run test:visual:react`      | Visual baselines (`tests/e2e-react-visual/`) — macOS only                |
| `pnpm run test:visual:react:live` | Same, but stream events to the dashboard                                 |
| `pnpm run test:perf:react`        | Performance gates (`tests/e2e-react-perf/`) — slow                       |
| `pnpm run test:harness:up`        | Start docker-compose network, generate SSH keypair if needed             |
| `pnpm run test:harness:down`      | Stop network and remove volumes                                          |
| `pnpm run test:harness:status`    | Show compose service health                                              |

`test:full` accepts flags via `pnpm run test:full -- <flag>`:

- `--no-harness` skip the integration tier (unit-only run)
- `--no-e2e` skip every Playwright tier
- `--no-perf` skip the slow performance tier only
- `--teardown` tear the harness down at the end

## Keychain isolation in the Electron tiers

Every Playwright tier launches the real Joinery app, and the real app keeps saved passwords —
connection credentials and AI provider keys — in the macOS **login keychain**. That store is scoped
to the logged-in user and namespaced only by a service name, so `--user-data-dir` (which isolates
everything the app writes to disk) does nothing for it.

So each launcher exports `JOINERY_KEYCHAIN_SERVICE=ca.adam11.joinery.tests`, and
`packages/main/src/services/keychain/service-name.ts` resolves the credential store's service name
from it. Nothing sets the variable in a shipped app, so an installed Joinery still uses
`ca.adam11.joinery` exactly as before.

- Set in `tests/helpers/electron-app.ts` (behind all five Playwright projects) and in
  `tests/scripts/perf-baseline.mjs`.
- Applied AFTER a spec's own `envOverrides`, on purpose: which vault the app under test writes to is
  a property of the tier, not a per-spec knob.
- **Honoured only while the app is unpackaged** (J-161). Both launchers boot
  `packages/main/dist/index.js` through `node_modules/electron`, so `app.isPackaged` is false and
  the override applies. A packaged `Joinery.app` refuses the variable, keeps its own service, and
  logs a `CredentialStore` warning — a shipped, signed app is the one binary the user has already
  trusted with their keychain, and the environment does not get to aim it elsewhere.
  **So a launcher in this directory must never point Electron at a packaged bundle**: the pin
  would still be set, the app would ignore it, and the tier would read and rewrite the developer's
  real vault. The one launcher that does boot a bundle lives outside this directory and earns the
  override a different way — see [below](#launchers-that-start-a-packaged-bundle).
- Guarded by `packages/main/src/services/keychain/keychain-service-isolation.spec.ts`, which fails
  the **unit** tier if a launcher stops setting the variable, names the production service, or
  starts launching a packaged bundle.

### The same rule holds for every environment hatch

`JOINERY_KEYCHAIN_SERVICE` is not the only variable the tiers use to steer the app, and since J-161
none of them are honoured by a packaged build. `packages/main/src/utils/runtime-mode.ts` is the one
place that reads `app.isPackaged` and decides:

| Variable                   | Set by         | What it does unpackaged                                                                    | Packaged                                                                                                                 |
| -------------------------- | -------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `JOINERY_TEST=1`           | both launchers | keeps the main window hidden, so it does not flash in and out on every spec                | ignored — the window shows — unless the bundle is stamped a test build                                                   |
| `NODE_ENV=development`     | `pnpm run dev` | loads the Vite dev server instead of the bundled renderer, opens devtools, relaxes the CSP | ignored, stamped or not — a bundle has no dev server, and this is the hatch that would serve someone else's page into it |
| `JOINERY_KEYCHAIN_SERVICE` | both launchers | repoints the credential vault (above)                                                      | ignored, with a logged warning — unless the bundle is stamped a test build                                               |

The practical consequence for anyone writing a new tier: **a launcher that starts a packaged
`Joinery.app` built by `pnpm run package` gets none of this.** It will show a window, and it will
read and write the developer's real keychain vault. Build it with `pnpm run package:test` instead —
the capability is baked into the bundle rather than passed in the environment (J-167), because an
environment variable is exactly the thing a shipped app must not trust: whoever can set one to
unlock a shipped app can set two.

`packages/main/src/utils/env-hatch-gating.spec.ts` fails the unit tier if any other file in
`packages/main` so much as names one of these variables, which is what keeps the rule true through
the next refactor.

A test run therefore leaves exactly one stray keychain item, `ca.adam11.joinery.tests`. Delete it in
Keychain Access (or `security delete-generic-password -s ca.adam11.joinery.tests`) whenever you like;
the next run recreates it.

### Launchers that start a PACKAGED bundle

`scripts/release/smoke-packaged-app.ts` is the one launcher that boots `Joinery.app` rather than
`packages/main/dist/index.js`, and setting the environment pin is not enough for it: a shipped,
signed app is the binary the user has already trusted with their keychain, so it must not let the
environment aim it somewhere else. The way back in for a test is a property of the ARTIFACT —
`pnpm run package:test` writes `Contents/Resources/joinery-test-build` into the bundle, nothing in
the environment can forge it, and `pnpm run verify:package` fails on a release bundle that carries
it (J-167).

`keychain-service-isolation.spec.ts` therefore splits its launch sites in two. Every launcher must
set `JOINERY_KEYCHAIN_SERVICE` and must not name the production service; an unpackaged launcher
must additionally never name a bundle path, and a packaged launcher must additionally refuse a
bundle that was not stamped, which `assertBundleIsTestCapable` does before Electron starts.

The stamp is what makes the pin work: `packages/main/src/utils/test-build-capability.ts` reads the
marker, `packages/main/src/utils/runtime-mode.ts` carries it as `RuntimeSignals.isTestBuild`, and
`services/keychain/service-name.ts` honours the override for a runtime that has it. So the smoke
run gets both halves it needs — a throwaway keychain service and a hidden window — and a release
bundle, which cannot carry the marker, gets neither.

## What's running in the test network

Defined in [`docker-compose.test.yml`](./docker-compose.test.yml). Host ports are deliberately non-standard so they don't clash with anything you already have running.

| Service            | Image                                                    | Host port | Default DB        | Notes                                    |
| ------------------ | -------------------------------------------------------- | --------- | ----------------- | ---------------------------------------- |
| `mssql`            | `mcr.microsoft.com/mssql/server:2022-latest` (Developer) | `11433`   | `master`          | sa / `JoineryTest!Pa55`                  |
| `postgres`         | `postgres:16-alpine`                                     | `15432`   | `joinery_test`    | joinery / joinery                        |
| `mysql`            | `mysql:8`                                                | `13306`   | `joinery_test`    | joinery / joinery                        |
| `postgres-private` | `postgres:16-alpine`                                     | _(none)_  | `joinery_private` | Reachable **only** through bastion       |
| `bastion`          | `linuxserver/openssh-server`                             | `12222`   | n/a               | Public-key auth via `tests/.ssh/id_test` |

## Synthetic fixture

Identical schema across all three SQL engines (lives in `fixtures/{mssql,postgres,mysql}/`). E-commerce shape — products, customers, orders, order_items.

Seed data: 10 products, 5 customers, 8 orders, 15 order items. Deterministic and identical across engines so cross-engine result comparisons work.

## Writing a new integration test

```ts
import { describe, it, expect } from 'vitest';
import { withFreshDatabase, applyFixture } from '../helpers/db-fixtures.js';
import { Client as PgClient } from 'pg';

describe('orders feature on postgres', () => {
  it('returns delivered orders', async () => {
    await withFreshDatabase('postgres', async db => {
      await applyFixture('postgres', db.databaseName, 'seed');

      const client = new PgClient({ ...db.config });
      await client.connect();
      try {
        const r = await client.query(`SELECT id FROM orders WHERE status = 'delivered'`);
        expect(r.rowCount).toBe(3);
      } finally {
        await client.end();
      }
    });
  });
});
```

`withFreshDatabase` creates a uniquely-named database, applies `schema.sql`, hands you connection config, and drops the database on exit. Pair it with `applyFixture(..., 'seed')` if you want the synthetic dataset.

## SSH tunnel testing (Phase 2)

The bastion sits on two networks: the public test network and a private one shared with `postgres-private`. SSH tunnel tests connect to `localhost:12222` with the keypair at `tests/.ssh/id_test`, forward `5432` on `postgres-private`, and exercise tunneled connections end-to-end.

Helper for this is coming in Phase 2.

## What's next (planned phases)

- **Phase 2** — Real integration specs: dialect smoke per engine, query-executor across engines, SSH tunnel happy path.
- **Phase 3** — LLM mock + cassette replay for deterministic AI tests.
- **Phase 4** — Playwright E2E suite covering everything from `regression-suite.md` (the legacy MSSQL audit) plus PG, MySQL, AI chat.
- **Phase 5** ✓ — Visual regression baselines under `tests/__snapshots__/visual-react/` (macOS-only by design; the device pixel ratio and the macOS scroller style are pinned per launch so a re-capture is not a property of the host — see `playwright.config.ts`'s `visual-react` project).
- **Phase 6** — `pnpm run test:full` (one-shot CI-style) ✓ and `pnpm run test:smoke` (fast subset for the agent loop) — pending.

## Troubleshooting

**`test:harness:up` fails on macOS** — Docker Desktop must be running. The MSSQL image needs ~2GB RAM allocated to Docker.

**`Connection refused` on first integration run** — `--wait` should gate on health checks but MSSQL can take ~20s after "healthy" to actually accept logins. If it fails, retry once or `pnpm run test:harness:status` to confirm all services are healthy.

**SSH key generation fails** — `ssh-keygen` is required (ships with macOS). If missing, install OpenSSH via Homebrew.

**Port already in use** — Edit `docker-compose.test.yml` and `tests/helpers/db-fixtures.ts` together to change the port mapping.

**A `ca.adam11.joinery.tests` entry appeared in Keychain Access** — expected: it is the throwaway
credential vault the Electron tiers use instead of your real one. Safe to delete at any time.
