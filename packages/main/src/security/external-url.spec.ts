/**
 * The allowlist that stands between `window.joinery.app.openExternal(...)` and
 * `shell.openExternal`.
 *
 * `shell.openExternal` hands the string to the OS URL handler, so its blast radius is every
 * scheme the host has registered — `file:` opens Finder, and on macOS a registered custom
 * scheme can launch an arbitrary application with an attacker-chosen argument. Before J-22 the
 * IPC handler passed the renderer's string straight through, which made the whole surface
 * reachable from any script that reached the renderer (a model-authored markdown link, or an
 * injected one). These cases are the contract.
 */

import { describe, expect, it } from 'vitest';

import {
  assertOpenableExternalUrl,
  isOpenableExternalUrl,
  UnsafeExternalUrlError,
} from './external-url';

describe('isOpenableExternalUrl', () => {
  it.each([
    'https://usejoinery.com/',
    'https://usejoinery.com/docs/getting-started?a=1#b',
    'http://localhost:4200/',
    'mailto:someone@example.com',
    'mailto:someone@example.com?subject=hi',
    // Scheme comparison is case-insensitive because the URL parser lower-cases it.
    'HTTPS://usejoinery.com/',
  ])('accepts %s', candidate => {
    expect(isOpenableExternalUrl(candidate)).toBe(true);
  });

  it.each([
    // The classic script sinks.
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'vbscript:msgbox(1)',
    'data:text/html,<script>alert(1)</script>',
    // The URL parser strips tabs and newlines, so an obfuscated scheme still resolves to the
    // dangerous one rather than to something that fails to parse.
    'java\nscript:alert(1)',
    'java\tscript:alert(1)',
    // Leading whitespace is also stripped by the parser.
    '   javascript:alert(1)',
    // Local resources: `file:` reveals the filesystem through Finder, and the app's own asar.
    'file:///etc/passwd',
    'file:///Applications/Joinery.app/Contents/Resources/app.asar',
    // Custom / OS-registered schemes are how openExternal launches another application.
    'ms-msdt:/id PCWDiagnostic',
    'smb://attacker.example/share',
    'ssh://root@example.com',
    'about:blank',
    'chrome://settings',
    'devtools://devtools/bundled/inspector.html',
    // Not URLs at all.
    '',
    '   ',
    'not a url',
    '//usejoinery.com',
    '/etc/passwd',
  ])('rejects %j', candidate => {
    expect(isOpenableExternalUrl(candidate)).toBe(false);
  });

  it('rejects non-string input, because the renderer supplies it over IPC', () => {
    for (const candidate of [undefined, null, 42, {}, ['https://usejoinery.com/']]) {
      expect(isOpenableExternalUrl(candidate as unknown as string)).toBe(false);
    }
  });
});

describe('assertOpenableExternalUrl', () => {
  it('returns the parsed URL for an allowed scheme', () => {
    const url = assertOpenableExternalUrl('https://usejoinery.com/docs');
    expect(url.protocol).toBe('https:');
    expect(url.host).toBe('usejoinery.com');
  });

  it('throws UnsafeExternalUrlError naming the rejected scheme', () => {
    expect(() => assertOpenableExternalUrl('javascript:alert(1)')).toThrow(UnsafeExternalUrlError);

    try {
      assertOpenableExternalUrl('javascript:alert(1)');
      expect.unreachable('expected a throw');
    } catch (error) {
      expect(error).toBeInstanceOf(UnsafeExternalUrlError);
      const unsafe = error as UnsafeExternalUrlError;
      expect(unsafe.scheme).toBe('javascript:');
      expect(unsafe.message).toContain('javascript:');
      expect(unsafe.message).toContain('https:');
    }
  });

  it('throws for an unparseable candidate without inventing a scheme', () => {
    try {
      assertOpenableExternalUrl('not a url');
      expect.unreachable('expected a throw');
    } catch (error) {
      expect(error).toBeInstanceOf(UnsafeExternalUrlError);
      expect((error as UnsafeExternalUrlError).scheme).toBeUndefined();
    }
  });

  it('never puts the rejected URL itself in the message, only its scheme', () => {
    // A rejected URL can carry a credential or a token in its path or query, and this message
    // reaches the log ring buffer AND the renderer's Output panel.
    const secretive = 'ftp://user:hunter2@internal.example/private/dump.sql?token=abc123';
    try {
      assertOpenableExternalUrl(secretive);
      expect.unreachable('expected a throw');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('ftp:');
      expect(message).not.toContain('hunter2');
      expect(message).not.toContain('internal.example');
      expect(message).not.toContain('abc123');
    }
  });
});
