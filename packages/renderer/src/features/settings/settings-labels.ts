/**
 * Setting labels that another surface quotes back to the user.
 *
 * The results grid's truncation tooltip said `Capped by your "maximum rows to display" setting`
 * while the control read **Maximum rows to fetch** (J-107). Nobody mistyped it: the tooltip was
 * written against the field name, `maxRowsToDisplay`, and the label was written for the user.
 * Two literals, one of them wrong the moment the other was edited.
 *
 * Only labels that appear in TWO places belong here. A label a single control owns is clearer
 * spelled where it is rendered.
 */

/** Settings ▸ Query ▸ the row cap. Rendered by `settings-groups.tsx`, quoted by the results grid. */
export const MAX_ROWS_SETTING_LABEL = 'Maximum rows to fetch';
