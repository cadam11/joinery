/**
 * Stamp a released version and its two DMG checksums into the Joinery Homebrew cask.
 *
 * Run by `.github/workflows/release.yml` against the tap's copy of `Casks/joinery.rb`, and by
 * the same workflow's `guard` job against a throwaway copy of this repo's template, so a cask
 * this script can no longer rewrite fails the release before anything is built.
 *
 *   node scripts/release/update-cask.ts \
 *     --cask tap/Casks/joinery.rb --version 1.2.3 --sha256-arm64 <64 hex> --sha256-x64 <64 hex>
 *
 * Runs under Node's type stripping (>= 22.18), so there is no build step and no `tsx`.
 *
 * `updateCaskSource` is pure and holds every rule; `main` is the only thing that touches disk.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { argv } from 'node:process';
import { fileURLToPath } from 'node:url';

export interface CaskUpdate {
  version: string;
  sha256Arm64: string;
  sha256X64: string;
}

export interface CaskArgs extends CaskUpdate {
  cask: string;
}

/** Semver, no build metadata, no leading `v` — the tag's `v` is stripped before we see it. */
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

/** The three lines this script owns, and nothing else in the cask. */
const VERSION_STANZA = /^(\s*version ")[^"\n]*(")$/m;
const ARM_STANZA = /^(\s*sha256 arm:\s+")[^"\n]*(",)$/m;
const X64_STANZA = /^(\s*intel: ")[^"\n]*(")$/m;

function assertMatches(value: string, pattern: RegExp, field: string): void {
  if (!pattern.test(value)) {
    throw new Error(`${field} is not valid: ${JSON.stringify(value)} does not match ${pattern}`);
  }
}

/**
 * Replace the one line `pattern` matches. Throws when it matches zero times or more than once —
 * a rewriter that silently no-ops is how a release ships a cask pointing at the previous version.
 */
function replaceOnlyMatch(source: string, pattern: RegExp, value: string, label: string): string {
  const global = new RegExp(pattern.source, `${pattern.flags}g`);
  const count = source.match(global)?.length ?? 0;
  if (count !== 1) {
    throw new Error(`expected exactly one ${label} in the cask, found ${count}`);
  }
  return source.replace(pattern, `$1${value}$2`);
}

export function updateCaskSource(source: string, update: CaskUpdate): string {
  assertMatches(update.version, VERSION_RE, 'version');
  assertMatches(update.sha256Arm64, SHA256_RE, 'sha256Arm64');
  assertMatches(update.sha256X64, SHA256_RE, 'sha256X64');

  const withVersion = replaceOnlyMatch(source, VERSION_STANZA, update.version, 'version stanza');
  const withArm = replaceOnlyMatch(
    withVersion,
    ARM_STANZA,
    update.sha256Arm64,
    'arm64 sha256 stanza'
  );
  return replaceOnlyMatch(withArm, X64_STANZA, update.sha256X64, 'x64 sha256 stanza');
}

const FLAGS = {
  '--cask': 'cask',
  '--version': 'version',
  '--sha256-arm64': 'sha256Arm64',
  '--sha256-x64': 'sha256X64',
} as const;

type FlagName = keyof typeof FLAGS;

export function parseArgs(args: readonly string[]): CaskArgs {
  const found = new Map<string, string>();

  // Bounded by the argument list; each iteration consumes at least one element.
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    if (!(flag in FLAGS)) {
      throw new Error(
        `unknown argument ${flag} — expected one of ${Object.keys(FLAGS).join(', ')}`
      );
    }
    const value = args[i + 1];
    if (value === undefined) {
      throw new Error(`${flag} needs a value`);
    }
    found.set(FLAGS[flag as FlagName], value);
  }

  const missing = Object.entries(FLAGS)
    .filter(([, key]) => !found.has(key))
    .map(([flag]) => flag);
  if (missing.length > 0) {
    throw new Error(`missing required argument(s): ${missing.join(', ')}`);
  }

  return {
    cask: found.get('cask') as string,
    version: found.get('version') as string,
    sha256Arm64: found.get('sha256Arm64') as string,
    sha256X64: found.get('sha256X64') as string,
  };
}

function main(args: readonly string[]): void {
  const parsed = parseArgs(args);
  const before = readFileSync(parsed.cask, 'utf8');
  const after = updateCaskSource(before, parsed);
  writeFileSync(parsed.cask, after);
  const verb = after === before ? 'already at' : 'updated to';
  process.stdout.write(`${parsed.cask}: ${verb} ${parsed.version}\n`);
}

// Run only when invoked as a script; importing this file from a test must not touch disk.
// `fileURLToPath(import.meta.url)` rather than `import.meta.filename`, which @types/node 20
// (pinned in pnpm-workspace.yaml) does not declare.
if (fileURLToPath(import.meta.url) === argv[1]) {
  try {
    main(argv.slice(2));
  } catch (error) {
    process.stderr.write(`update-cask: ${(error as Error).message}\n`);
    process.exit(1);
  }
}
