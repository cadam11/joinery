/**
 * What ships inside `app.asar`, and what must never ship inside it (J-90).
 *
 * The pure half of `asar-inventory.ts` is asserted here; the impure half — reading a real archive
 * — is exercised by `pnpm run verify:package`, which runs the same module's `--check` mode against
 * the asar a package build just produced.
 *
 * **Every path fixture below is verbatim from a real Joinery `app.asar`** (the 0.5.0 arm64 build
 * measured for J-90, recorded in `plans/release/ASAR-INVENTORY.md`), not invented. That matters
 * because the one thing these tests could get wrong in a way that mattered is the SHAPE of an asar
 * entry path — a fixture written from memory that happened to encode the same mistake as the
 * implementation would leave the guard green and the archive wrong.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  NEVER_SHIP,
  exclusionGlobFor,
  findNeverShipPackages,
  matchesPackagePattern,
  missingExclusions,
  owningPackage,
  summarizeAsarEntries,
  type AsarEntry,
} from './asar-inventory';

const REPO_ROOT = join(import.meta.dirname, '..', '..');

describe('owningPackage', () => {
  it('attributes a top-level dependency file to that dependency', () => {
    expect(owningPackage('node_modules/devicon/devicon-base.css')).toBe('devicon');
  });

  it('keeps a scoped package’s scope, because "types" alone is not a package', () => {
    expect(owningPackage('node_modules/@types/node/package.json')).toBe('@types/node');
  });

  it('attributes a nested copy to the package that owns the file, not the outer one', () => {
    // Real entry: @grpc/grpc-js carries its own @grpc/proto-loader alongside the hoisted one.
    expect(
      owningPackage('node_modules/@grpc/grpc-js/node_modules/@grpc/proto-loader/build/src/index.js')
    ).toBe('@grpc/proto-loader');
  });

  it('returns null for the application’s own compiled output', () => {
    expect(owningPackage('packages/main/dist/__mocks__/keytar.js')).toBeNull();
  });

  it('returns null for a file at the archive root', () => {
    expect(owningPackage('package.json')).toBeNull();
  });
});

describe('summarizeAsarEntries', () => {
  const entries: readonly AsarEntry[] = [
    { path: 'package.json', size: 1051 },
    { path: 'packages/main/dist/index.js', size: 4000 },
    { path: 'node_modules/devicon/devicon-base.css', size: 70768 },
    { path: 'node_modules/devicon/.editorconfig', size: 201 },
    { path: 'node_modules/@types/node/package.json', size: 691 },
  ];

  it('totals every entry, dependency and application file alike', () => {
    const summary = summarizeAsarEntries(entries);
    expect(summary.fileCount).toBe(5);
    expect(summary.totalBytes).toBe(1051 + 4000 + 70768 + 201 + 691);
  });

  it('reports the application’s own bytes separately from its dependencies', () => {
    expect(summarizeAsarEntries(entries).appBytes).toBe(1051 + 4000);
  });

  it('aggregates each dependency’s files and bytes, largest first', () => {
    expect(summarizeAsarEntries(entries).packages).toEqual([
      { name: 'devicon', bytes: 70768 + 201, files: 2 },
      { name: '@types/node', bytes: 691, files: 1 },
    ]);
  });
});

describe('matchesPackagePattern', () => {
  it('matches an exact package name', () => {
    expect(matchesPackagePattern('esbuild', 'esbuild')).toBe(true);
  });

  it('does not match a package that merely starts with the pattern', () => {
    // `esbuild-register` is a different package from `esbuild`.
    expect(matchesPackagePattern('esbuild-register', 'esbuild')).toBe(false);
  });

  it('matches every package in a scope when the pattern ends in /*', () => {
    expect(matchesPackagePattern('@types/node', '@types/*')).toBe(true);
    expect(matchesPackagePattern('@types/readable-stream', '@types/*')).toBe(true);
  });

  it('does not let a scope wildcard escape its scope', () => {
    expect(matchesPackagePattern('@typespec/ts-http-runtime', '@types/*')).toBe(false);
  });
});

describe('findNeverShipPackages', () => {
  it('finds nothing in an archive that carries only runtime dependencies', () => {
    expect(
      findNeverShipPackages([
        { name: 'pg', bytes: 100_000, files: 19 },
        { name: 'mssql', bytes: 160_000, files: 32 },
      ])
    ).toEqual([]);
  });

  it('reports a build-time package that reappeared, with its size and the reason it is banned', () => {
    const findings = findNeverShipPackages([
      { name: 'pg', bytes: 100_000, files: 19 },
      { name: 'vitest', bytes: 3_000_000, files: 400 },
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0].name).toBe('vitest');
    expect(findings[0].bytes).toBe(3_000_000);
    expect(findings[0].files).toBe(400);
    expect(findings[0].reason).not.toBe('');
  });

  it('reports every package a scope wildcard catches, not just the first', () => {
    const findings = findNeverShipPackages([
      { name: '@types/node', bytes: 1832, files: 2 },
      { name: '@types/readable-stream', bytes: 1781, files: 2 },
    ]);

    expect(findings.map(finding => finding.name)).toEqual([
      '@types/node',
      '@types/readable-stream',
    ]);
  });

  it('reports the 121 MB devicon leftover, the offender this guard was written for', () => {
    const findings = findNeverShipPackages([{ name: 'devicon', bytes: 121_323_509, files: 2082 }]);
    expect(findings.map(finding => finding.name)).toEqual(['devicon']);
  });
});

describe('exclusionGlobFor', () => {
  it('turns an exact name into the electron-builder exclusion for that package', () => {
    expect(exclusionGlobFor('devicon')).toBe('!**/node_modules/devicon/**');
  });

  it('turns a scope wildcard into the exclusion for the whole scope', () => {
    expect(exclusionGlobFor('@types/*')).toBe('!**/node_modules/@types/**');
  });
});

describe('electron-builder.yml', () => {
  const config = readFileSync(join(REPO_ROOT, 'electron-builder.yml'), 'utf8');

  it('excludes every banned package that electron-builder would otherwise collect', () => {
    // The `excluded-by-config` rules are the ones reachable from `dependencies`: electron-builder
    // collects the production dependency tree, so nothing but an explicit exclusion keeps them
    // out. Deleting one of those lines is the regression this assertion exists to catch, and it
    // catches it in the unit tier rather than at the next package build.
    expect(missingExclusions(config)).toEqual([]);
  });

  it('leaves the build-time toolchain to the archive check, with no dead exclusions for it', () => {
    // Measured for J-90: electron-builder never collects a devDependency, so an exclusion naming
    // one filters a file set it was never in. Asserting their ABSENCE keeps the config honest —
    // a line that cannot do anything reads as though it were what keeps the package out.
    const absentFromTree = NEVER_SHIP.filter(
      rule => rule.group === 'absent-from-production-tree'
    ).map(rule => exclusionGlobFor(rule.pattern));

    expect(absentFromTree.length).toBeGreaterThan(0);
    expect(absentFromTree.filter(glob => config.includes(glob))).toEqual([]);
  });
});
