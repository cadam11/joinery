/**
 * Tests for the bind-placeholder helper the dialects build their metadata queries with (J-135).
 */

import { describe, it, expect } from 'vitest';
import { BoundValues, unboundQuery, placeholderFor } from './parameterised-query';

describe('placeholderFor', () => {
  it('spells the nth placeholder the way each engine reads it', () => {
    expect(placeholderFor('dollar', 1)).toBe('$1');
    expect(placeholderFor('dollar', 12)).toBe('$12');
    // MySQL's placeholders are positional, so every one is the same character.
    expect(placeholderFor('question', 1)).toBe('?');
    expect(placeholderFor('question', 12)).toBe('?');
    // ConnectionPoolManager.queryWithParams names its inputs p0, p1, … from zero.
    expect(placeholderFor('at', 1)).toBe('@p0');
    expect(placeholderFor('at', 12)).toBe('@p11');
  });

  it('rejects an ordinal below one', () => {
    expect(() => placeholderFor('dollar', 0)).toThrow(/1-based/);
  });
});

describe('BoundValues', () => {
  it('returns a placeholder per bind and accumulates the values in order', () => {
    const values = new BoundValues('dollar');
    const a = values.bind('alpha');
    const b = values.bind('beta');

    expect([a, b]).toEqual(['$1', '$2']);
    expect(values.query(`SELECT ${a}, ${b}`)).toEqual({
      sql: 'SELECT $1, $2',
      params: ['alpha', 'beta'],
    });
  });

  it('binds a repeated value once per occurrence, not once per value', () => {
    // The rule the dialects follow: one `bind()` call per placeholder. MySQL's `?` is positional
    // and consumes the next parameter, so reusing a placeholder would silently shift every
    // later value along by one.
    const values = new BoundValues('question');
    const first = values.bind('same');
    const second = values.bind('same');

    expect([first, second]).toEqual(['?', '?']);
    expect(values.query('WHERE a = ? AND b = ?').params).toEqual(['same', 'same']);
  });

  it('gives each query a copy of the values, so a later bind cannot mutate it', () => {
    const values = new BoundValues('dollar');
    values.bind('one');
    const snapshot = values.query('SELECT $1');
    values.bind('two');

    expect(snapshot.params).toEqual(['one']);
  });

  it('rejects a non-string value', () => {
    // Every bound value on this surface is a schema, table or object name. A number here means a
    // caller passed the wrong argument, and coercing it would hide that.
    const values = new BoundValues('dollar');
    expect(() => values.bind(7 as unknown as string)).toThrow(/must be a string/);
  });
});

describe('unboundQuery', () => {
  it('carries SQL with no parameters', () => {
    expect(unboundQuery('SELECT 1')).toEqual({ sql: 'SELECT 1', params: [] });
  });
});
