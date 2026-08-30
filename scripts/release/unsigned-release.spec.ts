/**
 * Joinery ships without an Apple Developer Program membership (Craig's ruling, 2026-08-30).
 *
 * Three things follow from that, and each of them is a claim the repository makes to a user
 * somewhere. They are cheap to break silently and expensive to discover in a release, so they
 * are asserted here against the real files rather than fixtures.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..', '..');

function readRepoFile(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf8');
}

describe('electron-builder.yml', () => {
  it('declares the macOS signing identity as null, so no build ever looks for a certificate', () => {
    const config = parse(readRepoFile('electron-builder.yml')) as {
      mac?: { identity?: unknown };
    };

    // app-builder-lib's own schema: "**`null`**: skip signing entirely", versus "**Not set**
    // (default): electron-builder searches the keychain for a valid signing certificate". Not
    // set is the state that changes behaviour the day a certificate happens to be installed on
    // whatever machine runs the build; null is the state that cannot.
    expect(config.mac).toBeDefined();
    expect('identity' in (config.mac as object)).toBe(true);
    expect(config.mac?.identity).toBeNull();
  });
});

describe('.github/workflows/release.yml', () => {
  const workflowSource = readRepoFile('.github/workflows/release.yml');
  const workflow = parse(workflowSource) as {
    jobs: Record<string, { steps?: unknown[] }>;
  };

  it('asks for no Apple signing or notarization secret', () => {
    // There is no Apple Developer account, so a workflow that reads these secrets is describing
    // a path that cannot run. Worse, a half-populated set used to be indistinguishable from a
    // typo. The whole gate is gone; this keeps it gone.
    expect(workflowSource).not.toMatch(/secrets\.CSC_/);
    expect(workflowSource).not.toMatch(/secrets\.APPLE_/);
    expect(workflowSource).not.toMatch(/CSC_IDENTITY_AUTO_DISCOVERY/);
  });

  it('proves the Homebrew tap token in the guard job, before anything is published', () => {
    // The token is only *used* by the last job. Checking it there means discovering a missing
    // secret after the GitHub Release is already public and permanent.
    const guardSteps = JSON.stringify(workflow.jobs.guard.steps);
    expect(guardSteps).toContain('secrets.HOMEBREW_TAP_TOKEN');
  });
});

describe('quarantine removal instructions', () => {
  it('are recursive everywhere they appear', () => {
    // Homebrew sets com.apple.quarantine on the download and then propagates it onto every
    // extracted file (Cask::Download#extract_primary_container -> Quarantine.propagate, which
    // globs `to/**/*`). A non-recursive `xattr -d` on the bundle root therefore leaves the
    // attribute on everything inside it, and the app is still blocked.
    const files = execFileSync('git', ['grep', '-l', '--', 'com.apple.quarantine'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(line => line.length > 0)
      .filter(line => line !== 'scripts/release/unsigned-release.spec.ts');

    // A grep that matches nothing would make every assertion below vacuous.
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      for (const line of readRepoFile(file).split('\n')) {
        if (!line.includes('xattr') || !line.includes('com.apple.quarantine')) continue;
        if (!/xattr\s+-[a-z]*r[a-z]*\s/.test(line)) offenders.push(`${file}: ${line.trim()}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
