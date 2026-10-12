// The playground's evaluator for snippets that reach into nixpkgs: the
// compiler and runtime of src/browser/playground.ts over the compiled
// nixpkgs served by HTTP, the way src/browser/nixpkgs-worker.ts runs it.
// `<nixpkgs>` resolves to the tree's source root. The page sends:
//
//   { type: "init", treeUrl, srcUrl, treeIndexUrl, srcIndexUrl, filesUrl?, hotUrl? }
//   { type: "eval", code, mappings?, files? }
//
// and receives { type: "ready" }, { type: "fetching", done, total },
// { type: "log", line } and { type: "result", ...EvalResult | Failure }.
// `files` names a per-attribute list of the tree (.jinx/files) to fetch
// in parallel before evaluating.

import * as nix from "../runtime/index.ts";
import { evaluate, type EvaluateOptions } from "./playground.ts";
import {
  type FetchResponse,
  type IndexDir,
  fetchSync,
  mount,
  prefetch,
  urlOf,
} from "./shims/fs-remote.ts";
import { FileLists } from "./file-lists.ts";
import { setRuntime } from "./shims/module-remote.ts";

const TREE_ROOT = "/tree";
const SRC_ROOT = "/src";
const COREPKGS_OUT = `${TREE_ROOT}/.jinx/corepkgs`;
const COREPKGS_SRC = `${TREE_ROOT}/.jinx/runtime/corepkgs`;
const NIXPKGS_PREFIX = "nixpkgs";
const PREFETCH_CONCURRENCY = 32;
// Derivations sent back to the page at most; a package's closure has
// hundreds, and the page shows the first of them.
const DERIVATIONS_REPORTED = 100;

declare function postMessage(message: unknown): void;
declare const self: {
  onmessage: ((ev: { readonly data: Incoming }) => void) | null;
};

if (typeof globalThis.process === "undefined") {
  (globalThis as { process?: unknown }).process = { env: {} };
}

interface InitMessage {
  readonly type: "init";
  readonly treeUrl: string;
  readonly srcUrl: string;
  readonly treeIndexUrl: string;
  readonly srcIndexUrl: string;
  readonly filesUrl?: string;
  readonly hotUrl?: string;
}

interface EvalMessage {
  readonly type: "eval";
  readonly code: string;
  readonly mappings?: EvaluateOptions["mappings"];
  readonly files?: string;
}

type Incoming = InitMessage | EvalMessage;

interface FileList {
  readonly tree: readonly string[];
  readonly src: readonly string[];
}

let fileLists: FileLists | null = null;
let hotPrefetch: Promise<void> = Promise.resolve();

function loadIndex(url: string): IndexDir {
  return JSON.parse(new TextDecoder().decode(fetchSync(url))) as IndexDir;
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = (await fetch(url)) as unknown as FetchResponse;
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

function paths(list: FileList): string[] {
  return [
    ...list.tree.map((p) => `${TREE_ROOT}/${p}`),
    ...list.src.map((p) => `${SRC_ROOT}/${p}`),
  ];
}

function progress(done: number, total: number): void {
  postMessage({ type: "fetching", done, total });
}

async function prefetchHot(url: string): Promise<void> {
  const hot = await fetchJson<FileList>(url);
  if (hot !== null) {
    await prefetch(paths(hot), PREFETCH_CONCURRENCY, progress);
  }
}

// The tree's modules were compiled against an ABI; this runtime has to
// match (src/browser/nixpkgs-worker.ts makes the same check).
const TREE_CONFIG = `${TREE_ROOT}/.jinx/config.json`;
function checkAbi(): void {
  const cfg = JSON.parse(
    new TextDecoder().decode(fetchSync(urlOf(TREE_CONFIG))),
  ) as { abi?: number; jinx?: string };
  const abi = cfg.abi ?? 1;
  if (abi !== nix.ABI) {
    throw new Error(
      `this page's runtime is ABI ${nix.ABI} but the tree was compiled against ABI ${abi} (jinx ${(cfg.jinx ?? "?").slice(0, 7)}): the site and the tree are out of step`,
    );
  }
}

function init(msg: InitMessage): void {
  const treeIndex = loadIndex(msg.treeIndexUrl);
  const srcIndex = loadIndex(msg.srcIndexUrl);
  mount(TREE_ROOT, msg.treeUrl, treeIndex);
  mount(SRC_ROOT, msg.srcUrl, srcIndex);
  checkAbi();
  if (msg.filesUrl !== undefined) {
    fileLists = new FileLists(
      msg.filesUrl,
      TREE_ROOT,
      SRC_ROOT,
      treeIndex,
      srcIndex,
    );
  }
  setRuntime(nix);
  nix.registerTree(COREPKGS_OUT, COREPKGS_SRC);
  nix.registerTree(TREE_ROOT, SRC_ROOT);
  nix.settings.nixPath = [{ prefix: NIXPKGS_PREFIX, path: SRC_ROOT }];
  nix.settings.log = (line) => postMessage({ type: "log", line });
  postMessage({ type: "ready" });
  if (msg.hotUrl !== undefined) {
    hotPrefetch = prefetchHot(msg.hotUrl);
  }
}

async function run(msg: EvalMessage): Promise<void> {
  await hotPrefetch;
  if (msg.files !== undefined && fileLists !== null) {
    await fileLists.prefetchFor(msg.files, progress);
  }
  const result = evaluate(
    msg.code,
    msg.mappings === undefined ? {} : { mappings: msg.mappings },
  );
  if (!result.ok) {
    postMessage({ type: "result", ...result });
    return;
  }
  postMessage({
    type: "result",
    ...result,
    derivationCount: result.derivations.length,
    derivations: result.derivations.slice(0, DERIVATIONS_REPORTED),
  });
}

self.onmessage = (ev) => {
  const msg = ev.data;
  if (msg.type === "init") {
    init(msg);
    return;
  }
  run(msg).catch((e: unknown) => {
    postMessage({
      type: "result",
      ok: false,
      error: e instanceof Error ? (e.stack ?? e.message) : String(e),
    });
  });
};
