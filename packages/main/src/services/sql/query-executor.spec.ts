import { describe, it, expect, afterAll } from 'vitest';

/**
 * Tests for Query Executor
 *
 * Tests the utility/parsing methods that don't require a live DB connection.
 * Full integration tests would require a running SQL Server / PostgreSQL instance.
 */

import { QueryExecutor } from './query-executor';
import { ConnectionPoolManager } from './connection-pool';

// Access private methods for testing via prototype
const executor = QueryExecutor.getInstance();
const proto = Object.getPrototypeOf(executor);

afterAll(() => {
  // Stop the cleanup timer to prevent Jest open handle warning
  ConnectionPoolManager.getInstance().stopCleanupTimer();
});

describe('QueryExecutor', () => {
  describe('splitBatches', () => {
    const splitBatches = proto.splitBatches.bind(executor);

    it('returns single batch when no GO separator', () => {
      const result = splitBatches('SELECT 1');
      expect(result).toEqual(['SELECT 1']);
    });

    it('splits on GO', () => {
      const result = splitBatches('SELECT 1\nGO\nSELECT 2');
      expect(result).toEqual(['SELECT 1', 'SELECT 2']);
    });

    it('handles GO with repeat count', () => {
      const result = splitBatches('PRINT "hello"\nGO 3');
      expect(result).toEqual(['PRINT "hello"', 'PRINT "hello"', 'PRINT "hello"']);
    });

    it('is case-insensitive for GO', () => {
      const result = splitBatches('SELECT 1\ngo\nSELECT 2');
      expect(result).toEqual(['SELECT 1', 'SELECT 2']);
    });

    it('skips empty batches', () => {
      const result = splitBatches('SELECT 1\nGO\n\nGO\nSELECT 2');
      expect(result).toEqual(['SELECT 1', 'SELECT 2']);
    });

    it('returns [""] for empty input', () => {
      const result = splitBatches('');
      expect(result).toEqual(['']);
    });

    it('handles trailing GO', () => {
      const result = splitBatches('SELECT 1\nGO');
      expect(result).toEqual(['SELECT 1']);
    });
  });

  describe('requiresFirstInBatch', () => {
    const requiresFirstInBatch = proto.requiresFirstInBatch.bind(executor);

    it('returns true for CREATE VIEW', () => {
      expect(requiresFirstInBatch('CREATE VIEW dbo.MyView AS SELECT 1')).toBe(true);
    });

    it('returns true for CREATE PROCEDURE', () => {
      expect(requiresFirstInBatch('CREATE PROCEDURE dbo.MyProc AS BEGIN END')).toBe(true);
    });

    it('returns true for CREATE FUNCTION', () => {
      expect(
        requiresFirstInBatch('CREATE FUNCTION dbo.MyFunc() RETURNS INT AS BEGIN RETURN 1 END')
      ).toBe(true);
    });

    it('returns true for CREATE TRIGGER', () => {
      expect(requiresFirstInBatch('CREATE TRIGGER MyTrig ON dbo.T AFTER INSERT AS BEGIN END')).toBe(
        true
      );
    });

    it('returns false for SELECT', () => {
      expect(requiresFirstInBatch('SELECT * FROM Users')).toBe(false);
    });

    it('returns false for INSERT', () => {
      expect(requiresFirstInBatch('INSERT INTO Users VALUES (1)')).toBe(false);
    });

    it('returns false for CREATE TABLE', () => {
      expect(requiresFirstInBatch('CREATE TABLE dbo.T (id INT)')).toBe(false);
    });
  });

  describe('parseSimpleSelect', () => {
    const parseSimpleSelect = proto.parseSimpleSelect.bind(executor);

    it('parses simple SELECT from schema.table', () => {
      const result = parseSimpleSelect('SELECT * FROM dbo.Users');
      expect(result).toEqual({ schema: 'dbo', table: 'Users' });
    });

    it('parses SELECT with brackets', () => {
      const result = parseSimpleSelect('SELECT * FROM [dbo].[Users]');
      expect(result).toEqual({ schema: 'dbo', table: 'Users' });
    });

    it('defaults to dbo schema when no schema specified', () => {
      const result = parseSimpleSelect('SELECT * FROM Users');
      expect(result).toEqual({ schema: 'dbo', table: 'Users' });
    });

    it('returns null for complex queries', () => {
      const result = parseSimpleSelect(
        'SELECT * FROM dbo.Users u JOIN dbo.Orders o ON u.id = o.userId'
      );
      expect(result).toBeNull();
    });

    it('returns null for non-SELECT queries', () => {
      const result = parseSimpleSelect('INSERT INTO dbo.Users VALUES (1)');
      expect(result).toBeNull();
    });
  });

  describe('pgTypeIdToName', () => {
    const pgTypeIdToName = proto.pgTypeIdToName.bind(executor);

    it('maps common PG type OIDs', () => {
      expect(pgTypeIdToName(23)).toBe('int4');
      expect(pgTypeIdToName(25)).toBe('text');
      expect(pgTypeIdToName(16)).toBe('boolean');
      expect(pgTypeIdToName(1043)).toBe('varchar');
      expect(pgTypeIdToName(1114)).toBe('timestamp');
      expect(pgTypeIdToName(2950)).toBe('uuid');
      expect(pgTypeIdToName(3802)).toBe('jsonb');
    });

    it('returns oid:N for unknown types', () => {
      expect(pgTypeIdToName(99999)).toBe('oid:99999');
    });
  });

  describe('createCancelledResult', () => {
    const createCancelledResult = proto.createCancelledResult.bind(executor);

    it('returns a result with success false and cancelled message', () => {
      const result = createCancelledResult('q1', Date.now() - 100);
      expect(result.success).toBe(false);
      expect(result.queryId).toBe('q1');
      expect(result.messages).toContain('Query was cancelled');
      expect(result.executionTime).toBeGreaterThanOrEqual(0);
    });
  });
});
