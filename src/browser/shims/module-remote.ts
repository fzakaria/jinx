// node:module for the nixpkgs worker: require() of a compiled module
// fetches its text through the remote filesystem and evaluates it. The
// emitter writes plain JavaScript under a .ts name (no type annotations),
// so a module needs only two rewrites to run as a function: its
// `import * as nix from ".../.jinx/runtime/index.ts"` line becomes the
// `nix` parameter, bound to the runtime bundled into the worker, and its
// `export default` becomes a return. `import.meta` becomes a parameter
// too, so `nix.here(import.meta.url)` sees the module's virtual path.
// Modules are evaluated once and kept, which is what makes `import` lazy
// and shared, as in Nix.
import { existsSync, lstatSync, readFileSync, urlOf } from "./fs-remote.ts";

const FILE_URL_PREFIX = "file://";
const RUNTIME_IMPORT = /^import \* as nix from "[^"]*";\s*$/m;
const DEFAULT_EXPORT = /^export default /m;
const IMPORT_META = /\bimport\.meta\b/g;
// The type a literal import carries for editors; `new Function` takes
// JavaScript, so the cast goes.
const IMPORT_TYPE = / as nix\.Imported<typeof import\("[^"]*"\)>/g;
const IMPORT_META_PARAM = "importMeta";
const RUNTIME_PARAM = "nix";

// The runtime the compiled modules import, set by the worker before the
// first import; a parameter rather than an import so this shim and the
// runtime do not import each other.
let runtime: unknown = null;

export function setRuntime(rt: unknown): void {
  runtime = rt;
}

// Evaluated modules by absolute path.
const modules = new Map<string, { default: unknown }>();
let loadListener: ((path: string) => void) | null = null;

export function modulesLoaded(): number {
  return modules.size;
}

// Called after every module evaluated, so a worker can stream progress.
export function onLoad(cb: (path: string) => void): void {
  loadListener = cb;
}

type CompiledModule = (rt: unknown, meta: { url: string }) => unknown;

// The relative paths a compiled module names: `nix.path(here, "./x.nix")`
// for an import, a callPackage argument, a patch or a script.
const STATIC_PATH = /nix\.path\(here, "(\.\.?\/[^"]*)"\)/g;
const NIX_SUFFIX = ".nix";
const MODULE_SUFFIX = ".ts";
const DEFAULT_MODULE = "default.ts";

// The out root and the source root the modules are mounted at, for
// turning a source path into its compiled module.
let roots: { readonly tree: string; readonly src: string } | null = null;
let importsListener: ((urls: string[]) => void) | null = null;

// Report the URLs a module will read next, so a page can fetch them in
// parallel into the HTTP cache while the evaluation is busy.
export function onImports(
  tree: string,
  src: string,
  cb: (urls: string[]) => void,
): void {
  roots = { tree, src };
  importsListener = cb;
}

function dirname(p: string): string {
  const slash = p.lastIndexOf("/");
  return slash <= 0 ? "/" : p.slice(0, slash);
}

function normalize(p: string): string {
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return "/" + out.join("/");
}

// The files the paths named in `text` lead to: a .nix file or a
// directory means its compiled module, anything else the source file.
function predictedUrls(modulePath: string, text: string): string[] {
  if (roots === null || !modulePath.startsWith(roots.tree + "/")) {
    return [];
  }
  const srcDir = roots.src + dirname(modulePath.slice(roots.tree.length));
  const urls: string[] = [];
  for (const m of text.matchAll(STATIC_PATH)) {
    const srcPath = normalize(srcDir + "/" + m[1]!);
    if (!existsSync(srcPath)) {
      continue;
    }
    const rel = srcPath.slice(roots.src.length);
    let target: string;
    if (lstatSync(srcPath).isDirectory()) {
      target = `${roots.tree}${rel}/${DEFAULT_MODULE}`;
    } else if (srcPath.endsWith(NIX_SUFFIX)) {
      target = `${roots.tree}${rel.slice(0, -NIX_SUFFIX.length)}${MODULE_SUFFIX}`;
    } else {
      target = srcPath;
    }
    if (existsSync(target)) {
      urls.push(urlOf(target));
    }
  }
  return urls;
}

function load(p: string): { default: unknown } {
  const cached = modules.get(p);
  if (cached !== undefined) {
    return cached;
  }
  if (runtime === null) {
    throw new Error("internal: module-remote: setRuntime was not called");
  }
  const text = readFileSync(p, "utf8") as string;
  if (importsListener !== null) {
    const urls = predictedUrls(p, text);
    if (urls.length > 0) {
      importsListener(urls);
    }
  }
  const body = text
    .replace(RUNTIME_IMPORT, "")
    .replace(DEFAULT_EXPORT, "return ")
    .replace(IMPORT_META, IMPORT_META_PARAM)
    .replace(IMPORT_TYPE, "");
  // The sourceURL names the module in stack traces and in DevTools.
  const fn = new Function(
    RUNTIME_PARAM,
    IMPORT_META_PARAM,
    `${body}\n//# sourceURL=${urlOf(p)}`,
  ) as CompiledModule;
  const mod = { default: fn(runtime, { url: FILE_URL_PREFIX + p }) };
  modules.set(p, mod);
  if (loadListener !== null) {
    loadListener(p);
  }
  return mod;
}

export function createRequire(): (p: string) => unknown {
  return load;
}

// node:module's registerHooks, which the runtime calls only when present.
export const registerHooks = undefined;
