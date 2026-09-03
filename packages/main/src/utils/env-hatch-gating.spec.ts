import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import { DOCKER_FIXTURE_ENV_VAR, resolveDockerFixture } from '../services/docker/docker-fixture';
import {
  KEYCHAIN_SERVICE_ENV_VAR,
  resolveKeychainServiceName,
} from '../services/keychain/service-name';
import { PYTHON_ENV_VAR, resolvePythonOverride } from '../services/sql/python-deps';
import { isDevelopmentHatchOpen, isTestHatchOpen } from './runtime-mode';

/**
 * The structural half of J-161: an environment hatch may only be read where it is gated.
 *
 * J-161's fix is one gated read of `JOINERY_KEYCHAIN_SERVICE`; the cycle-9 review then found the
 * identical ungated shape one file over (`window.ts` reading `JOINERY_TEST`). That is the decay
 * this guard exists to stop, and it is the same argument as
 * `services/keychain/keychain-service-isolation.spec.ts`: a rule that lives only in a comment
 * does not survive the next refactor, and the thing at stake — a shipped, signed app doing what
 * the environment tells it — is worth a failing test rather than a convention.
 *
 * So: each hatch variable below may be NAMED only in the file that gates it — that is where the
 * `app.isPackaged` check is applied, so a read anywhere else is by definition an ungated one. The
 * check is on the bare name rather than on `process.env.X`, because the prefix form is trivial to
 * slip past; see {@link namesVariable}.
 */

/**
 * Vitest is configured at the repo root and runs from it, so `cwd` is the root — the same
 * derivation, for the same reason, as `keychain-service-isolation.spec.ts` (this package compiles
 * as CommonJS, where `import.meta.url` is a type error, but vitest loads it as ESM, where
 * `__dirname` does not exist). `beforeAll` asserts the assumption rather than trusting it.
 */
const REPO_ROOT = process.cwd();
const MAIN_SRC = join(REPO_ROOT, 'packages', 'main', 'src');

/** Guards against a runaway walk if this ever runs somewhere unexpected. */
const MAX_TREE_DEPTH = 12;

/**
 * Environment variables that change what the app DOES and exist for development or testing, each
 * with the exhaustive list of files allowed to name it.
 *
 * `logger.ts` is a deliberate exception for `NODE_ENV`: it picks the default log level from it,
 * which changes only how much the app says, never what it does — and that file's header commits
 * to importing no electron so it stays safe to import from unit-tested code, which a gate here
 * would break. A louder log in a packaged app is not a security boundary.
 *
 * `JOINERY_KEYCHAIN_SERVICE` is the variable this ticket is about, so it is listed even though its
 * gate is structurally different: `service-name.ts` is the only file that names it (as the
 * `KEYCHAIN_SERVICE_ENV_VAR` constant), and the gate is applied in the same file. The store reads
 * `process.env` wholesale and hands it to that resolver, so it never names the variable at all.
 */
const GATED_HATCHES = [
  { variable: 'JOINERY_TEST', allowedIn: ['utils/runtime-mode.ts'] },
  { variable: 'NODE_ENV', allowedIn: ['utils/runtime-mode.ts', 'utils/logger.ts'] },
  {
    variable: 'JOINERY_KEYCHAIN_SERVICE',
    allowedIn: ['services/keychain/service-name.ts'],
  },
  {
    variable: 'JOINERY_DOCKER_FIXTURE',
    allowedIn: ['services/docker/docker-fixture.ts'],
  },
  { variable: 'JOINERY_PYTHON', allowedIn: ['services/sql/python-deps.ts'] },
] as const;

beforeAll(() => {
  expect(statSync(join(REPO_ROOT, 'pnpm-workspace.yaml')).isFile()).toBe(true);
  expect(statSync(MAIN_SRC).isDirectory()).toBe(true);
});

/** Every non-spec TypeScript source file in the main package, repo-relative-ish paths. */
function collectSources(dir: string, depth = 0): string[] {
  if (depth > MAX_TREE_DEPTH) {
    throw new Error(`${dir} is deeper than ${MAX_TREE_DEPTH} levels — refusing to walk further`);
  }
  const collected: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collected.push(...collectSources(full, depth + 1));
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    if (entry.name.endsWith('.spec.ts') || entry.name.endsWith('.test.ts')) continue;
    collected.push(full);
  }
  return collected;
}

/**
 * The file's lines with prose dropped. Comments are stripped because the files that no longer read
 * a hatch are exactly the files most likely to explain why in a comment — a guard that failed on
 * its own documentation would be worse than no guard.
 */
function codeLines(source: string): string[] {
  return source
    .split('\n')
    .map(line => line.trim())
    .filter(line => !line.startsWith('*') && !line.startsWith('//') && !line.startsWith('/*'));
}

/**
 * Whether a file's code so much as names the variable.
 *
 * The bare name, deliberately, rather than a `process.env.X` prefix: the review of this guard's
 * first version showed the prefix form is trivial to slip past — `process.env['JOINERY_TEST']` and
 * `const { JOINERY_TEST } = process.env` both added an ungated read and left the guard green, and
 * ESLint catches neither (`dot-notation` is off). Matching the name itself has no such gaps, and
 * over-matching is the safe direction: the false positive is a file that mentions a hatch without
 * reading it, which is a five-second read to confirm, while the false negative is a shipped app
 * doing what the environment tells it.
 */
function namesVariable(source: string, variable: string): boolean {
  return codeLines(source).some(line => line.includes(variable));
}

describe.each(GATED_HATCHES)(
  '$variable is read only where it is gated',
  ({ variable, allowedIn }) => {
    it(`is named in exactly ${allowedIn.join(', ')}`, () => {
      const readers = collectSources(MAIN_SRC)
        .filter(file => namesVariable(readFileSync(file, 'utf8'), variable))
        .map(file => relative(MAIN_SRC, file))
        .sort();

      expect(readers).toEqual([...allowedIn].sort());
    });
  }
);

/**
 * The behavioural half of J-180: every gated hatch obeys ONE predicate.
 *
 * The guard above proves a hatch is named only in the file that gates it. It cannot prove that
 * file gates it — `JOINERY_DOCKER_FIXTURE` shipped in J-76 read from exactly one place and
 * honoured by a shipped app, which is the shape this table exists to catch. Each entry names a
 * hatch and says how to ask whether a given build honours it; the cases below then drive all four
 * combinations of `isPackaged` × `isTestBuild` through it.
 *
 * `reopenedByTestBuild` is the only per-hatch difference. A J-167 test bundle
 * (`Contents/Resources/joinery-test-build`) gets the test-only hatches back, because the packaged
 * smoke run boots a real bundle and needs them; `NODE_ENV=development` is deliberately NOT
 * reopened — a stamped bundle has no dev server to reach either, so honouring it would only let
 * whoever set the variable serve their own page into a bundle that carries the preload bridge.
 * See `runtime-mode.ts`'s {@link isDevelopmentHatchOpen}.
 */
const HATCH_BEHAVIOUR = [
  {
    variable: 'JOINERY_TEST',
    reopenedByTestBuild: true,
    isHonoured: (build: BuildUnderTest) =>
      isTestHatchOpen({ ...build, env: { JOINERY_TEST: '1' } }),
  },
  {
    variable: 'NODE_ENV',
    reopenedByTestBuild: false,
    isHonoured: (build: BuildUnderTest) =>
      isDevelopmentHatchOpen({ ...build, env: { NODE_ENV: 'development' } }),
  },
  {
    variable: 'JOINERY_KEYCHAIN_SERVICE',
    reopenedByTestBuild: true,
    isHonoured: (build: BuildUnderTest) =>
      resolveKeychainServiceName({
        ...build,
        env: { [KEYCHAIN_SERVICE_ENV_VAR]: 'joinery-spec-vault' },
      }).serviceName === 'joinery-spec-vault',
  },
  {
    variable: 'JOINERY_DOCKER_FIXTURE',
    reopenedByTestBuild: true,
    isHonoured: (build: BuildUnderTest) =>
      resolveDockerFixture({
        ...build,
        env: {
          [DOCKER_FIXTURE_ENV_VAR]: JSON.stringify({
            detect: { dockerRunning: true, containers: [] },
          }),
        },
      }) !== null,
  },
  {
    variable: 'JOINERY_PYTHON',
    reopenedByTestBuild: true,
    isHonoured: (build: BuildUnderTest) =>
      resolvePythonOverride({ ...build, env: { [PYTHON_ENV_VAR]: '/tmp/venv/bin/python' } }) ===
      '/tmp/venv/bin/python',
  },
] as const;

/** The two artifact facts every hatch decision is a function of (J-161, J-167). */
type BuildUnderTest = { isPackaged: boolean; isTestBuild: boolean };

/**
 * Hatches that {@link GATED_HATCHES} pins the reader of but that are deliberately NOT gated on the
 * build marker, each with the ticket that owns the real fix. Kept — empty — rather than deleted,
 * so the cross-check below stays exhaustive: a new hatch has to be classified, not forgotten, and
 * the classification "deliberately ungated" needs somewhere to live that carries a ticket.
 *
 * Emptied by J-171, which gated `JOINERY_PYTHON`: it is the sharpest instance of the shape, since
 * it selects the executable that gets spawned inside the signed app's process tree rather than
 * redirecting a read. Gating it does cost release users the documented virtualenv escape hatch;
 * persisting an interpreter path through Settings is the replacement, and remains J-171's open
 * remainder along with the `PATH`-resolved children (`pg_dump`, `mysqldump`, `python3`).
 */
const KNOWN_UNGATED: ReadonlyArray<{ variable: string; ticket: string }> = [];

const BUILDS: ReadonlyArray<BuildUnderTest & { label: string }> = [
  { label: 'a development / Playwright launch', isPackaged: false, isTestBuild: false },
  { label: 'an unpackaged launch of a stamped tree', isPackaged: false, isTestBuild: true },
  { label: 'a packaged bundle stamped as a test build', isPackaged: true, isTestBuild: true },
  { label: 'a packaged RELEASE bundle', isPackaged: true, isTestBuild: false },
];

describe.each(HATCH_BEHAVIOUR)('$variable obeys the shared build predicate', hatch => {
  it.each(BUILDS)('$label', build => {
    const expected = !build.isPackaged || (hatch.reopenedByTestBuild && build.isTestBuild);
    expect(hatch.isHonoured({ isPackaged: build.isPackaged, isTestBuild: build.isTestBuild })).toBe(
      expected
    );
  });
});

/**
 * Ties the two tables together, so adding a hatch cannot stop at the structural guard: the new
 * reader file fails {@link GATED_HATCHES} first, and adding it there then fails here until it is
 * either given a behaviour case above or written down as a known exemption with a ticket.
 */
it('classifies every structurally gated hatch as gated or known-ungated', () => {
  const classified = [
    ...HATCH_BEHAVIOUR.map(h => h.variable),
    ...KNOWN_UNGATED.map(h => h.variable),
  ].sort();
  expect(classified).toEqual([...GATED_HATCHES.map(h => h.variable)].sort());
});
