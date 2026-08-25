/**
 * Query keys for every request/response member of the bridge — one factory per preload
 * namespace, so cache reads and invalidations agree on a spelling instead of each call
 * site inventing an array literal.
 *
 * Keys are `[namespace, operation, ...args]`. TanStack Query matches key prefixes, which
 * gives three useful scopes for free:
 *
 *   invalidateQueries({ queryKey: ipcKeys.explorer.all })                       // namespace
 *   invalidateQueries({ queryKey: ipcKeys.explorer.key('getChildren') })        // operation
 *   invalidateQueries({ queryKey: ipcKeys.explorer.key('getChildren', id, db)}) // one call
 */

import type { IpcNamespace, IpcOperation } from './surface';

/** `readonly` to match TanStack's own `QueryKey`, which forbids mutating a live key. */
export type IpcQueryKey = readonly unknown[];

export interface IpcKeyFactory<N extends IpcNamespace> {
  /** The whole namespace — the invalidation scope for "something here changed". */
  readonly all: readonly [N];
  /**
   * One operation, optionally narrowed by the arguments it was called with.
   *
   * The operation name is checked against the preload interface; the arguments are not.
   * Typing them as that member's `Parameters<…>` was considered and rejected: partial
   * argument lists are the common case (keying an explorer node on `connectionId` alone so
   * one reconnect invalidates every database under it), and some real arguments must never
   * enter a cache key at all — `connection.test` takes three passwords (PLAN.md §7.1).
   * Callers choose what identifies the result; the tuple's first two members keep it
   * namespaced.
   */
  key(operation: IpcOperation<N>, ...args: readonly unknown[]): IpcQueryKey;
}

function keyFactory<N extends IpcNamespace>(namespace: N): IpcKeyFactory<N> {
  return {
    all: [namespace] as const,
    key: (operation, ...args) => [namespace, operation, ...args],
  };
}

/**
 * Every namespace on the bridge. The `Record`-over-`IpcNamespace` annotation is the point:
 * a namespace added to `JoineryAPI` and not added here is a compile error, so this object
 * cannot drift out of date the way a hand-maintained list would.
 *
 * `menu` is included for that exhaustiveness and is deliberately inert — all 31 of its
 * members are `on*` commands, so `IpcOperation<'menu'>` is `never` and `ipcKeys.menu.key()`
 * will not typecheck with any argument. Use `useIpcEvent` for those. `theme` is the mixed
 * case: `getNative` is keyable, `onChanged` is not.
 */
export const ipcKeys: { readonly [N in IpcNamespace]: IpcKeyFactory<N> } = {
  ai: keyFactory('ai'),
  app: keyFactory('app'),
  backup: keyFactory('backup'),
  chat: keyFactory('chat'),
  connection: keyFactory('connection'),
  credentials: keyFactory('credentials'),
  database: keyFactory('database'),
  docker: keyFactory('docker'),
  explorer: keyFactory('explorer'),
  logs: keyFactory('logs'),
  menu: keyFactory('menu'),
  python: keyFactory('python'),
  query: keyFactory('query'),
  queryResults: keyFactory('queryResults'),
  restore: keyFactory('restore'),
  serverFs: keyFactory('serverFs'),
  theme: keyFactory('theme'),
  workspace: keyFactory('workspace'),
};
