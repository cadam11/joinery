import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { parseArgs, updateCaskSource } from './update-cask';

/**
 * The real template, not a hand-written imitation. Every prior "green but broken" incident in
 * this repo came from a test double that encoded the bug under test; a rewriter whose only
 * fixture is a fixture cannot tell you it still matches the file it will actually rewrite.
 */
const TEMPLATE_PATH = fileURLToPath(new URL('../../Casks/joinery.rb', import.meta.url));
const TEMPLATE = readFileSync(TEMPLATE_PATH, 'utf8');

const ARM = 'a'.repeat(64);
const X64 = 'b'.repeat(64);

describe('updateCaskSource', () => {
  it('stamps the version and both checksums into the real template', () => {
    const out = updateCaskSource(TEMPLATE, {
      version: '1.2.3',
      sha256Arm64: ARM,
      sha256X64: X64,
    });

    expect(out).toContain('version "1.2.3"');
    expect(out).toContain(`sha256 arm:   "${ARM}"`);
    expect(out).toContain(`intel: "${X64}"`);
    expect(out).not.toContain('0000000000000000000000000000000000000000000000000000000000000000');
    expect(out).not.toContain('version "0.0.0"');
  });

  it('changes only the three lines it claims to change', () => {
    const out = updateCaskSource(TEMPLATE, {
      version: '1.2.3',
      sha256Arm64: ARM,
      sha256X64: X64,
    });

    const before = TEMPLATE.split('\n');
    const after = out.split('\n');
    expect(after).toHaveLength(before.length);

    const changed = before
      .map((line, i) => (line === after[i] ? null : i))
      .filter((i): i is number => i !== null);
    expect(changed).toHaveLength(3);
  });

  it('leaves the download URL template intact, because Homebrew interpolates it', () => {
    const out = updateCaskSource(TEMPLATE, {
      version: '1.2.3',
      sha256Arm64: ARM,
      sha256X64: X64,
    });

    expect(out).toContain(
      'https://github.com/cadam11/joinery/releases/download/v#{version}/Joinery-#{version}-#{arch}.dmg'
    );
  });

  it('is idempotent — rewriting an already-stamped cask with the same inputs is a no-op', () => {
    const once = updateCaskSource(TEMPLATE, {
      version: '1.2.3',
      sha256Arm64: ARM,
      sha256X64: X64,
    });
    const twice = updateCaskSource(once, { version: '1.2.3', sha256Arm64: ARM, sha256X64: X64 });

    expect(twice).toBe(once);
  });

  it('rewrites a cask that already carries a real version', () => {
    const stamped = updateCaskSource(TEMPLATE, {
      version: '1.2.3',
      sha256Arm64: ARM,
      sha256X64: X64,
    });
    const out = updateCaskSource(stamped, {
      version: '1.2.4',
      sha256Arm64: X64,
      sha256X64: ARM,
    });

    expect(out).toContain('version "1.2.4"');
    expect(out).toContain(`sha256 arm:   "${X64}"`);
    expect(out).toContain(`intel: "${ARM}"`);
  });

  it.each([
    ['not a version', 'v1.2.3'],
    ['empty', ''],
    ['two components', '1.2'],
    ['a shell injection attempt', '1.2.3"; system("rm -rf /"); "'],
  ])('rejects %s as a version', (_label, version) => {
    expect(() => updateCaskSource(TEMPLATE, { version, sha256Arm64: ARM, sha256X64: X64 })).toThrow(
      /version/i
    );
  });

  it('accepts a prerelease version', () => {
    const out = updateCaskSource(TEMPLATE, {
      version: '1.0.0-rc.1',
      sha256Arm64: ARM,
      sha256X64: X64,
    });
    expect(out).toContain('version "1.0.0-rc.1"');
  });

  it.each([
    ['too short', 'a'.repeat(63)],
    ['too long', 'a'.repeat(65)],
    ['uppercase', 'A'.repeat(64)],
    ['non-hex', 'g'.repeat(64)],
    ['empty', ''],
  ])('rejects %s as an arm64 checksum', (_label, sha) => {
    expect(() =>
      updateCaskSource(TEMPLATE, { version: '1.2.3', sha256Arm64: sha, sha256X64: X64 })
    ).toThrow(/sha256Arm64/);
  });

  it('rejects a bad x64 checksum by name', () => {
    expect(() =>
      updateCaskSource(TEMPLATE, { version: '1.2.3', sha256Arm64: ARM, sha256X64: 'nope' })
    ).toThrow(/sha256X64/);
  });

  it('refuses a cask with no version stanza rather than silently returning it unchanged', () => {
    const mangled = TEMPLATE.replace('  version "0.0.0"\n', '');
    expect(() =>
      updateCaskSource(mangled, { version: '1.2.3', sha256Arm64: ARM, sha256X64: X64 })
    ).toThrow(/version stanza/);
  });

  it('refuses a cask with no arm checksum stanza', () => {
    const mangled = TEMPLATE.replace(/^ {2}sha256 arm:.*$/m, '  sha256 :no_check');
    expect(() =>
      updateCaskSource(mangled, { version: '1.2.3', sha256Arm64: ARM, sha256X64: X64 })
    ).toThrow(/arm64 sha256 stanza/);
  });

  it('refuses a cask with no intel checksum stanza', () => {
    const mangled = TEMPLATE.replace(/^ {9}intel: .*$/m, '         intel: :no_check');
    expect(() =>
      updateCaskSource(mangled, { version: '1.2.3', sha256Arm64: ARM, sha256X64: X64 })
    ).toThrow(/x64 sha256 stanza/);
  });

  it('refuses a cask with two version stanzas rather than guessing which one is the cask', () => {
    const mangled = TEMPLATE.replace(
      '  version "0.0.0"\n',
      '  version "0.0.0"\n  version "0.0.0"\n'
    );
    expect(() =>
      updateCaskSource(mangled, { version: '1.2.3', sha256Arm64: ARM, sha256X64: X64 })
    ).toThrow(/version stanza/);
  });
});

describe('parseArgs', () => {
  const argv = [
    '--cask',
    'tap/Casks/joinery.rb',
    '--version',
    '1.2.3',
    '--sha256-arm64',
    ARM,
    '--sha256-x64',
    X64,
  ];

  it('reads all four flags', () => {
    expect(parseArgs(argv)).toEqual({
      cask: 'tap/Casks/joinery.rb',
      version: '1.2.3',
      sha256Arm64: ARM,
      sha256X64: X64,
    });
  });

  it('does not care about flag order', () => {
    const shuffled = [...argv.slice(6), ...argv.slice(0, 6)];
    expect(parseArgs(shuffled)).toEqual(parseArgs(argv));
  });

  it.each(['--cask', '--version', '--sha256-arm64', '--sha256-x64'])(
    'names %s when it is missing',
    flag => {
      const i = argv.indexOf(flag);
      const without = [...argv.slice(0, i), ...argv.slice(i + 2)];
      expect(() => parseArgs(without)).toThrow(flag);
    }
  );

  it('rejects an unknown flag rather than ignoring a typo', () => {
    expect(() => parseArgs([...argv, '--sha256-arm', ARM])).toThrow(/--sha256-arm\b/);
  });

  it('rejects a flag with no value', () => {
    expect(() => parseArgs([...argv, '--cask'])).toThrow(/--cask/);
  });
});
