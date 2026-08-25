/**
 * One claim per destination, so two runs cannot corrupt each other's output (J-48f / J-51g).
 *
 * `pg-backup.ts` minted a fresh uuid per `startBackup` and registered it with no check on where the
 * dump was going. Two starts against the same path spawned two `pg_dump` processes writing one
 * file: the archive is corrupt and **both operations report success**. The same shape held for
 * MySQL, for MSSQL, and for restores into one target database, where two `pg_restore --clean` runs
 * drop objects the other is still writing.
 *
 * The renderer grew a module-level in-flight record as a partial mitigation, but it is per window:
 * it does not survive a reload and does not cover any other caller of `backup.start`. This is the
 * authoritative one.
 *
 * ── Why release lives where it does ──────────────────────────────────────────────────────────
 *
 * A leaked claim is worse than the bug it prevents: it locks a database out of backups for the rest
 * of the session, with no way back short of a restart. So release is wired to each service's single
 * terminal funnel — `sendComplete` in the two CLI services, `stopOperation` in the MSSQL one —
 * rather than to each of the eight, twelve and three call sites that reach them, and
 * `releaseAll` runs at shutdown.
 */

import { BaseSingleton } from '../../utils/singleton';

/** Thrown by `claim`. `safeHandle` serialises the message to the renderer, so it reads as prose. */
export class OperationInFlightError extends Error {
  constructor(what: string) {
    super(`${what} is already running. Wait for it to finish, or cancel it first.`);
    this.name = 'OperationInFlightError';
  }
}

/** The destination a backup writes. Two dumps to one path is the corrupting case. */
export function backupDestinationKey(backupPath: string): string {
  return `backup:${backupPath.trim()}`;
}

/** The database a restore writes into, per connection. */
export function restoreTargetKey(connectionId: string, targetDatabase: string): string {
  return `restore:${connectionId}:${targetDatabase.trim()}`;
}

export class OperationClaims extends BaseSingleton {
  /** key → operation id holding it. */
  private readonly holders = new Map<string, string>();
  /** operation id → the key it holds, so release needs only the id the IPC layer knows. */
  private readonly keys = new Map<string, string>();

  /**
   * Take `key` for `operationId`, or throw if someone already holds it.
   *
   * `describe` names the thing in the refusal a user reads — "a backup of sales" rather than a key.
   */
  claim(key: string, operationId: string, describe: string): void {
    if (operationId === '') throw new Error('a claim needs an operation id');

    const holder = this.holders.get(key);
    if (holder !== undefined) throw new OperationInFlightError(describe);

    this.holders.set(key, operationId);
    this.keys.set(operationId, key);
  }

  /** Release whatever `operationId` holds. A no-op for an id that holds nothing. */
  release(operationId: string): void {
    const key = this.keys.get(operationId);
    if (key === undefined) return;

    this.keys.delete(operationId);
    // Only if it is still ours: a claim retaken after a release cannot be dropped by the old owner.
    if (this.holders.get(key) === operationId) this.holders.delete(key);
  }

  /** Drop every claim. Shutdown only — the processes holding them are being stopped too. */
  releaseAll(): void {
    this.holders.clear();
    this.keys.clear();
  }

  /** The operation holding `key`, if any. Exposed for tests and diagnostics. */
  heldBy(key: string): string | undefined {
    return this.holders.get(key);
  }
}
