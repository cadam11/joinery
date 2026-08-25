/**
 * Production-grade logging service for Joinery main process.
 *
 * Log levels: debug < info < warn < error
 * In development (NODE_ENV !== 'production'), defaults to 'debug'.
 * In production, defaults to 'warn'.
 *
 * Beyond console output, every entry is retained in a bounded in-memory ring
 * buffer and fanned out to registered listeners. This is what powers the
 * renderer's Output / Console panel (via a separate electron bridge that
 * subscribes here) without coupling this module to electron — keeping it safe
 * to import from unit-tested code.
 */

/* eslint-disable no-console -- This module is the one place allowed to reach the console.
   `no-console` exists to route every message through `createLogger`, so that it lands in the
   Output panel as well as the terminal; the four calls below are what makes that true. Disabling
   the rule anywhere else would be the bug it is guarding against (J-128). */
import type { LogEntry } from '@joinery/shared';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let globalLevel: LogLevel = process.env.NODE_ENV === 'production' ? 'warn' : 'debug';

export function setLogLevel(level: LogLevel): void {
  globalLevel = level;
}

export function getLogLevel(): LogLevel {
  return globalLevel;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[globalLevel];
}

/**
 * True when `level` is at or above `threshold`. Used by the IPC bridge to
 * gate per-entry renderer broadcasts (debug entries stay in the ring buffer
 * and log file but don't wake the renderer per line).
 */
export function meetsLevel(level: LogLevel, threshold: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[threshold];
}

function timestamp(): string {
  return new Date().toISOString();
}

function formatMessage(level: LogLevel, tag: string, message: string): string {
  return `${timestamp()} [${level.toUpperCase()}] [${tag}] ${message}`;
}

// --- ring buffer + listener fan-out -----------------------------------------

const MAX_BUFFER = 1000;
const buffer: LogEntry[] = [];
const listeners = new Set<(entry: LogEntry) => void>();
let entrySeq = 0;

/**
 * Flatten the trailing `...args` of a log call into a single detail string for
 * the expandable view. Errors contribute their stack; everything else is
 * stringified. Returns undefined when there's nothing extra to show.
 */
function flattenDetail(args: unknown[]): string | undefined {
  if (args.length === 0) return undefined;
  const parts = args.map(arg => {
    if (arg instanceof Error) {
      return arg.stack || `${arg.name}: ${arg.message}`;
    }
    if (typeof arg === 'string') return arg;
    try {
      return JSON.stringify(arg, null, 2);
    } catch {
      return String(arg);
    }
  });
  const joined = parts.join('\n');
  return joined.trim() ? joined : undefined;
}

function record(level: LogLevel, tag: string, message: string, detail?: string): void {
  const entry: LogEntry = {
    id: `m-${Date.now()}-${entrySeq++}`,
    timestamp: Date.now(),
    level,
    tag,
    message,
    source: 'main',
    detail,
  };
  buffer.push(entry);
  if (buffer.length > MAX_BUFFER) buffer.shift();
  for (const listener of listeners) {
    // A listener throwing must not break logging for everyone else.
    try {
      listener(entry);
    } catch {
      /* swallow — logging is best-effort */
    }
  }
}

/** Snapshot of the retained log entries, oldest first. */
export function getRecentLogs(limit = MAX_BUFFER): LogEntry[] {
  return limit >= buffer.length ? [...buffer] : buffer.slice(buffer.length - limit);
}

/** Subscribe to every new log entry. Returns an unsubscribe function. */
export function onLogEntry(listener: (entry: LogEntry) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Inject an entry that originated outside this module (e.g. forwarded from the
 * renderer) so the buffer and panel show a single unified timeline.
 */
export function ingestExternalEntry(entry: LogEntry): void {
  buffer.push(entry);
  if (buffer.length > MAX_BUFFER) buffer.shift();
  for (const listener of listeners) {
    try {
      listener(entry);
    } catch {
      /* swallow */
    }
  }
}

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/**
 * Create a tagged logger instance.
 *
 * Usage:
 *   const log = createLogger('PoolManager');
 *   log.info('Connected to server');
 *   log.error('Connection failed', error);
 */
export function createLogger(tag: string): Logger {
  return {
    debug(message: string, ...args: unknown[]) {
      record('debug', tag, message, flattenDetail(args));
      if (shouldLog('debug')) {
        console.debug(formatMessage('debug', tag, message), ...args);
      }
    },
    info(message: string, ...args: unknown[]) {
      record('info', tag, message, flattenDetail(args));
      if (shouldLog('info')) {
        console.log(formatMessage('info', tag, message), ...args);
      }
    },
    warn(message: string, ...args: unknown[]) {
      record('warn', tag, message, flattenDetail(args));
      if (shouldLog('warn')) {
        console.warn(formatMessage('warn', tag, message), ...args);
      }
    },
    error(message: string, ...args: unknown[]) {
      record('error', tag, message, flattenDetail(args));
      if (shouldLog('error')) {
        console.error(formatMessage('error', tag, message), ...args);
      }
    },
  };
}
