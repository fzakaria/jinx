// The nixpkgs worker: real nixpkgs, evaluated in the browser. The page
// (site/nixpkgs/) hands over the URLs of a compiled tree and of the
// nixpkgs source it was compiled from; both are mounted on the remote
// filesystem shim at virtual paths, the runtime is told the one mirrors
// the other, and `import /src { ... }` runs the compiled modules, fetched
// one by one as the evaluation reaches them. The package set is evaluated
// once (the overlay fixpoint is the expensive part) and every attribute
// asked for afterwards is a selection from it.
//
// A worker rather than the page because evaluation is synchronous: a
// module is fetched with a blocking request at the moment `import` needs
// it, and a worker may block where the page may not.
//
// Messages in:
//   { type: "init", treeUrl, srcUrl, treeIndexUrl, srcIndexUrl, system? }
//   { type: "eval", attr }
// Messages out:
//   { type: "progress", modulesLoaded, filesFetched, bytesFetched, last }
//   { type: "ready", names, evaluated, millis, modulesLoaded, filesFetched, bytesFetched }
//   { type: "set", millis }    the package set was evaluated (once, on first use)
//   { type: "prefetch", urls } files the evaluation will read next
//   { type: "fetching", attr, done, total }  progress of a parallel prefetch
//   { type: "result", attr, name, drvPath, outPath, outputs, position, ... }
//   { type: "error", attr?, error }

import * as nix from "../runtime/index.ts";
import {
  type FetchResponse,
  type IndexDir,
  existsSync,
  fetchSync,
  mount,
  onFetch,
  prefetch,
  urlOf,
  stats as fetchStats,
} from "./shims/fs-remote.ts";
import {
  modulesLoaded,
  onImports,
  onLoad,
  setRuntime,
} from "./shims/module-remote.ts";
import { FileLists } from "./file-lists.ts";

// Where the two trees appear to the runtime. The compiled tree's runtime
// is at /tree/.jinx/runtime, which is also what the bundle's
// import.meta.url is defined as at build time (tools/build-site.sh), so
// `<nix/fetchurl.nix>` resolves under it.
const TREE_ROOT = "/tree";
const SRC_ROOT = "/src";
const COREPKGS_OUT = `${TREE_ROOT}/.jinx/corepkgs`;
const COREPKGS_SRC = `${TREE_ROOT}/.jinx/runtime/corepkgs`;

const DEFAULT_SYSTEM = "x86_64-linux";

// Where a top-level attribute's definition is when it follows the
// pkgs/by-name convention: pkgs/by-name/<first two letters>/<name>/package.nix.
const BY_NAME_DIR = "pkgs/by-name";
const BY_NAME_SHARD_LENGTH = 2;
const BY_NAME_FILE = "package.nix";
const PROGRESS_INTERVAL_MS = 100;
const STACK_LINES_REPORTED = 12;

// The worker globals this file uses, declared here since the project is
// type-checked against node's globals, not a browser's.
declare function postMessage(message: unknown): void;
declare const self: {
  onmessage: ((ev: { readonly data: Incoming }) => void) | null;
};

// A runtime that has no `process` must not trip the few places the
// runtime consults it; every one is guarded, but a defined one is safer.
if (typeof globalThis.process === "undefined") {
  (globalThis as { process?: unknown }).process = { env: {} };
}

interface InitMessage {
  readonly type: "init";
  readonly treeUrl: string;
  readonly srcUrl: string;
  readonly treeIndexUrl: string;
  readonly srcIndexUrl: string;
  // Hosts for files over 20 MB, when treeUrl and srcUrl are a CDN with
  // that limit; optional.
  readonly treeBigUrl?: string;
  readonly srcBigUrl?: string;
  // The files evaluating `hello` reads (tools/hot-files.sh), fetched in
  // parallel before the evaluation starts; optional.
  readonly hotUrl?: string;
  // The top-level attribute names (tools/publish-nixpkgs.sh writes them
  // as .jinx/names.json), so the page is usable before the package set
  // is evaluated; optional, the set is evaluated for them otherwise.
  readonly namesUrl?: string;
  // Where the per-attribute file lists live (tools/attr-files.ts writes
  // .jinx/files/<shard>.json), fetched before an attribute is evaluated
  // so its modules arrive in parallel; optional.
  readonly filesUrl?: string;
  readonly system?: string;
}

// Parallel fetches during the prefetch.
const PREFETCH_CONCURRENCY = 32;

// What .jinx/hot.json holds, and each entry of a .jinx/files shard:
// paths relative to the tree and to the source.
interface HotFiles {
  readonly tree: readonly string[];
  readonly src: readonly string[];
}

// The per-attribute file lists, once the indexes are mounted.
let fileLists: FileLists | null = null;

// The hot prefetch started at init, which an evaluation waits for.
let hotPrefetch: Promise<void> | null = null;

interface EvalMessage {
  readonly type: "eval";
  readonly attr: string;
}

type Incoming = InitMessage | EvalMessage;

interface Activity {
  readonly modulesLoaded: number;
  readonly filesFetched: number;
  readonly bytesFetched: number;
}

function activity(): Activity {
  const s = fetchStats();
  return {
    modulesLoaded: modulesLoaded(),
    filesFetched: s.filesFetched,
    bytesFetched: s.bytesFetched,
  };
}

// Progress goes out at most every PROGRESS_INTERVAL_MS; the page cannot
// draw faster than that and the evaluation should not pay for more.
let lastProgress = 0;
let lastPath = "";

function progress(force: boolean): void {
  const now = performance.now();
  if (!force && now - lastProgress < PROGRESS_INTERVAL_MS) {
    return;
  }
  lastProgress = now;
  postMessage({ type: "progress", ...activity(), last: lastPath });
}

onFetch((path) => {
  lastPath = path;
  progress(false);
});
onLoad((path) => {
  lastPath = path;
  progress(false);
});

// The evaluated package set, once init has run.
let pkgs: nix.Attrs | null = null;

function describeError(e: unknown): string {
  if (e instanceof nix.NixError) {
    return `error: ${e.message}`;
  }
  if (e instanceof RangeError) {
    const where = (e.stack ?? "")
      .split("\n")
      .slice(0, STACK_LINES_REPORTED)
      .join("\n");
    return `error: stack overflow in the worker (the browser's stack is smaller than node's)\n${where}`;
  }
  if (e instanceof Error) {
    return e.stack ?? e.message;
  }
  return String(e);
}

function loadIndex(url: string): IndexDir {
  const bytes = fetchSync(url);
  return JSON.parse(new TextDecoder().decode(bytes)) as IndexDir;
}

// Fetch the hot list and its files in parallel; a missing list is not
// an error, the evaluation just fetches as it goes.
async function prefetchHot(url: string): Promise<void> {
  let hot: HotFiles;
  try {
    const res = (await fetch(url)) as unknown as FetchResponse;
    if (!res.ok) {
      return;
    }
    hot = (await res.json()) as HotFiles;
  } catch {
    return;
  }
  const paths = [
    ...hot.tree.map((p) => `${TREE_ROOT}/${p}`),
    ...hot.src.map((p) => `${SRC_ROOT}/${p}`),
  ];
  await prefetch(paths, PREFETCH_CONCURRENCY, (done, total) =>
    postMessage({ type: "fetching", attr: null, done, total }),
  );
}

async function init(msg: InitMessage): Promise<void> {
  const started = performance.now();
  const treeIndex = loadIndex(msg.treeIndexUrl);
  const srcIndex = loadIndex(msg.srcIndexUrl);
  mount(TREE_ROOT, msg.treeUrl, treeIndex, msg.treeBigUrl ?? null);
  mount(SRC_ROOT, msg.srcUrl, srcIndex, msg.srcBigUrl ?? null);
  if (msg.filesUrl !== undefined) {
    fileLists = new FileLists(
      msg.filesUrl,
      TREE_ROOT,
      SRC_ROOT,
      treeIndex,
      srcIndex,
    );
  }
  // The page fetches what a module will read next while this thread is
  // busy evaluating, so the blocking read that follows hits the cache.
  onImports(TREE_ROOT, SRC_ROOT, (urls) =>
    postMessage({ type: "prefetch", urls }),
  );
  setRuntime(nix);
  // The corepkgs tree first: both are under /tree, and a module is
  // matched to the first registered tree whose root is a prefix of it.
  nix.registerTree(COREPKGS_OUT, COREPKGS_SRC);
  nix.registerTree(TREE_ROOT, SRC_ROOT);
  nix.settings.currentSystem = msg.system ?? DEFAULT_SYSTEM;
  nix.settings.log = (line) => postMessage({ type: "log", line });

  checkAbi();
  let names =
    msg.namesUrl === undefined ? null : await fetchNames(msg.namesUrl);
  if (names === null) {
    names = nix.attrKeys(packageSet()).sort();
  }
  postMessage({
    type: "ready",
    names,
    evaluated: pkgs !== null,
    millis: performance.now() - started,
    ...activity(),
  });
  // After ready, so the page takes input while the files arrive; an
  // evaluation asked for meanwhile waits for them rather than fetching
  // the same files one at a time.
  if (msg.hotUrl !== undefined) {
    hotPrefetch = prefetchHot(msg.hotUrl);
    await hotPrefetch;
    progress(true);
  }
}

// The tree's .jinx/config.json names the ABI its modules were compiled
// against; this bundle's runtime has to match, or the modules misread
// the runtime's values ("expected a set but found a set").
const TREE_CONFIG = `${TREE_ROOT}/.jinx/config.json`;
function checkAbi(): void {
  const cfg = JSON.parse(
    new TextDecoder().decode(fetchSync(urlOf(TREE_CONFIG))),
  ) as { abi?: number; jinx?: string };
  const abi = cfg.abi ?? 1;
  if (abi !== nix.ABI) {
    throw new Error(
      `this page's runtime is ABI ${nix.ABI} but the tree was compiled against ABI ${abi} (jinx ${(cfg.jinx ?? "?").slice(0, 7)}): the site and the tree are out of step, redeploy the site against the current tree`,
    );
  }
}

async function fetchNames(url: string): Promise<string[] | null> {
  try {
    const res = (await fetch(url)) as unknown as FetchResponse;
    return res.ok ? ((await res.json()) as string[]) : null;
  } catch {
    return null;
  }
}

// The package set, evaluated on first use:
// import /src { system = ...; config = {}; overlays = []; }
function packageSet(): nix.Attrs {
  if (pkgs !== null) {
    return pkgs;
  }
  const started = performance.now();
  const importFn = nix.getAttr(nix.builtins, "import") as (
    p: nix.Lazy,
  ) => nix.Value;
  const nixpkgs = importFn(SRC_ROOT);
  const set = nix.app(nixpkgs, {
    system: nix.settings.currentSystem,
    config: {},
    overlays: [],
  });
  pkgs = nix.forceAttrs(set);
  postMessage({ type: "set", millis: performance.now() - started });
  return pkgs;
}

interface Result {
  readonly type: "result";
  readonly attr: string;
  readonly name: string;
  readonly drvPath: string;
  readonly outPath: string;
  readonly outputs: Record<string, string>;
  // "<file>:<line>" under the source root, from meta.position, or null.
  readonly position: string | null;
  readonly millis: number;
}

function str(v: nix.Lazy): string {
  return nix.strValue(nix.forceStr(v));
}

// meta.position is "<abs file>:<line>"; the page wants it relative to the
// nixpkgs root. When a package has no meta.position, the pkgs/by-name
// file of a top-level attribute's name stands in when there is one.
function positionOf(attr: string, pkg: nix.Attrs): string | null {
  const meta = nix.getAttr(pkg, "meta");
  const m = meta === undefined ? null : nix.force(meta);
  const pos =
    m !== null && nix.isAttrs(m) ? nix.getAttr(m, "position") : undefined;
  if (pos !== undefined && nix.force(pos) !== null) {
    const p = str(pos);
    const prefix = `${SRC_ROOT}/`;
    return p.startsWith(prefix) ? p.slice(prefix.length) : p;
  }
  if (attr.includes(".")) {
    return null;
  }
  const byName = `${BY_NAME_DIR}/${attr.slice(0, BY_NAME_SHARD_LENGTH)}/${attr}/${BY_NAME_FILE}`;
  return existsSync(`${SRC_ROOT}/${byName}`) ? byName : null;
}

function evaluate(attr: string): Result {
  const started = performance.now();
  const v = nix.sel(packageSet(), ...attr.split("."));
  if (!nix.isAttrs(v)) {
    throw new nix.NixError(`'${attr}' is not a derivation`);
  }
  const drvPath = str(nix.sel(v, "drvPath"));
  const outPath = str(nix.sel(v, "outPath"));
  const name = str(nix.sel(v, "name"));
  const outputs: Record<string, string> = {};
  for (const o of nix.forceList(nix.sel(v, "outputs"))) {
    const outputName = str(o);
    outputs[outputName] = str(nix.sel(v, outputName, "outPath"));
  }
  return {
    type: "result",
    attr,
    name,
    drvPath,
    outPath,
    outputs,
    position: positionOf(attr, v),
    millis: performance.now() - started,
  };
}

self.onmessage = (ev) => {
  const msg = ev.data;
  try {
    if (msg.type === "init") {
      init(msg).catch((e: unknown) => {
        postMessage({ type: "error", attr: null, error: describeError(e) });
      });
      return;
    }
    const attr = msg.attr;
    (hotPrefetch ?? Promise.resolve())
      .then(() =>
        fileLists === null
          ? undefined
          : fileLists.prefetchFor(attr, (done, total) =>
              postMessage({ type: "fetching", attr, done, total }),
            ),
      )
      .then(() => {
        const result = evaluate(attr);
        postMessage({ ...result, ...activity() });
      })
      .catch((e: unknown) => {
        progress(true);
        postMessage({ type: "error", attr, error: describeError(e) });
      });
  } catch (e) {
    progress(true);
    postMessage({
      type: "error",
      attr: msg.type === "eval" ? msg.attr : null,
      error: describeError(e),
    });
  }
};
