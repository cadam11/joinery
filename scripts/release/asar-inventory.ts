/**
 * What is inside `app.asar`, measured — and what must never be inside it (J-90).
 *
 *   node scripts/release/asar-inventory.ts [path/to/app.asar]        # the table
 *   node scripts/release/asar-inventory.ts --json                    # the same numbers, machine-readable
 *   node scripts/release/asar-inventory.ts --check                   # the guard: exit 1 on a banned package
 *
 * Defaults to the archive `pnpm run package:mac` writes, the same one `scripts/verify-package.js`
 * probes. Runs under Node's type stripping (>= 22.18), so there is no build step and no `tsx` —
 * the same arrangement as `scripts/release/update-cask.ts`.
 *
 * ── Why a script rather than a one-off measurement ─────────────────────────────────────────────
 *
 * J-90 was filed on the belief that Playwright, Vitest, esbuild, eslint, rollup and `@types/*`
 * ship inside the asar because `nodeLinker: hoisted` puts every devDependency in the root
 * `node_modules`, which the wildcard `node_modules` include in `electron-builder.yml`'s `files`
 * list then collects. Measured against a real 0.5.0 arm64 build, that is **false**:
 * electron-builder collects the PRODUCTION dependency tree, so a devDependency is never a
 * candidate and none of those packages was in the archive — all 209 of its packages were
 * production-tree packages.
 *
 * The same measurement found two things worth the ticket. First, `devicon` — 121.3 MB across 2,082
 * files, 61% of the archive — a root `dependencies` entry left behind by the Angular renderer that
 * no built artifact references. Second, and the reason nobody had noticed: while that wildcard
 * include was in `files`, NO exclusion in that file worked at all, because it lands last in the
 * pattern list app-builder-lib filters the dependency tree with and re-includes everything the
 * negations dropped. Adding an exclusion for devicon changed the archive by zero bytes; deleting
 * that one line took it from 201.3 MB to 79.4 MB.
 *
 * So the exclusions this repo needs are for *production* dependencies that are dead weight, and
 * the guard against the build-time toolchain has to be a check on the real archive rather than a
 * line of config that looks like one. Both live here. Full numbers and method:
 * `plans/release/ASAR-INVENTORY.md`.
 *
 * Every exported function above `readAsarEntries` is pure and unit-tested in
 * `asar-inventory.spec.ts`; everything below it touches disk.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { argv, stderr, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

import { getRawHeader } from '@electron/asar';

// ── The rules ──────────────────────────────────────────────────────────────────────────────────

/**
 * How a banned package is kept out, which decides what can guard it.
 *
 * - `excluded-by-config`: reachable from `dependencies`, so electron-builder WOULD collect it and
 *   an explicit `files` exclusion is the only thing keeping it out. Guarded twice — the unit tier
 *   asserts the exclusion line still exists, and `--check` asserts the archive is really clean.
 * - `absent-from-production-tree`: a devDependency, which electron-builder never collects. There
 *   is nothing for a config line to do, so `--check` on the real archive is the whole guard.
 */
export type NeverShipGroup = 'excluded-by-config' | 'absent-from-production-tree';

export interface NeverShipRule {
  /** An exact package name, or a scope followed by `/*`. */
  readonly pattern: string;
  readonly group: NeverShipGroup;
  readonly reason: string;
}

/**
 * Packages that must not be inside `app.asar`.
 *
 * The build-time entries are the ones J-90 named, plus the six `electron-builder.yml` used to
 * exclude before this change measured those exclusions as no-ops. They are listed by name rather
 * than derived from `devDependencies` on purpose: the claim being guarded is "these specific
 * things are not in the shipped archive", and a list derived from the manifest would stop making
 * that claim the moment a package moved between dependency sections.
 */
export const NEVER_SHIP: readonly NeverShipRule[] = [
  {
    pattern: 'devicon',
    group: 'excluded-by-config',
    reason:
      'a root `dependencies` entry left by the Angular renderer — 121.3 MB of icon SVGs and ' +
      'webfonts that no built artifact references (the React renderer draws lucide SVGs)',
  },
  {
    pattern: '@types/*',
    group: 'excluded-by-config',
    reason:
      'type declarations only, reached through the production tree — tedious and protobufjs ' +
      'declare @types/node as a runtime dependency, bl declares @types/readable-stream. ' +
      'electron-builder already strips the .d.ts files, so what shipped was a LICENSE and a ' +
      'package.json each',
  },
  {
    pattern: '@playwright/*',
    group: 'absent-from-production-tree',
    reason: 'the e2e/visual test driver',
  },
  { pattern: 'playwright', group: 'absent-from-production-tree', reason: 'the test driver' },
  {
    pattern: 'playwright-core',
    group: 'absent-from-production-tree',
    reason: 'the test driver’s browser bundles',
  },
  { pattern: 'vitest', group: 'absent-from-production-tree', reason: 'the unit test runner' },
  {
    pattern: '@vitest/*',
    group: 'absent-from-production-tree',
    reason: 'the unit test runner’s internals',
  },
  { pattern: 'esbuild', group: 'absent-from-production-tree', reason: 'the preload bundler' },
  {
    pattern: '@esbuild/*',
    group: 'absent-from-production-tree',
    reason: 'the preload bundler’s per-platform binaries',
  },
  { pattern: 'eslint', group: 'absent-from-production-tree', reason: 'the linter' },
  {
    pattern: '@typescript-eslint/*',
    group: 'absent-from-production-tree',
    reason: 'the linter’s TypeScript plugin',
  },
  { pattern: 'rollup', group: 'absent-from-production-tree', reason: 'a bundler' },
  { pattern: '@rollup/*', group: 'absent-from-production-tree', reason: 'a bundler’s plugins' },
  { pattern: 'typescript', group: 'absent-from-production-tree', reason: 'the compiler' },
  { pattern: 'vite', group: 'absent-from-production-tree', reason: 'the renderer build tool' },
  {
    pattern: 'rolldown',
    group: 'absent-from-production-tree',
    reason: 'the renderer bundler behind vite',
  },
  { pattern: '@vitejs/*', group: 'absent-from-production-tree', reason: 'vite plugins' },
  { pattern: 'tailwindcss', group: 'absent-from-production-tree', reason: 'the CSS toolchain' },
  {
    pattern: '@tailwindcss/*',
    group: 'absent-from-production-tree',
    reason: 'the CSS toolchain’s plugins',
  },
  {
    pattern: 'electron',
    group: 'absent-from-production-tree',
    reason:
      'the devDependency that downloads the Electron binary. The runtime is the app bundle ' +
      'itself; a copy inside the archive would be a second one',
  },
  {
    pattern: 'electron-builder',
    group: 'absent-from-production-tree',
    reason: 'the packager, building the very archive it would be inside',
  },
  { pattern: 'turbo', group: 'absent-from-production-tree', reason: 'the task runner' },
  { pattern: 'prettier', group: 'absent-from-production-tree', reason: 'the formatter' },
  { pattern: 'jsdom', group: 'absent-from-production-tree', reason: 'the unit tier’s DOM' },
];

// ── The pure half ──────────────────────────────────────────────────────────────────────────────

export interface AsarEntry {
  readonly path: string;
  readonly size: number;
}

export interface PackageUsage {
  readonly name: string;
  readonly bytes: number;
  readonly files: number;
}

export interface AsarSummary {
  readonly totalBytes: number;
  readonly fileCount: number;
  /** Bytes belonging to Joinery's own compiled output rather than to a dependency. */
  readonly appBytes: number;
  /** One entry per dependency, largest first. */
  readonly packages: readonly PackageUsage[];
}

export interface NeverShipFinding extends PackageUsage {
  readonly pattern: string;
  readonly reason: string;
}

/**
 * The package that owns an archive entry, or null for Joinery's own files.
 *
 * The LAST `node_modules` segment wins, so a nested copy is attributed to itself rather than to
 * the package carrying it — `@grpc/grpc-js/node_modules/@grpc/proto-loader/...` is proto-loader's
 * weight, not grpc-js's. Scoped names keep their scope: `@types` on its own is not a package.
 */
export function owningPackage(entryPath: string): string | null {
  const segments = entryPath.split('/');
  const lastModules = segments.lastIndexOf('node_modules');
  if (lastModules === -1) return null;

  const first = segments[lastModules + 1];
  if (first === undefined) return null;
  if (!first.startsWith('@')) return first;

  const second = segments[lastModules + 2];
  return second === undefined ? null : `${first}/${second}`;
}

/** Per-dependency weight, largest first, plus the totals a before/after comparison needs. */
export function summarizeAsarEntries(entries: readonly AsarEntry[]): AsarSummary {
  const perPackage = new Map<string, { bytes: number; files: number }>();
  let totalBytes = 0;
  let appBytes = 0;

  for (const entry of entries) {
    totalBytes += entry.size;
    const owner = owningPackage(entry.path);
    if (owner === null) {
      appBytes += entry.size;
      continue;
    }
    const usage = perPackage.get(owner) ?? { bytes: 0, files: 0 };
    usage.bytes += entry.size;
    usage.files += 1;
    perPackage.set(owner, usage);
  }

  const packages = [...perPackage.entries()]
    .map(([name, usage]) => ({ name, bytes: usage.bytes, files: usage.files }))
    .sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));

  return { totalBytes, fileCount: entries.length, appBytes, packages };
}

/** Exact name, or every package in a scope when the pattern ends in `/*`. No glob library. */
export function matchesPackagePattern(packageName: string, pattern: string): boolean {
  if (!pattern.endsWith('/*')) return packageName === pattern;
  return packageName.startsWith(pattern.slice(0, -1));
}

/** Every banned package present in the archive, with the weight it is costing and why it is banned. */
export function findNeverShipPackages(
  packages: readonly PackageUsage[],
  rules: readonly NeverShipRule[] = NEVER_SHIP
): NeverShipFinding[] {
  const findings: NeverShipFinding[] = [];
  for (const usage of packages) {
    const rule = rules.find(candidate => matchesPackagePattern(usage.name, candidate.pattern));
    if (rule === undefined) continue;
    findings.push({ ...usage, pattern: rule.pattern, reason: rule.reason });
  }
  return findings;
}

/** The `electron-builder.yml` `files` entry that keeps a pattern's packages out of the archive. */
export function exclusionGlobFor(pattern: string): string {
  const body = pattern.endsWith('/*') ? pattern.slice(0, -2) : pattern;
  return `!**/node_modules/${body}/**`;
}

/**
 * The `excluded-by-config` patterns whose exclusion line is missing from the given config source.
 *
 * A substring test on the raw YAML, not a parse: `files` is a list of strings whose ORDER matters
 * to electron-builder, and every candidate here is a whole quoted list item, so there is nothing a
 * parse would disambiguate.
 */
export function missingExclusions(
  configSource: string,
  rules: readonly NeverShipRule[] = NEVER_SHIP
): string[] {
  return rules
    .filter(rule => rule.group === 'excluded-by-config')
    .map(rule => exclusionGlobFor(rule.pattern))
    .filter(glob => !configSource.includes(glob));
}

/** Bytes as MB to one decimal — the unit every number in `plans/release/ASAR-INVENTORY.md` uses. */
export function formatMegabytes(bytes: number): string {
  return (bytes / 1_000_000).toFixed(1);
}

/** The measurement table. Pure, so the spec can assert the shape of what a reader sees. */
export function formatInventory(summary: AsarSummary, top: number): string {
  const lines = [
    `${summary.fileCount} files, ${formatMegabytes(summary.totalBytes)} MB of content`,
    `${formatMegabytes(summary.appBytes)} MB Joinery's own output, ` +
      `${summary.packages.length} dependencies`,
    '',
    `        MB   files  package`,
  ];
  for (const usage of summary.packages.slice(0, top)) {
    lines.push(
      `${formatMegabytes(usage.bytes).padStart(10)}  ${String(usage.files).padStart(6)}  ${usage.name}`
    );
  }
  if (summary.packages.length > top) {
    lines.push(`… ${summary.packages.length - top} smaller dependencies not shown`);
  }
  return `${lines.join('\n')}\n`;
}

// ── The impure half ────────────────────────────────────────────────────────────────────────────

const REPO_ROOT = join(import.meta.dirname, '..', '..');

/** Where `pnpm run package:mac` and `pnpm run verify:package` both look. */
export const DEFAULT_ASAR = join(
  REPO_ROOT,
  'release/mac-arm64/Joinery.app/Contents/Resources/app.asar'
);

/** A directory tree deep enough to hit this is a corrupt header, not a dependency tree. */
const MAX_HEADER_NODES = 1_000_000;

type HeaderNode = {
  files?: Record<string, HeaderNode>;
  size?: number;
  link?: string;
};

/**
 * Every file in the archive with its size, read from the asar HEADER — no extraction.
 *
 * Links are skipped: an asar link is a pointer to another entry in the same archive and carries no
 * bytes of its own, so counting one would double-count the target.
 */
export function readAsarEntries(asarPath: string): AsarEntry[] {
  const root = getRawHeader(asarPath).header as HeaderNode;
  const entries: AsarEntry[] = [];
  const stack: { node: HeaderNode; prefix: string }[] = [{ node: root, prefix: '' }];
  let visited = 0;

  while (stack.length > 0) {
    if ((visited += 1) > MAX_HEADER_NODES) {
      throw new Error(`${asarPath}: header has more than ${MAX_HEADER_NODES} nodes`);
    }
    const { node, prefix } = stack.pop()!;
    for (const [name, child] of Object.entries(node.files ?? {})) {
      const path = prefix === '' ? name : `${prefix}/${name}`;
      if (child.files !== undefined) stack.push({ node: child, prefix: path });
      else if (child.link === undefined) entries.push({ path, size: child.size ?? 0 });
    }
  }

  return entries;
}

export interface Args {
  readonly asarPath: string;
  readonly json: boolean;
  readonly check: boolean;
  readonly top: number;
}

export function parseArgs(args: readonly string[]): Args {
  let asarPath = DEFAULT_ASAR;
  let json = false;
  let check = false;
  let top = 25;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') json = true;
    else if (arg === '--check') check = true;
    else if (arg === '--top') {
      const value = Number(args[(index += 1)]);
      if (!Number.isInteger(value) || value <= 0) throw new Error('--top needs a positive integer');
      top = value;
    } else if (arg.startsWith('--')) throw new Error(`unknown flag ${arg}`);
    else asarPath = arg;
  }

  return { asarPath, json, check, top };
}

/** The guard. Returns the number of problems, so the caller owns the exit code. */
function runCheck(summary: AsarSummary, configSource: string): number {
  const findings = findNeverShipPackages(summary.packages);
  const missing = missingExclusions(configSource);

  for (const glob of missing) {
    stdout.write(`  FAIL  electron-builder.yml no longer excludes ${glob}\n`);
  }
  for (const finding of findings) {
    stdout.write(
      `  FAIL  ${finding.name.padEnd(28)} ${formatMegabytes(finding.bytes)} MB in ` +
        `${finding.files} file(s) — ${finding.reason}\n`
    );
  }

  const problems = findings.length + missing.length;
  stdout.write(
    problems === 0
      ? `  ok    no build-time or dead package in the archive (${summary.packages.length} checked)\n`
      : `\n${problems} problem(s). Add the missing exclusion to electron-builder.yml's \`files\`, ` +
          `or — if the package is genuinely needed at runtime — drop its rule from NEVER_SHIP in ` +
          `scripts/release/asar-inventory.ts and say why.\n`
  );
  return problems;
}

function main(args: readonly string[]): number {
  const parsed = parseArgs(args);
  if (!existsSync(parsed.asarPath)) {
    throw new Error(`no asar at ${parsed.asarPath} — run "pnpm run package:dir" first`);
  }

  const summary = summarizeAsarEntries(readAsarEntries(parsed.asarPath));

  if (parsed.json) {
    stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return 0;
  }
  if (parsed.check) {
    return runCheck(summary, readFileSync(join(REPO_ROOT, 'electron-builder.yml'), 'utf8')) === 0
      ? 0
      : 1;
  }

  stdout.write(formatInventory(summary, parsed.top));
  return 0;
}

// Run only when invoked as a script; importing this file from a test must not touch disk.
// `fileURLToPath(import.meta.url)` rather than `import.meta.filename`, which @types/node 20
// (pinned in pnpm-workspace.yaml) does not declare.
if (fileURLToPath(import.meta.url) === argv[1]) {
  try {
    process.exitCode = main(argv.slice(2));
  } catch (error) {
    stderr.write(`asar-inventory: ${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}
