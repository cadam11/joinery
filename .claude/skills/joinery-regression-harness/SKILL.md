---
name: joinery-regression-harness
description: Use the Joinery regression test harness to drive quality on every non-trivial change — TDD/BDD style: harness up first, failing test first, implementation second, green test confirms intent. Trigger this skill BEFORE starting any non-trivial dev work that touches packages/main, packages/renderer, packages/shared, or packages/preload — and AFTER making changes (to catch regressions early). The user has 268+ tests across four tiers (unit, integration, e2e, visual) wired into a fast pipeline at `pnpm run test:full`. Make sure to use this skill whenever the user asks you to fix, implement, refactor, add, or otherwise modify substantive code in this repo, even if they don't explicitly ask you to "run the tests" — they expect you to verify your work and to write the test FIRST when the change is feature-shaped. The dashboard at http://127.0.0.1:5188 is for the human to watch your progress; you should rely on programmatic mechanisms (package scripts, structured JSON output) to drive and interpret runs.
---

# Joinery Regression Harness

This repo has a comprehensive regression test harness. Use it. Use it _first_. The workflow below tells you when and how.

## Start every non-trivial task this way

The user has invested heavily in this harness so it can drive quality on every change — not just verify after the fact. Default workflow when the user asks for a feature, fix, or refactor:

1. **Make sure the harness is up.** Check whether the dashboard is already running:

   ```
   curl -sf -o /dev/null -w "%{http_code}\n" http://127.0.0.1:5188/ 2>&1
   ```

   - 200 → harness is live, watching files; carry on.
   - Anything else → ask the user to run `pnpm run test:dashboard` in another terminal so they can watch the run live. (You can still drive runs with `pnpm run test:full` etc., but the dashboard makes the iteration loop visible.)

2. **Establish baseline green.** `pnpm test` (or the right tier — see below). Don't start work on top of pre-existing failures; surface those first and get alignment with the user on whether they're in scope.
3. **Write the failing test FIRST.** Express the new behavior as a test the harness can run before the production code exists. The test failing tells you the test actually exercises the new path; the test going green tells you the implementation matches the contract you wrote down.
4. **Implement until the test goes green.** Smallest change that satisfies the assertion. Don't expand scope.
5. **Run the broader tier** to catch neighbor regressions, then `pnpm run test:full` before declaring done.

This is non-negotiable for feature-shaped work. For genuine bug-fix work, write the regression test that _reproduces_ the bug first, watch it fail, then fix until it passes — same loop, same discipline.

When TDD/BDD doesn't fit cleanly:

- **UI tweaks where the assertion is visual** — run the visual tier, look at the diff, confirm intent, regenerate baselines. The "test first" is harder; in this case write the visual test alongside the change rather than before.
- **Pure refactor with no behavior change** — no new test needed; existing tests are the contract. Just make sure they stay green.
- **Exploratory spike** — fine to skip TDD for the spike itself, but rewrite test-first when you turn it into something that ships.

## When to use

The harness is fast (~13s for the full pipeline) and the cost of running it is far lower than the cost of shipping a regression. Run it proactively at three points:

| Moment                                   | Command                                    | Why                                                              |
| ---------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------- |
| **Before starting** non-trivial dev work | `pnpm test` (unit baseline)                | Confirms the starting state is green so any new failure is yours |
| **After a logical chunk** of work        | The narrowest tier you touched (see below) | Tight feedback loop while you're iterating                       |
| **Before declaring done** / committing   | `pnpm run test:full`                       | Complete picture across all tiers                                |

**Don't run** for trivial changes (typos, comments, doc-only changes, modifications to the test harness itself). Running tests on tests is recursive — `tests/integration/harness.spec.ts` is the canary that verifies the harness, you don't need a meta-canary.

## How to trigger (programmatic)

Two pathways — **prefer the dashboard's blocking-run endpoint when it's up**, since it gives you the result inline without polling files.

### When the dashboard is up: blocking HTTP run (preferred for Claude)

```bash
# Trigger a tier and wait for the result in one shot. Body is the compact
# summary JSON: { tier, status, totals, failures: [...] }.
curl -sX POST 'http://127.0.0.1:5188/control/run-tier?wait=true' \
  -H 'content-type: application/json' \
  -d '{"tier":"e2e"}'
```

The `?wait=true` variant holds the connection open until the run completes (5-minute hard cap), then returns just the failures + totals — no polling, no file reads. Drop the query string and you'll get a fire-and-forget ack instead.

To re-read the latest result for a tier without re-running:

```bash
curl -s http://127.0.0.1:5188/api/result/e2e
```

To re-run a single suite:

```bash
curl -sX POST http://127.0.0.1:5188/control/run-suite \
  -H 'content-type: application/json' \
  -d '{"tier":"e2e","file":"tests/e2e-react/connection.spec.ts"}'
```

### When the dashboard is NOT up: npm scripts

| Script                       | Tier(s)                     | Wall time | Infra needed                     |
| ---------------------------- | --------------------------- | --------- | -------------------------------- |
| `pnpm test`                  | Unit                        | ~700ms    | None                             |
| `pnpm run test:integration`  | Integration                 | ~3s       | `pnpm run test:harness:up` first |
| `pnpm run test:e2e:react`    | E2E (Playwright + Electron) | minutes   | `pnpm run build` first           |
| `pnpm run test:visual:react` | Visual regression baselines | ~2 min    | `pnpm run build` first           |
| `pnpm run test:perf:react`   | Performance budget gates    | slow      | `pnpm run build` first           |
| `pnpm run test:full`         | All five                    | ~20 min   | Brings harness up automatically  |

`pnpm run test:full` is the most useful single command: brings the Docker harness up, runs every tier, writes structured JSON to `tests/reports/.cache/`, generates the HTML report at `tests/reports/latest.html`, and exits non-zero on any failure.

## How to interpret results

Four signals, in order of cost-to-read (cheapest first):

1. **Compact markdown summary** at `tests/reports/.cache/{tier}.summary.md` — one file per tier, written by the dashboard server every time a tier finishes. Failures-only with totals + duration at the top. **Read this first.** It's deliberately small enough to fit in a Claude turn without burning context.

2. **Compact JSON summary** at `tests/reports/.cache/{tier}.summary.json` — same data, machine-readable. Equivalent to `GET /api/result/{tier}` from the dashboard. Use when you need to grep or filter programmatically.

3. **Exit code** — when triggering via npm (not via the dashboard's blocking endpoint). Non-zero means at least one failure; zero means the tier ran clean.

4. **Full structured JSON** at `tests/reports/.cache/{tier}.json` — every test, including passes. Bigger payload. Reach for this only if the summary doesn't tell you enough (e.g. you need timing data for passing tests, or attachment paths for visual diffs).

5. **Static HTML report** at `tests/reports/latest.html` — has every result with per-section `data-copy-payload` LLM-ready snippets baked in. Useful when you want the same context the human is looking at, but the summary file is usually enough.

## How to iterate on failures

When a test fails, do this — not a dump-and-pray full-pipeline retry:

1. **Read the summary** — `tests/reports/.cache/{tier}.summary.md`. Failures-only, formatted for you. Tells you which suite + which test + the failure message.
2. **Read the failing test source** to understand what it's verifying.
3. **Read the production code under test** — the test usually targets a specific module.
4. **Make a focused fix** — narrow scope, don't refactor adjacent code.
5. **Re-run JUST that suite** to iterate quickly. If the dashboard is up:
   ```bash
   curl -sX POST 'http://127.0.0.1:5188/control/run-suite' \
     -H 'content-type: application/json' \
     -d '{"tier":"e2e","file":"tests/e2e-react/connection.spec.ts"}'
   curl -s http://127.0.0.1:5188/api/result/e2e
   ```
   Otherwise:
   - Vitest: `pnpm exec vitest run <path/to/spec.ts>` (unit) or `pnpm exec vitest run --config vitest.integration.config.ts <path>` (integration)
   - Playwright: `pnpm exec playwright test --project=e2e-react <path>` or `--project=visual-react <path>`
6. Once the targeted suite passes, run the broader tier with `?wait=true` (dashboard) or `pnpm test` / `pnpm run test:integration` (no dashboard) to catch neighbor regressions.
7. Before declaring done, run `pnpm run test:full`.

## Picking the right tier for your change

Match the tier to what you touched:

- **Pure logic changes** (utilities, parsers, validators in `packages/*/src/`) → `pnpm test` (unit). Almost always the right starting point.
- **Service / SQL / DB changes** (anything in `packages/main/src/services/sql`, `services/ssh`, dialects, connection pools) → `pnpm run test:integration`. Real DB roundtrips catch what mocks can't.
- **AI / LLM provider changes** → `pnpm run test` for the unit-level llm-providers spec. (Live LLM calls are intentionally not in the suite — manual pre-release check.)
- **UI / React component changes** → `pnpm run build && pnpm run test:e2e:react` for functional, plus `pnpm run test:visual:react` for layout regression.
- **Anything significant** → `pnpm run test:full` before declaring done.

## Visual regression specifics

The visual tier uses Playwright's `toHaveScreenshot()` against committed PNG baselines under `tests/__snapshots__/visual-react/`. It's macOS-only by design (per-developer M-series Macs all produce equivalent baselines).

When you make an **intentional UI change**, the visual tests will fail (the new look doesn't match the old baseline). Re-capture with:

```
pnpm exec playwright test --project=visual-react --update-snapshots
```

Then verify the regenerated baselines look right (the human will see them in the dashboard / static report) and commit them alongside the UI change. Don't blindly run `:update` to silence failures — confirm the change was deliberate first.

## Infrastructure context

The test harness is Docker Compose (`tests/docker-compose.test.yml`) with five services:

- `mssql` — SQL Server 2022 dev edition, host port 11433
- `postgres` — PostgreSQL 16, host port 15432
- `mysql` — MySQL 8, host port 13306
- `bastion` — SSH bastion (linuxserver/openssh-server, patched config to allow TCP forwarding), host port 12222
- `postgres-private` — A second PostgreSQL only reachable through the bastion (for SSH tunnel tests)

Synthetic e-commerce schema (products / customers / orders / order_items) lives at `tests/fixtures/{mssql,postgres,mysql}/{schema,seed}.sql` — the seed data is identical across all three engines so cross-engine result comparisons work.

Key helpers in `tests/helpers/`:

- `db-fixtures.ts` exports `withFreshDatabase(engine, fn)` — creates a uniquely-named database on the target engine, applies the schema, hands the callback connection config, drops on exit.
- `electron-app.ts` exports `withJoinery(fn)` — launches the built Joinery app via Playwright's `_electron.launch()`, hands you the ElectronApplication + first Page, closes on exit.

If the harness isn't up, `pnpm run test:integration` will fail with a connection error. Bring it up with `pnpm run test:harness:up`, or just use `pnpm run test:full` which manages the lifecycle.

## When NOT to bother

- **Documentation-only changes** (`*.md`, comments) — no test value, skip.
- **Pure refactor with passing tests already verified seconds ago** — if you literally just ran `test:full`, don't run it again unless you've made changes since.
- **Changes inside the test harness itself** (`tests/`, `tests/reporter/`) — `tests/integration/harness.spec.ts` is the canary. Run it (`pnpm exec vitest run tests/integration/harness.spec.ts --config vitest.integration.config.ts`) and trust it.

## Common pitfalls

- **Forgetting `pnpm run build` before E2E/visual** — Playwright launches `packages/main/dist/index.js`, which won't reflect source changes until you build. The test will throw a clear "expected built main process" error from `electron-app.ts` if dist is missing.
- **Treating "vitest watch ran fine in the dashboard" as confirmation** — the dashboard's vitest watcher reruns AFFECTED tests, not all of them. For "is everything still green?" use `pnpm test` or `pnpm run test:full`.
- **Updating visual baselines reflexively** — `:update` regenerates from current behavior. If you didn't intend to change the UI but a visual test fails, that's a real regression you need to investigate, not silence.

## Workflow example (TDD/BDD-first)

User says: "Add a `formatBytes` utility to the shared package and use it in the connection pool stats display."

1. **Harness check** — curl http://127.0.0.1:5188/. Not up → ask the user to start `pnpm run test:dashboard` so they can watch.
2. **Baseline** — `pnpm test` to confirm green starting state. Surface and triage anything red before adding to it.
3. **Write the failing unit test FIRST** — `packages/shared/src/utils/format-bytes.spec.ts` with the cases that define the contract (zero, KB boundary, MB boundary, GB boundary, negative input handling, etc.). Run it: `pnpm exec vitest run packages/shared/src/utils/format-bytes.spec.ts`. Confirm it fails for the right reason (the function doesn't exist yet — not a typo).
4. **Implement the smallest thing that passes** — `format-bytes.ts`. Re-run the targeted spec until green.
5. **Wire into the consumer** — connection pool stats display in renderer. If the consumer is in the renderer, the visual tier is the place to assert the user-visible result; either capture a new baseline alongside (intentional UI change) or rely on existing baselines if the layout is unchanged.
6. **Tier check** — `pnpm test` to confirm shared changes haven't broken consumers in main.
7. **Visual check (only because UI changed)** — `pnpm run build && pnpm run test:visual:react`. Diff visible? Confirm intent, `pnpm exec playwright test --project=visual-react --update-snapshots`, commit the new baseline alongside the code change.
8. **Final** — `pnpm run test:full` before declaring done.
9. Open the static report at `tests/reports/latest.html`, verify the green run, summarize for the user.
