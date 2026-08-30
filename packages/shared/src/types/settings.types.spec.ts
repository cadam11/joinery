/**
 * The shipped editor defaults, pinned (J-44).
 *
 * These six are the app's only settings whose default is a VISIBLE decision rather than a
 * threshold: the Angular renderer hardcoded its Monaco options past `EditorSettings` entirely
 * (`query.component.ts:1270-1279`), so every editor preference was inert and four of the six
 * defaults disagreed with what users were actually looking at. The React `<SqlEditor>` derives all
 * six from the setting, which makes each default a change a user sees the moment they open a query
 * tab.
 *
 * Craig's ruling: the defaults stay at what ships and what the React build has been showing —
 * font 13, tab 4, word wrap off — and the remaining three keep the values documented beside them
 * in `settings.types.ts`. This test is the guard on that ruling, and on the two docs-site pages
 * that state the same numbers (`reference/settings.md`, `features/query-editor.md`): change a
 * default here and this fails until the decision is made again, deliberately, with the docs.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from './settings.types';

describe('DEFAULT_SETTINGS.editor', () => {
  it('is the six values Joinery ships', () => {
    // Exact rather than `toMatchObject`: a seventh preference must not be able to arrive without a
    // deliberate default, which is how the first six ended up disagreeing with the editor.
    expect(DEFAULT_SETTINGS.editor).toEqual({
      fontSize: 13,
      tabSize: 4,
      wordWrap: false,
      minimap: false,
      lineNumbers: true,
      autoComplete: true,
    });
  });
});
