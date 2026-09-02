/**
 * Types for the Monaco INTERNAL modules `monaco-default-keybindings.spec.ts` imports at runtime.
 *
 * That spec audits every keystroke the app advertises against the keybindings Monaco really
 * registers, and the only honest source for "really registers" is Monaco's own keybinding registry —
 * which is not part of the published API surface, so the specifiers below are untyped and a plain
 * import is a `noImplicitAny` error. The same situation, and the same remedy, as
 * `monaco-enums.d.ts`.
 *
 * Each declaration is narrowed to **exactly what the spec calls**, for two reasons: a 1:1
 * re-declaration of Monaco's internals would rot invisibly, and a wider type would let a future
 * edit reach further into them than the audit needs. Nothing outside `src/editor/` can import these
 * at all — the `no-restricted-imports` fence in `eslint.config.js` covers `monaco-editor/*`.
 *
 * These are hand-written types over code this repo does not own, so they could in principle drift
 * from reality. What stops that being silent: the spec asserts its scan is non-vacuous (a registry
 * of at least a hundred distinct first chords, with two named bindings present). A shape change
 * that made these declarations wrong would produce an empty scan and fail there.
 */

/** An `OperatingSystem` member, and the numbers below are Monaco's: 1 Windows, 2 macOS, 3 Linux. */
type MonacoOperatingSystem = number;

/**
 * A decoded `Keybinding`. Opaque on purpose: the spec only ever passes one back to Monaco.
 */
interface MonacoKeybinding {
  readonly __monacoKeybinding: unique symbol;
}

/** What `USLayoutResolvedKeybinding.resolveKeybinding` hands back, in the one method used. */
interface MonacoResolvedKeybinding {
  /**
   * The strings the keybinding resolver keys its rule map on — one per chord, `null` for a chord
   * that cannot be dispatched (a bare modifier).
   */
  getDispatchChords(): (string | null)[];
}

/**
 * The app's own entry point, imported for its SIDE EFFECTS — loading it is what registers every
 * default keybinding. `editor/monaco.ts` imports the same specifier and needs no declaration,
 * because a bare `import '…'` has no value to type; the audit spec loads it with a dynamic
 * `import()` (after pinning the platform), and that expression does. Declared with no exports for
 * that reason: nothing may read anything off it.
 */
declare module 'monaco-editor/editor/editor.main.js' {}

declare module 'monaco-editor/platform/keybinding/common/keybindingsRegistry.js' {
  /** One entry of the registry. `keybinding` is null for a rule that REMOVES a binding. */
  export interface MonacoKeybindingItem {
    readonly keybinding: MonacoKeybinding | null;
    readonly command: string | null;
  }

  export const KeybindingsRegistry: {
    /** Already reduced to the platform Monaco was imported for. */
    getDefaultKeybindings(): MonacoKeybindingItem[];
  };
}

declare module 'monaco-editor/platform/keybinding/common/usLayoutResolvedKeybinding.js' {
  export const USLayoutResolvedKeybinding: {
    resolveKeybinding(
      keybinding: MonacoKeybinding,
      os: MonacoOperatingSystem
    ): MonacoResolvedKeybinding[];
  };
}

declare module 'monaco-editor/base/common/keybindings.js' {
  /** `null` when the number does not describe a dispatchable keybinding. */
  export function decodeKeybinding(
    keybinding: number,
    os: MonacoOperatingSystem
  ): MonacoKeybinding | null;
}

declare module 'monaco-editor/base/common/keyCodes.js' {
  export const KeyCodeUtils: {
    /** A key's UI label (`'K'`, `'/'`, `'Enter'`) as its `KeyCode`, or 0 for an unknown label. */
    fromString(label: string): number;
  };
}

declare module 'monaco-editor/base/common/platform.js' {
  export const OS: MonacoOperatingSystem;
}
