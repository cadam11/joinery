/**
 * The query tab's public surface.
 *
 * `QueryPanel` is what the dock mounts; `QueryCommands` is exported separately because
 * `commands/bus.spec.tsx`'s ownership test mounts it on its own (the panel is a Monaco host and cannot
 * be rendered in jsdom — see that component's header). The stores and pure helpers are exported for
 * their tests and for Task 11/14, which read the same result.
 */

export { QueryPanel } from './query-panel';
export { QueryCommands, type QueryCommandHandlers } from './query-commands';
export { detectPlaceholders, substitutePlaceholders } from './placeholders';
export { FILE_PATH_METADATA_KEY, rememberedFilePath } from './query-files';

/**
 * Task 14's three sub-panels. `QueryPanel` mounts all of them, so nothing outside this feature needs
 * the components — what IS exported for another surface is the FK machinery:
 *
 * **J-46** (the results grid's cell context menu) wants two items, "open the referenced row" and
 * "preview it". This task owns the machinery and J-46 owns the menu, which does not exist yet — so
 * the seam is `fkTargetFor` (does this cell point anywhere?) plus `openReferencedRowTab` (open it),
 * both already used by the rail. A menu built on those two cannot drift from the rail's behaviour.
 */
export { ConnectionContextChip } from './connection-context-chip';
export { ResultHistoryPanel } from './result-history-panel';
export {
  RowDetailPanel,
  openReferencedRowTab,
  type DisplayedRows,
  type RowDetailTarget,
} from './row-detail-panel';
export {
  fkOpenSql,
  fkTabTitle,
  fkTargetFor,
  mergeEnrichedColumns,
  parseSingleTableSelect,
  sqlLiteral,
  type FkTarget,
  type TableRef,
} from './fk-lookup';
export { buildRowFields, formatColumnType, type RowField } from './row-detail';
export { buildDiffView, type DiffView } from './result-diff';
export {
  captureResultSnapshot,
  formatSnapshotTime,
  snapshotAsResult,
  snapshotLabel,
  sortSnapshots,
} from './snapshots';
export { formatQueryContext, resolveQueryContext, type QueryContext } from './query-context';
