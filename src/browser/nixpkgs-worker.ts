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
//   { type: "ready", names, millis, modulesLoaded, filesFetched, bytesFetched }
//   { type: "result", attr, name, drvPath, outPath, outputs, position, ... }
//   { type: "error", attr?, error }

import * as nix from "../runtime/index.ts";
import {
  type IndexDir,
  fetchSync,
  mount,
  onFetch,
  stats as fetchStats,
} from "./shims/fs-remote.ts";
import { modulesLoaded, onLoad, setRuntime } from "./shims/module-remote.ts";

// Where the two trees appear to the runtime. The compiled tree's runtime
// is at /tree/.jinx/runtime, which is also what the bundle's
// import.meta.url is defined as at build time (tools/build-site.sh), so
// `<nix/fetchurl.nix>` resolves under it.
const TREE_ROOT = "/tree";
const SRC_ROOT = "/src";
const COREPKGS_OUT = `${TREE_ROOT}/.jinx/corepkgs`;
const COREPKGS_SRC = `${TREE_ROOT}/.jinx/runtime/corepkgs`;

const DEFAULT_SYSTEM = "x86_64-linux";
const PROGRESS_INTERVAL_MS = 100;
const STACK_LINES_REPORTED = 12;

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
  readonly system?: string;
}

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

function init(msg: InitMessage): void {
  const started = performance.now();
  mount(TREE_ROOT, msg.treeUrl, loadIndex(msg.treeIndexUrl));
  mount(SRC_ROOT, msg.srcUrl, loadIndex(msg.srcIndexUrl));
  setRuntime(nix);
  // The corepkgs tree first: both are under /tree, and a module is
  // matched to the first registered tree whose root is a prefix of it.
  nix.registerTree(COREPKGS_OUT, COREPKGS_SRC);
  nix.registerTree(TREE_ROOT, SRC_ROOT);
  nix.settings.currentSystem = msg.system ?? DEFAULT_SYSTEM;
  nix.settings.log = (line) => postMessage({ type: "log", line });

  // import /src { system = ...; config = {}; overlays = []; }
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
  const names = nix.attrKeys(pkgs).sort();
  postMessage({
    type: "ready",
    names,
    millis: performance.now() - started,
    ...activity(),
  });
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
// nixpkgs root.
function positionOf(pkg: nix.Attrs): string | null {
  const meta = nix.getAttr(pkg, "meta");
  if (meta === undefined) {
    return null;
  }
  const m = nix.force(meta);
  if (!nix.isAttrs(m)) {
    return null;
  }
  const pos = nix.getAttr(m, "position");
  if (pos === undefined) {
    return null;
  }
  const p = str(pos);
  const prefix = `${SRC_ROOT}/`;
  return p.startsWith(prefix) ? p.slice(prefix.length) : p;
}

function evaluate(attr: string): Result {
  if (pkgs === null) {
    throw new Error("the package set has not been evaluated yet");
  }
  const started = performance.now();
  const v = nix.sel(pkgs, ...attr.split("."));
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
    position: positionOf(v),
    millis: performance.now() - started,
  };
}

self.onmessage = (ev: MessageEvent<Incoming>) => {
  const msg = ev.data;
  try {
    if (msg.type === "init") {
      init(msg);
      return;
    }
    const result = evaluate(msg.attr);
    postMessage({ ...result, ...activity() });
  } catch (e) {
    progress(true);
    postMessage({
      type: "error",
      attr: msg.type === "eval" ? msg.attr : null,
      error: describeError(e),
    });
  }
};
