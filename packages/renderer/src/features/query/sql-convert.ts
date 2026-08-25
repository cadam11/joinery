/**
 * The SQL dialect converter's one adapter over `query.convertSql` — and the only place in this renderer
 * that touches PLAN.md §7.3's wart.
 *
 * ── The wart, and why it is contained rather than fixed ─────────────────────────────────────
 *
 * `query.convertSql(sql, fromEngine: string, toEngine: string)`
 * (`packages/preload/src/index.ts:249-253`) takes **bare strings** for two parameters that have a
 * `DatabaseEngine` union sitting right there in `@joinery/shared`. Two adjacent strings of the same type
 * transpose silently: `convertSql(sql, target, source)` compiles, runs, and converts backwards.
 *
 * PLAN.md §8 puts `packages/preload` out of scope for the rewrite, so the signature stays. What this
 * module does is make the transposition unrepresentable **on this side** of the boundary: the exported
 * function takes a named object, so `from` and `to` cannot swap places, and the widening to `string`
 * happens once, on the line below the comment that says why. Nothing else in the renderer may call
 * `convertSql`.
 *
 * A follow-up ticket for the signature is the right fix; this is the fence until then.
 *
 * ── Why the engines are checked here and not by the caller ──────────────────────────────────
 *
 * `sqlglot` cannot convert a dialect to itself in any useful sense, and the Angular menu handled that by
 * hiding the current engine's item. Hiding is right for a menu and wrong as the only guard: the palette
 * offers all three, so the refusal has to exist somewhere the menu is not. It is a returned reason
 * rather than a thrown error, because "you are already on PostgreSQL" is information and not a fault.
 */

import type { DatabaseEngine, PythonDepsResult } from '@joinery/shared';

import { ipc } from '../../ipc';
import { diagnostics } from '../../state/diagnostics';

/** What each engine is called in prose. The palette, the menu and the toasts all read this. */
export const ENGINE_LABELS: Record<DatabaseEngine, string> = {
  mssql: 'SQL Server',
  postgresql: 'PostgreSQL',
  mysql: 'MySQL',
};

/** Every engine the converter can target, in the order the toolbar menu lists them. */
export const CONVERTIBLE_ENGINES: readonly DatabaseEngine[] = ['mssql', 'postgresql', 'mysql'];

export interface ConvertRequest {
  readonly sql: string;
  readonly from: DatabaseEngine;
  readonly to: DatabaseEngine;
}

export type ConvertOutcome =
  | { readonly ok: true; readonly sql: string }
  /** `reason` is a sentence for the user. Nothing here throws. */
  | {
      readonly ok: false;
      readonly reason: string;
      /**
       * Present only when this host cannot run the converter at all (J-29). A setup problem with
       * a guided fix, not a failed conversion — the caller shows the instructions view rather
       * than the sentence.
       */
      readonly pythonSetup?: PythonDepsResult;
    };

/**
 * Convert `sql` from one dialect to another.
 *
 * Four refusals, all of them stated rather than thrown: nothing to convert, the same engine twice, a
 * conversion the main process rejected, and a call that failed outright. The last is also logged — the
 * returned sentence is for the user, the cause is what makes a broken `sqlglot` debuggable from the
 * Output panel. The Angular version discarded it (`catch { notification.error(…) }`).
 */
export async function convertSql(request: ConvertRequest): Promise<ConvertOutcome> {
  if (request.sql.trim() === '') {
    return { ok: false, reason: 'There is no SQL to convert.' };
  }
  if (request.from === request.to) {
    return { ok: false, reason: `This tab is already ${ENGINE_LABELS[request.to]}.` };
  }

  try {
    // THE one widening to `string`, and the reason the rest of the renderer goes through this function:
    // the bridge takes two adjacent bare strings, so passing them positionally anywhere else is a
    // transposition waiting to happen (PLAN.md §7.3).
    const result = await ipc().query.convertSql(request.sql, request.from, request.to);
    if (!result.success) {
      return {
        ok: false,
        reason: result.error ?? `Could not convert this SQL to ${ENGINE_LABELS[request.to]}.`,
        // Structure, not a sentence. "This host cannot run the converter" is a setup problem with
        // a guided fix, and the caller can only tell it apart from a transpile failure if the
        // refusal says so in a field (J-29).
        ...(result.pythonDeps === undefined ? {} : { pythonSetup: result.pythonDeps }),
      };
    }
    return { ok: true, sql: result.sql };
  } catch (cause) {
    diagnostics.error('SQL conversion failed', cause);
    return { ok: false, reason: `Could not convert this SQL to ${ENGINE_LABELS[request.to]}.` };
  }
}
