import { describe, expect, it } from 'vitest';
import { ipcKeys } from './keys';
import type { IpcNamespace } from './surface';

// The 17 namespaces `JoineryAPI` declares. Written out rather than derived from `ipcKeys`
// so the test is an independent statement of the surface: if preload gains a namespace,
// `keys.ts` fails to compile (the Record annotation) *and* this length assertion fails.
const EXPECTED_NAMESPACES: readonly IpcNamespace[] = [
  'ai',
  'app',
  'backup',
  'chat',
  'connection',
  'credentials',
  'database',
  'docker',
  'explorer',
  'logs',
  'menu',
  'python',
  'query',
  'queryResults',
  'restore',
  'serverFs',
  'theme',
  'workspace',
];

describe('ipcKeys', () => {
  it('covers every preload namespace exactly once', () => {
    expect(Object.keys(ipcKeys).sort()).toEqual([...EXPECTED_NAMESPACES].sort());
  });

  it('scopes a namespace to a single-element key', () => {
    expect(ipcKeys.explorer.all).toEqual(['explorer']);
    expect(ipcKeys.queryResults.all).toEqual(['queryResults']);
  });

  it('builds [namespace, operation] for an un-parameterised call', () => {
    expect(ipcKeys.connection.key('list')).toEqual(['connection', 'list']);
    expect(ipcKeys.app.key('getVersion')).toEqual(['app', 'getVersion']);
  });

  it('appends arguments in order after the operation', () => {
    expect(ipcKeys.explorer.key('getChildren', 'conn-1', 'AdventureWorks', 'dbo/Tables')).toEqual([
      'explorer',
      'getChildren',
      'conn-1',
      'AdventureWorks',
      'dbo/Tables',
    ]);
  });

  it('nests operation keys under the namespace key so prefix invalidation works', () => {
    // TanStack Query matches on key prefixes; these three are the namespace, operation and
    // single-call scopes, and each must be a prefix of the next.
    const namespaceScope = ipcKeys.backup.all;
    const operationScope = ipcKeys.backup.key('getHistory');
    const callScope = ipcKeys.backup.key('getHistory', 'conn-1', 'AdventureWorks');

    expect(operationScope.slice(0, namespaceScope.length)).toEqual([...namespaceScope]);
    expect(callScope.slice(0, operationScope.length)).toEqual([...operationScope]);
  });

  it('keeps distinct arguments in distinct cache slots', () => {
    expect(ipcKeys.database.key('getInfo', 'conn-1', 'a')).not.toEqual(
      ipcKeys.database.key('getInfo', 'conn-1', 'b')
    );
  });

  it('produces a fresh array per call, so a consumer cannot mutate a shared key', () => {
    expect(ipcKeys.logs.key('getRecent')).not.toBe(ipcKeys.logs.key('getRecent'));
  });

  it('rejects operations the namespace does not declare', () => {
    // @ts-expect-error `getKids` is not a member of JoineryAPI['explorer']
    ipcKeys.explorer.key('getKids');

    // @ts-expect-error `getHistory` belongs to `backup` and `query`, not to `docker`
    ipcKeys.docker.key('getHistory');

    // @ts-expect-error `onProgress` is an event subscription, not a keyable operation
    ipcKeys.backup.key('onProgress');

    // @ts-expect-error every `menu` member is an event, so the namespace has no operations
    ipcKeys.menu.key('onNewQuery');

    // The runtime assertion is not the point of this test — the four directives above are,
    // and an unused `@ts-expect-error` is itself a compile error.
    expect(ipcKeys.menu.all).toEqual(['menu']);
  });
});
