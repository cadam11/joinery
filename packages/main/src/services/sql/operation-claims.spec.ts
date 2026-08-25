/**
 * J-48f / J-51g: nothing in main refused a second run against the same destination.
 *
 * Two `pg_dump` processes writing one file produce a corrupt archive and **both report success**.
 * The renderer's in-flight record was a per-window mitigation; it does not survive a reload and
 * does not cover any other caller of `backup.start`.
 *
 * The tests below spend as much attention on release as on claim, because a leaked claim is the
 * worse failure: it locks a database out of backups for the rest of the session.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  backupDestinationKey,
  OperationClaims,
  OperationInFlightError,
  restoreTargetKey,
} from './operation-claims';

let claims: OperationClaims;

beforeEach(() => {
  claims = new OperationClaims();
});

describe('claiming a destination', () => {
  it('lets the first operation through', () => {
    const key = backupDestinationKey('/backups/sales.dump');
    claims.claim(key, 'op-1', 'a backup of sales');
    expect(claims.heldBy(key)).toBe('op-1');
  });

  it('refuses a second run against the same destination — the corrupting case', () => {
    const key = backupDestinationKey('/backups/sales.dump');
    claims.claim(key, 'op-1', 'a backup of sales');

    expect(() => claims.claim(key, 'op-2', 'a backup of sales')).toThrow(OperationInFlightError);
    expect(claims.heldBy(key)).toBe('op-1');
  });

  it('names the thing in the refusal, since the message reaches the user', () => {
    const key = backupDestinationKey('/backups/sales.dump');
    claims.claim(key, 'op-1', 'a backup of sales');

    expect(() => claims.claim(key, 'op-2', 'a backup of sales')).toThrow(
      /a backup of sales is already running/
    );
  });

  it('allows a different destination at the same time', () => {
    claims.claim(backupDestinationKey('/backups/a.dump'), 'op-1', 'a backup of a');
    expect(() =>
      claims.claim(backupDestinationKey('/backups/b.dump'), 'op-2', 'a backup of b')
    ).not.toThrow();
  });

  it('separates a restore target from a backup destination', () => {
    claims.claim(backupDestinationKey('/backups/sales.dump'), 'op-1', 'a backup');
    expect(() =>
      claims.claim(restoreTargetKey('conn-1', 'sales'), 'op-2', 'a restore into sales')
    ).not.toThrow();
  });

  it('separates the same database name on two different connections', () => {
    claims.claim(restoreTargetKey('conn-1', 'sales'), 'op-1', 'a restore into sales');
    expect(() =>
      claims.claim(restoreTargetKey('conn-2', 'sales'), 'op-2', 'a restore into sales')
    ).not.toThrow();
  });

  it('refuses an empty operation id rather than storing an unreleasable claim', () => {
    expect(() => claims.claim(backupDestinationKey('/a'), '', 'a backup')).toThrow(/operation id/);
  });
});

describe('releasing it', () => {
  it('frees the destination for the next run', () => {
    const key = backupDestinationKey('/backups/sales.dump');
    claims.claim(key, 'op-1', 'a backup of sales');
    claims.release('op-1');

    expect(claims.heldBy(key)).toBeUndefined();
    expect(() => claims.claim(key, 'op-2', 'a backup of sales')).not.toThrow();
  });

  it('is a no-op for an operation that holds nothing, so a double release cannot free somebody else', () => {
    const key = backupDestinationKey('/backups/sales.dump');
    claims.claim(key, 'op-1', 'a backup of sales');

    claims.release('op-1');
    claims.claim(key, 'op-2', 'a backup of sales');
    claims.release('op-1'); // the late second release of a finished operation

    expect(claims.heldBy(key)).toBe('op-2');
  });

  it('does nothing for an id nobody has ever seen', () => {
    expect(() => claims.release('op-ghost')).not.toThrow();
  });

  it('drops everything at shutdown', () => {
    claims.claim(backupDestinationKey('/a'), 'op-1', 'a backup');
    claims.claim(restoreTargetKey('conn-1', 'sales'), 'op-2', 'a restore');

    claims.releaseAll();

    expect(claims.heldBy(backupDestinationKey('/a'))).toBeUndefined();
    expect(claims.heldBy(restoreTargetKey('conn-1', 'sales'))).toBeUndefined();
  });
});
