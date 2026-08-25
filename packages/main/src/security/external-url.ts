/**
 * The allowlist that stands between the renderer and `shell.openExternal`.
 *
 * `shell.openExternal` does not open a browser — it asks the OS to open the URL, so the set of
 * things it can do is the set of schemes the host has registered. `file:` reveals the filesystem
 * through Finder/Explorer, `javascript:`/`data:` are script sinks, and a registered custom scheme
 * (`ms-msdt:`, `smb:`, …) can launch another application with an attacker-chosen argument. The
 * renderer reaches this through one IPC channel, and a model-authored markdown link is enough to
 * drive it — so the scheme is checked here, in main, on every call.
 *
 * Pure by design: no electron, no I/O. The channel that uses it is `ipc/app.ipc.ts`.
 */

/** The only schemes Joinery hands to the OS. Everything else is refused. */
export const OPENABLE_SCHEMES = ['https:', 'http:', 'mailto:'] as const;

export type OpenableScheme = (typeof OPENABLE_SCHEMES)[number];

/**
 * Refusal to open a URL externally.
 *
 * The message carries the rejected **scheme** and never the rest of the URL: it travels to the
 * log ring buffer, the renderer's Output panel and an error toast, and a rejected URL can hold a
 * credential or a token in its userinfo, path or query.
 */
export class UnsafeExternalUrlError extends Error {
  /** The scheme that was refused, or `undefined` when the candidate did not parse as a URL. */
  readonly scheme?: string;

  constructor(scheme?: string) {
    super(
      scheme === undefined
        ? `Refused to open an external link: not a valid URL. Joinery opens ${OPENABLE_SCHEMES.join(', ')} links only.`
        : `Refused to open an external "${scheme}" link. Joinery opens ${OPENABLE_SCHEMES.join(', ')} links only.`
    );
    this.name = 'UnsafeExternalUrlError';
    this.scheme = scheme;
  }
}

/**
 * The candidate's scheme, per the WHATWG URL parser, or `undefined` if it is not a URL.
 *
 * Going through `new URL` rather than a regex is the point: the parser strips leading/trailing
 * whitespace and removes embedded tab/newline characters, so `"java\nscript:alert(1)"` resolves
 * to `javascript:` here exactly as it would in a browser. A regex over the raw string would see
 * something that matches nothing and fall through.
 */
function schemeOf(candidate: string): { readonly url: URL; readonly scheme: string } | undefined {
  try {
    const url = new URL(candidate);
    return { url, scheme: url.protocol };
  } catch {
    // Not a URL. The caller turns this into a refusal; nothing is swallowed.
    return undefined;
  }
}

function isOpenableScheme(scheme: string): scheme is OpenableScheme {
  return (OPENABLE_SCHEMES as readonly string[]).includes(scheme);
}

/**
 * True when `candidate` is a URL Joinery is willing to hand to the OS.
 *
 * Accepts `unknown` in practice — the value arrives over IPC, where the `string` in the preload
 * signature is a compile-time claim and nothing more.
 */
export function isOpenableExternalUrl(candidate: string): boolean {
  if (typeof candidate !== 'string') return false;
  const parsed = schemeOf(candidate);
  return parsed !== undefined && isOpenableScheme(parsed.scheme);
}

/**
 * The parsed URL, or a thrown `UnsafeExternalUrlError`.
 *
 * Throwing rather than returning a result is what the IPC layer wants: `safeHandle` logs the
 * error with its channel and re-throws so Electron serialises the message back to the renderer,
 * which is how the user finds out the link was refused.
 */
export function assertOpenableExternalUrl(candidate: string): URL {
  if (typeof candidate !== 'string') throw new UnsafeExternalUrlError();

  const parsed = schemeOf(candidate);
  if (parsed === undefined) throw new UnsafeExternalUrlError();
  if (!isOpenableScheme(parsed.scheme)) throw new UnsafeExternalUrlError(parsed.scheme);

  return parsed.url;
}
