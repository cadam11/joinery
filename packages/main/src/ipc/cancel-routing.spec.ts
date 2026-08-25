/**
 * J-48e / J-51g: a Cancel that stopped the readout and left the dump running.
 *
 * `BACKUP.CANCEL` and `RESTORE.CANCEL` carry an operation id and nothing else — no connection, so
 * no engine — and both handlers called the MSSQL service unconditionally. That service does not
 * hold the PostgreSQL or MySQL operation ids, so cancelling one of those marked nothing, killed
 * nothing, and reported success: `pg_dump` ran to completion while the dialog said it had stopped.
 */

import { describe, expect, it, vi } from 'vitest';

import { cancelOperation } from './backup.ipc';

type Services = Parameters<typeof cancelOperation>[0];

/** Each fake owns exactly the ids it was given, which is what the real services report. */
function services(owned: { mssql?: string[]; pg?: string[]; mysql?: string[] }) {
  const pg = { cancel: vi.fn((id: string) => (owned.pg ?? []).includes(id)) };
  const mysql = { cancel: vi.fn((id: string) => (owned.mysql ?? []).includes(id)) };
  const mssql = {
    cancel: vi.fn(async (id: string) => (owned.mssql ?? []).includes(id)),
  };
  return { fakes: { pg, mysql, mssql }, asServices: { pg, mysql, mssql } as unknown as Services };
}

describe('routing a cancel to the engine that owns the operation', () => {
  it('reaches the PostgreSQL service, which the old routing never did', async () => {
    const { fakes, asServices } = services({ pg: ['op-pg'] });
    await cancelOperation(asServices, 'op-pg');

    expect(fakes.pg.cancel).toHaveBeenCalledExactlyOnceWith('op-pg');
    // Stops at the owner: the MSSQL service was the only one ever asked before.
    expect(fakes.mssql.cancel).not.toHaveBeenCalled();
  });

  it('reaches the MySQL service', async () => {
    const { fakes, asServices } = services({ mysql: ['op-my'] });
    await cancelOperation(asServices, 'op-my');

    expect(fakes.mysql.cancel).toHaveBeenCalledExactlyOnceWith('op-my');
    expect(fakes.mssql.cancel).not.toHaveBeenCalled();
  });

  it('still reaches the MSSQL service for an id it owns', async () => {
    const { fakes, asServices } = services({ mssql: ['op-ms'] });
    await cancelOperation(asServices, 'op-ms');

    expect(fakes.pg.cancel).toHaveBeenCalledExactlyOnceWith('op-ms');
    expect(fakes.mysql.cancel).toHaveBeenCalledExactlyOnceWith('op-ms');
    expect(fakes.mssql.cancel).toHaveBeenCalledExactlyOnceWith('op-ms');
  });

  it('asks every engine before giving up on an id nobody owns', async () => {
    const { fakes, asServices } = services({});
    await expect(cancelOperation(asServices, 'op-ghost')).resolves.toBeUndefined();

    expect(fakes.pg.cancel).toHaveBeenCalledExactlyOnceWith('op-ghost');
    expect(fakes.mysql.cancel).toHaveBeenCalledExactlyOnceWith('op-ghost');
    expect(fakes.mssql.cancel).toHaveBeenCalledExactlyOnceWith('op-ghost');
  });

  it('never cancels two engines for one id', async () => {
    // Ids are uuids, so a collision is not expected — but "stop at the owner" is the property that
    // makes asking all three safe, and it should be pinned rather than assumed.
    const { fakes, asServices } = services({ pg: ['op-1'], mysql: ['op-1'], mssql: ['op-1'] });
    await cancelOperation(asServices, 'op-1');

    expect(fakes.pg.cancel).toHaveBeenCalledOnce();
    expect(fakes.mysql.cancel).not.toHaveBeenCalled();
    expect(fakes.mssql.cancel).not.toHaveBeenCalled();
  });
});
