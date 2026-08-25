/**
 * The shape of a progress event, per channel (J-51a).
 *
 * `BackupProgress` keys its event `backupId` and `RestoreProgress` keys its `restoreId`. The
 * PostgreSQL and MySQL services built ONE object carrying `backupId`, sent it down both channels,
 * and cast it `as BackupProgress | RestoreProgress` — which compiles, because the `BackupProgress`
 * arm is satisfied. So every restore event those engines emitted was missing the one field a
 * renderer trusting the declared type would key on: a restore on PostgreSQL or MySQL spun forever
 * while the restore itself had already finished.
 *
 * Pure on purpose. The `webContents.send` fan-out stays at the call site in each service, where
 * the I/O is visible; this only decides what is being sent.
 */

import type { BackupProgress, RestoreProgress } from '@joinery/shared';

/** The fields both event shapes share — everything except which id key names the operation. */
export interface OperationProgressFields {
  readonly status: BackupProgress['status'];
  readonly percentComplete: number;
  readonly currentPhase?: string;
  readonly error?: string;
}

/**
 * Build the event for `kind`, keyed the way that channel's consumer reads it.
 *
 * `operationId` is populated on both shapes as the engine-agnostic alias, so a reader that prefers
 * it keeps working; the keyed field is what makes the event valid for its own channel.
 */
export function operationProgressEvent(
  kind: 'backup' | 'restore',
  operationId: string,
  fields: OperationProgressFields
): BackupProgress | RestoreProgress {
  if (operationId === '') throw new Error('a progress event needs an operation id');

  return kind === 'restore'
    ? { restoreId: operationId, operationId, ...fields }
    : { backupId: operationId, operationId, ...fields };
}
