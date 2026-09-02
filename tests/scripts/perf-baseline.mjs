/**
 * Perf baseline harness (Phase 0 of the perf-tuning plan).
 *
 * Launches the built Joinery app N times against a fresh, isolated user-data
 * dir and reports cold-start timings plus post-settle memory. Not a CI gate —
 * run manually before/after perf work and compare:
 *
 *   node tests/scripts/perf-baseline.mjs [--runs=3] [--hidden]
 *
 * --hidden sets JOINERY_TEST=1 (window stays hidden; skips paint cost, useful
 * on CI). Default is a visible window, closest to what a user experiences.
 *
 * Caveat: a fresh user-data dir measures the empty-profile floor. Real-world
 * startup on a long-lived profile also pays store-file loading, which this
 * script does not capture.
 */

import { _electron as electron } from '@playwright/test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MAIN_ENTRY = join(REPO_ROOT, 'packages', 'main', 'dist', 'index.js');

const MAX_RUNS = 10;
const SETTLE_MS = 3000;
const SHELL_TIMEOUT_MS = 30_000;

function parseArgs(argv) {
  const runsArg = argv.find((a) => a.startsWith('--runs='));
  const runs = Math.min(MAX_RUNS, Math.max(1, Number(runsArg?.split('=')[1] ?? 3)));
  return { runs, hidden: argv.includes('--hidden') };
}

async function measureOnce({ hidden }) {
  const userDataDir = mkdtempSync(join(tmpdir(), 'joinery-perf-'));
  const t0 = performance.now();
  const app = await electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      ...(hidden ? { JOINERY_TEST: '1' } : {}),
      // Same throwaway keychain namespace the Playwright launcher uses. A fresh user-data dir
      // isolates disk, not the login keychain, so without this a benchmark run would read and
      // rewrite the developer's real credential vault (J-96).
      JOINERY_KEYCHAIN_SERVICE: 'ca.adam11.joinery.tests',
    },
  });
  try {
    const window = await app.firstWindow();
    const tFirstWindow = performance.now() - t0;
    await window.waitForLoadState('domcontentloaded');
    const tDom = performance.now() - t0;
    await window.waitForSelector('app-shell', { state: 'attached', timeout: SHELL_TIMEOUT_MS });
    const tShell = performance.now() - t0;

    await window.waitForTimeout(SETTLE_MS);
    const metrics = await app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics());
    // workingSetSize is reported in KB.
    const memMb = metrics.reduce((sum, p) => sum + p.memory.workingSetSize / 1024, 0);
    return {
      firstWindowMs: Math.round(tFirstWindow),
      domMs: Math.round(tDom),
      shellMs: Math.round(tShell),
      memoryMb: Math.round(memMb),
      processes: metrics.length,
    };
  } finally {
    await app.close().catch((err) => console.error('[perf-baseline] close failed:', err));
    rmSync(userDataDir, { recursive: true, force: true });
  }
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

const { runs, hidden } = parseArgs(process.argv.slice(2));
if (!existsSync(MAIN_ENTRY)) {
  console.error(`[perf-baseline] missing ${MAIN_ENTRY} — run \`pnpm run build\` first.`);
  process.exit(1);
}

const results = [];
for (let i = 0; i < runs; i++) {
  const r = await measureOnce({ hidden });
  results.push(r);
  console.error(`[perf-baseline] run ${i + 1}/${runs}:`, JSON.stringify(r));
}

const summary = {
  mode: hidden ? 'hidden' : 'visible',
  runs,
  median: {
    firstWindowMs: median(results.map((r) => r.firstWindowMs)),
    domMs: median(results.map((r) => r.domMs)),
    shellMs: median(results.map((r) => r.shellMs)),
    memoryMb: median(results.map((r) => r.memoryMb)),
  },
  all: results,
};
console.log(JSON.stringify(summary, null, 2));
