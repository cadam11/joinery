/* Pre-mount theme resolution. The audit (PROPOSAL §1.6) documented a three-stage
   flash — white, then dark, then light — because the Angular renderer only wrote
   data-theme after it bootstrapped. Writing it here, synchronously, before the
   bundle is even requested, is the fix.

   Task 5 moved settings into main-process AppState, which is reachable only over
   async IPC — no use at all to a <head> script. So the settings store mirrors the
   theme preference, and nothing else, into one small React-owned localStorage key.
   This reader is the mirror's only consumer.

   Task 24 dropped the second half of this read: the Angular `joinery-settings`
   object used to be the fallback, for a user whose one-shot migration had not run
   yet. The migration now DELETES that key once it has lifted it, so the fallback
   would be live for at most one boot. See src/persistence/theme-mirror.ts.

   Deliberately duplicated from src/persistence/theme-mirror.ts: that module cannot
   run before the bundle loads, which is the entire point of this script. Keep the
   two in step — the mirror module documents the whole decision.

   ── Why this is a file in public/ rather than an inline <script> (J-22) ──────────

   It was inline until the main process grew a Content-Security-Policy. Production
   ships `script-src 'self'`, which an inline script does not satisfy, and the
   documented escape hatch — a `sha256-` of the script body in the directive — was
   MEASURED not to work for this app: the digest Chromium computes for this script
   is byte-identical to the one in the policy it echoes back, and it refuses to
   execute it anyway, over `file://`. A `nonce-` is not available either, because
   nothing rewrites this HTML at load time.

   As a classic (non-module, non-async, non-defer) script in <head> it still blocks
   the parser and still runs before the deferred module bundle, so the ordering the
   whole file exists for is unchanged. It lives in `public/` so Vite copies it
   verbatim instead of treating it as a module to bundle. The cost is one extra
   local read; the benefit is that `script-src 'self'` needs no exception at all. */
(function () {
  var isPreference = function (value) {
    return value === 'system' || value === 'light' || value === 'dark';
  };
  var read = function (key) {
    try {
      return window.localStorage.getItem(key);
    } catch (error) {
      /* Storage blocked outright. Not fatal — 'system' is a correct answer — but
         never silent. */
      console.warn('[joinery] could not read localStorage key ' + key + ':', error);
      return null;
    }
  };

  var mirrored = read('joinery:theme-preference');
  var preference = 'system';
  if (isPreference(mirrored)) {
    preference = mirrored;
  } else if (mirrored != null) {
    console.warn('[joinery] ignoring unrecognised persisted theme:', mirrored);
  }
  document.documentElement.setAttribute('data-theme', preference);
})();
