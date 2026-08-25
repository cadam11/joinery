#!/usr/bin/env node
/**
 * Acceptance check for a packaged app.asar.
 *
 * electron-builder decides what goes into the asar by walking the package
 * manager's reported dependency tree. When that walk under-reports — as it did
 * with electron-builder 26.4.0 against pnpm 11, which reported `pg` as having
 * zero dependencies — packaging still exits 0 and the app still signs, but the
 * shipped app crashes on the first `require` of a missing transitive package.
 *
 * So: extract the archive and actually require() each module the main process
 * depends on, from inside the extracted tree. require() executes a module's own
 * transitive requires; require.resolve() does not, and would have passed against
 * the broken build.
 *
 * Any file resolving OUTSIDE the extract directory is a leak: the module only
 * loaded because this machine has it elsewhere, and it would be absent for a user.
 *
 * That covers the MAIN process. `checkRendererBundle` covers the other half — the static bundle
 * `window.ts` loads over `file://` — which nothing checked until Task 24 replaced the renderer.
 *
 * Usage: node scripts/verify-package.js [path/to/app.asar]
 *   defaults to release/mac-arm64/Joinery.app/Contents/Resources/app.asar
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..');
const DEFAULT_ASAR = path.join(
  ROOT_DIR,
  'release/mac-arm64/Joinery.app/Contents/Resources/app.asar'
);

/** Modules loaded for real — require() runs their transitive requires too. */
const JS_MODULES = [
  'pg',
  'mysql2',
  'mysql2/promise',
  'mssql',
  'dockerode',
  'electron-store',
  'ssh2',
  'uuid',
  '@joinery/shared',
  '@azure/msal-node',
  '@aws-sdk/dsql-signer',
  '@aws-sdk/credential-providers',
  '@aws/aurora-dsql-node-postgres-connector',
];

/** Native modules are built against Electron's ABI, so plain Node can only resolve them. */
const NATIVE_MODULES = ['keytar'];

/**
 * Files that legitimately resolve outside the bundle. Only supports-color:
 * debug/src/node.js requires it inside a try/catch and works without it, and it
 * is absent from npm-built asars too.
 */
const ALLOWED_OUTSIDE = [/[/\\]node_modules[/\\]supports-color[/\\]/];

/**
 * `require('electron')` is satisfied by the Electron runtime, never by a packaged
 * module, so plain Node cannot resolve it. Drop a stub inside the extract so
 * modules that require it (electron-store) load without reaching outside.
 */
function writeElectronStub(extractDir) {
  const stubDir = path.join(extractDir, 'node_modules', 'electron');
  fs.mkdirSync(stubDir, { recursive: true });
  fs.writeFileSync(
    path.join(stubDir, 'package.json'),
    JSON.stringify({ name: 'electron', version: '0.0.0-stub', main: 'index.js' })
  );
  fs.writeFileSync(
    path.join(stubDir, 'index.js'),
    'module.exports = { app: { getPath: () => process.cwd(), getName: () => "Joinery", getVersion: () => "0.0.0" }, ipcMain: { on() {}, handle() {} }, shell: {} };\n'
  );
}

function buildProbeSource(extractDir) {
  return `
    const EXTRACT = ${JSON.stringify(extractDir)};
    const ALLOWED = ${JSON.stringify(ALLOWED_OUTSIDE.map(String))}.map(s => {
      const body = s.slice(1, s.lastIndexOf('/'));
      return new RegExp(body, s.slice(s.lastIndexOf('/') + 1));
    });
    const results = [];
    for (const name of ${JSON.stringify(JS_MODULES)}) {
      try {
        require(name);
        const outside = Object.keys(require.cache)
          .filter(f => !f.startsWith(EXTRACT))
          .filter(f => !ALLOWED.some(re => re.test(f)));
        results.push({ name, ok: true, outside: outside.slice(0, 3), outsideCount: outside.length });
      } catch (err) {
        results.push({ name, ok: false, err: String(err.message).split('\\n')[0] });
      }
      for (const key of Object.keys(require.cache)) delete require.cache[key];
    }
    for (const name of ${JSON.stringify(NATIVE_MODULES)}) {
      try {
        require.resolve(name);
        results.push({ name, ok: true, resolveOnly: true, outsideCount: 0 });
      } catch {
        results.push({ name, ok: false, err: 'unresolvable' });
      }
    }
    console.log(JSON.stringify(results));
  `;
}

/**
 * The sqlglot server is spawned as an external python3 process, so it must live
 * OUTSIDE app.asar. An in-asar copy passes Node's existsSync through Electron's
 * shim but python3 cannot open it, and the failure surfaces as the misleading
 * "Python 3 is required". Checked here because only a packaged build can show it.
 */
function checkExternalResources(asarPath, asarEntries) {
  const resourcesDir = path.dirname(asarPath);
  const serverScript = path.join(resourcesDir, 'resources', 'python', 'sqlglot-server.py');
  let failures = 0;

  if (fs.existsSync(serverScript)) {
    console.log(`  ok    ${'sqlglot-server.py (outside asar)'.padEnd(44)}`);
  } else {
    console.log(`  FAIL  ${'sqlglot-server.py'.padEnd(44)} not found at ${serverScript}`);
    failures++;
  }

  const inAsar = asarEntries.filter(f => f.endsWith('sqlglot-server.py'));
  if (inAsar.length > 0) {
    console.log(
      `  FAIL  ${'sqlglot-server.py'.padEnd(44)} also packed INSIDE the asar: ${inAsar[0]}`
    );
    failures++;
  }

  return failures;
}

/**
 * The renderer itself, which nothing checked until the cutover (Task 24).
 *
 * Everything above probes the MAIN process's dependency tree. The renderer is a directory of static
 * files, so it has no `require` graph to walk — and the consequence was that a packaged app with an
 * empty, absolute-URL'd or worker-less renderer passed `verify:package` cleanly and only failed when
 * a human double-clicked it. Since the cutover replaced that renderer wholesale, "the bundle landed
 * and can load itself over file://" is exactly the claim that needed evidence.
 *
 * Three assertions, each one a way the bundle has actually been able to break:
 *
 *  1. `index.html` is in the asar at the path `window.ts` loads.
 *  2. Every asset it references is RELATIVE. `base: './'` (vite.config.ts) is a non-negotiable of
 *     §3.1: an absolute `/assets/…` resolves against the filesystem root under `file://` and the
 *     window comes up blank.
 *  3. **Every file `vite build` emitted is in the asar** — compared file-by-file against
 *     `packages/renderer/dist/browser` on disk, which `package:mac` has just rebuilt.
 *
 * The third check replaced two narrower ones (Task 24 review, M2 + M4): "every URL named in
 * index.html resolves" missed lazy chunks reached from JS and fonts reached from CSS (3 of the
 * build's 210 files were checked), and "at least one *worker*.js exists" would have passed with one
 * worker when six shipped. Comparing the whole tree covers both, and it is the honest invariant:
 * the asar must contain what the build produced, not a subset someone thought to name.
 */
function checkRendererBundle(extractDir) {
  const INDEX_REL = path.join('packages', 'renderer', 'dist', 'browser', 'index.html');
  const BROWSER_REL = path.dirname(INDEX_REL);
  const label = name => `  ${name.padEnd(46)}`;
  const indexOnDisk = path.join(extractDir, INDEX_REL);
  let failures = 0;

  if (!fs.existsSync(indexOnDisk)) {
    console.log(`  FAIL${label('renderer index.html')} not in the asar at ${INDEX_REL}`);
    return 1;
  }
  console.log(`  ok  ${label('renderer index.html')}`);

  const html = fs.readFileSync(indexOnDisk, 'utf8');
  const referenced = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(m => m[1]);
  const local = referenced.filter(url => !/^(https?:)?\/\//.test(url) && !url.startsWith('data:'));

  const absolute = local.filter(url => url.startsWith('/'));
  if (absolute.length > 0) {
    console.log(`  FAIL${label('renderer asset URLs are relative')} absolute: ${absolute[0]}`);
    failures++;
  } else if (local.length === 0) {
    // A parse that found nothing would make the check above vacuous.
    console.log(
      `  FAIL${label('renderer asset URLs are relative')} index.html references no assets`
    );
    failures++;
  } else {
    console.log(`  ok  ${label(`renderer asset URLs are relative (${local.length})`)}`);
  }

  failures += checkRendererTreeComplete(path.join(extractDir, BROWSER_REL));
  failures += checkRendererReachable(path.join(extractDir, BROWSER_REL));
  return failures;
}

/**
 * Every file the renderer build emitted, present in the asar.
 *
 * The on-disk `dist/browser` is the reference because `pnpm run package:mac` is
 * `pnpm run build && node scripts/package.js --mac` — the tree electron-builder collected is the
 * one still sitting there. Running `verify:package` against an asar with no matching local build is
 * a hard failure rather than a skip: a check that silently passes when it cannot run is the exact
 * vacuity this script exists to avoid.
 *
 * Dotfiles are excluded from both sides because electron-builder drops them
 * (`!**​/{.DS_Store,.git,…}` in electron-builder.yml), so a Finder visit to the build directory must
 * not fail the gate.
 */
function checkRendererTreeComplete(browserInAsar) {
  const label = name => `  ${name.padEnd(46)}`;
  const browserOnDisk = path.join(ROOT_DIR, 'packages', 'renderer', 'dist', 'browser');

  if (!fs.existsSync(browserOnDisk)) {
    console.log(
      `  FAIL${label('renderer bundle complete')} no local build at ${path.relative(ROOT_DIR, browserOnDisk)} ` +
        `to compare against — run "pnpm run build" first`
    );
    return 1;
  }

  const built = listFilesRelative(browserOnDisk);
  if (built.length === 0) {
    console.log(`  FAIL${label('renderer bundle complete')} the local build directory is empty`);
    return 1;
  }

  const missing = built.filter(rel => !fs.existsSync(path.join(browserInAsar, rel)));
  if (missing.length > 0) {
    console.log(
      `  FAIL${label('renderer bundle complete')} ${missing.length} of ${built.length} built ` +
        `file(s) absent from the asar, e.g. ${missing[0]}`
    );
    return 1;
  }

  console.log(`  ok  ${label(`renderer bundle complete (${built.length} files)`)}`);
  return 0;
}

/**
 * Every emitted file is reachable from `index.html` (J-98).
 *
 * turbo's cache restore is ADDITIVE: on a cache hit it replays the cached outputs over whatever is
 * already in `dist/`, and the build script never runs, so vite's `emptyOutDir` — which only sweeps
 * on a miss — never sees them. Chunks from an earlier generation therefore accumulate,
 * electron-builder copies all of `dist/browser` into the asar, and every existing check stays green
 * because the tree on disk and the tree in the asar agree with each other. 92 dead files, including
 * a fully orphaned `index-*.js`, shipped that way.
 *
 * Verified rather than assumed while writing this: a marker file dropped into `dist/browser/assets`
 * survived `pnpm run build` on a cache hit. So `rm -rf dist` in the build script — which this PR
 * also adds — cannot be the whole fix; it only cleans the path where the script actually runs.
 *
 * Reachability is by MENTION, not by parsing modules: start at `index.html`, and treat any emitted
 * filename appearing in a reachable file's text as reachable in turn. Vite writes its imports and
 * asset URLs as literal filenames, so a mention is what a reference looks like — and a check that
 * over-approximates reachability cannot produce a false failure, only miss an orphan.
 */
function checkRendererReachable(browserDir) {
  const label = name => `  ${name.padEnd(46)}`;
  const indexPath = path.join(browserDir, 'index.html');

  if (!fs.existsSync(indexPath)) {
    console.log(`  FAIL${label('no orphaned renderer chunks')} no index.html in the asar bundle`);
    return 1;
  }

  const emitted = listFilesRelative(browserDir);
  const byBasename = new Map(emitted.map(rel => [path.basename(rel), rel]));

  const reachable = new Set(['index.html']);
  const queue = ['index.html'];

  // Bounded by the file count: each file is read at most once, and nothing is queued twice.
  for (let index = 0; index < queue.length && index <= emitted.length; index += 1) {
    const current = queue[index];
    const text = readTextOrEmpty(path.join(browserDir, current));
    if (text === '') continue;

    for (const [basename, rel] of byBasename) {
      if (reachable.has(rel) || !text.includes(basename)) continue;
      reachable.add(rel);
      queue.push(rel);
    }
  }

  const orphans = emitted.filter(rel => !reachable.has(rel));
  if (orphans.length > 0) {
    console.log(
      `  FAIL${label('no orphaned renderer chunks')} ${orphans.length} of ${emitted.length} ` +
        `file(s) unreachable from index.html, e.g. ${orphans[0]} — ` +
        `run "pnpm run clean:dist" and build again`
    );
    return 1;
  }

  console.log(`  ok  ${label(`no orphaned renderer chunks (${emitted.length} reachable)`)}`);
  return 0;
}

/** A file's text, or '' for one that is not text — a font or an image mentions nothing. */
function readTextOrEmpty(filePath) {
  if (/\.(png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|eot|mp4|webm)$/i.test(filePath)) return '';
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

/** Every non-dot file under `root`, as paths relative to it. Bounded by the directory tree. */
function listFilesRelative(root, prefix = '') {
  const files = [];
  for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const rel = path.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...listFilesRelative(root, rel));
    else files.push(rel);
  }
  return files;
}

function report(results) {
  let failures = 0;
  for (const r of results) {
    if (!r.ok) {
      console.log(`  FAIL  ${r.name.padEnd(44)} ${r.err}`);
      failures++;
    } else if (r.outsideCount > 0) {
      console.log(
        `  LEAK  ${r.name.padEnd(44)} ${r.outsideCount} file(s) outside bundle: ${r.outside[0]}`
      );
      failures++;
    } else {
      console.log(`  ok    ${r.name.padEnd(44)}${r.resolveOnly ? '(resolve-only, native)' : ''}`);
    }
  }
  return failures;
}

const asarPath = path.resolve(process.argv[2] || DEFAULT_ASAR);
if (!fs.existsSync(asarPath)) {
  console.error(`No asar at ${asarPath} — run "pnpm run package:dir" first.`);
  process.exit(1);
}

const asar = require('@electron/asar');
// realpath: on macOS os.tmpdir() is /var/... while resolved module paths report
// /private/var/..., so an unresolved prefix would mark every file as "outside".
const extractDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'joinery-verify-')));

let failures = 1;
try {
  console.log(`Verifying ${path.relative(ROOT_DIR, asarPath)}`);
  const asarEntries = asar.listPackage(asarPath, { isPack: false });
  asar.extractAll(asarPath, extractDir);
  writeElectronStub(extractDir);

  const stdout = execFileSync(process.execPath, ['-e', buildProbeSource(extractDir)], {
    cwd: path.join(extractDir, 'packages', 'main', 'dist'),
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH: '' },
  });
  failures = report(JSON.parse(stdout.trim().split('\n').pop()));
  failures += checkExternalResources(asarPath, asarEntries);
  failures += checkRendererBundle(extractDir);
} finally {
  fs.rmSync(extractDir, { recursive: true, force: true });
}

console.log(
  failures
    ? `\n${failures} problem(s) — the packaged app is not fit to ship.`
    : '\nAll modules load entirely from within the bundle.'
);
process.exit(failures ? 1 : 0);
