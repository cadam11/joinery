/**
 * J-51a: the restore channel used to carry `backupId` and no `restoreId`.
 *
 * `pg-backup.ts` and `mysql-backup.ts` each built one event object for both channels and cast it
 * to the union. The cast compiled because the `BackupProgress` arm was satisfied, so the type
 * system never noticed that two of the three engines emitted restore events missing the field
 * `RestoreProgress` declares as required.
 */

import { describe, expect, it } from 'vitest';

import { operationProgressEvent } from './operation-progress';

const FIELDS = { status: 'running' as const, percentComplete: -1, currentPhase: 'Dumping' };

describe('operationProgressEvent', () => {
  it('keys a restore event with restoreId, which PG and MySQL never sent', () => {
    const event = operationProgressEvent('restore', 'op-1', FIELDS);
    expect(event).toMatchObject({ restoreId: 'op-1', operationId: 'op-1' });
    expect('backupId' in event).toBe(false);
  });

  it('keys a backup event with backupId', () => {
    const event = operationProgressEvent('backup', 'op-1', FIELDS);
    expect(event).toMatchObject({ backupId: 'op-1', operationId: 'op-1' });
    expect('restoreId' in event).toBe(false);
  });

  it('carries operationId on both, so a reader preferring the alias still works', () => {
    for (const kind of ['backup', 'restore'] as const) {
      expect(operationProgressEvent(kind, 'op-1', FIELDS).operationId).toBe('op-1');
    }
  });

  it('carries the shared fields through unchanged', () => {
    expect(
      operationProgressEvent('restore', 'op-1', {
        status: 'failed',
        percentComplete: 0,
        currentPhase: 'Failed',
        error: 'pg_restore: connection refused',
      })
    ).toMatchObject({
      status: 'failed',
      percentComplete: 0,
      currentPhase: 'Failed',
      error: 'pg_restore: connection refused',
    });
  });

  it('refuses an empty operation id rather than emitting an unroutable event', () => {
    expect(() => operationProgressEvent('restore', '', FIELDS)).toThrow(/operation id/);
  });
});
