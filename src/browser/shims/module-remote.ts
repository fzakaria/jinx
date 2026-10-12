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
import { readFileSync, urlOf } from "./fs-remote.ts";

const FILE_URL_PREFIX = "file://";
const RUNTIME_IMPORT = /^import \* as nix from "[^"]*";\s*$/m;
const DEFAULT_EXPORT = /^export default /m;
const IMPORT_META = /\bimport\.meta\b/g;
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

type CompiledModule = (
  rt: unknown,
  meta: { url: string },
) => unknown;

function load(p: string): { default: unknown } {
  const cached = modules.get(p);
  if (cached !== undefined) {
    return cached;
  }
  if (runtime === null) {
    throw new Error("internal: module-remote: setRuntime was not called");
  }
  const text = readFileSync(p, "utf8") as string;
  const body = text
    .replace(RUNTIME_IMPORT, "")
    .replace(DEFAULT_EXPORT, "return ")
    .replace(IMPORT_META, IMPORT_META_PARAM);
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
