// Evaluate a Nix file through the compiled tree. Used by `jinx eval`, the
// corpus runner and the conformance adapter.

import { createRequire, enableCompileCache } from "node:module";
import { dirname, join, resolve } from "node:path";
import {
  compileFile,
  isStale,
  outputPathFor,
  prepareTree,
  type TreeOptions,
} from "../compiler/compile.ts";
import { readFileSync } from "node:fs";
import { registerTree, setCompileHook } from "../runtime/modules.ts";
import { builtins, settings } from "../runtime/builtins.ts";
import { app, forceAttrs, sel } from "../runtime/ops.ts";
import {
  type Attrs,
  type Lazy,
  type Value,
  force,
  getAttr,
} from "../runtime/value.ts";

export interface EvalOptions {
  // The output tree. Defaults to a cache mirroring the whole filesystem
  // so that any absolute import resolves.
  readonly outRoot: string;
  readonly system?: string;
  // Trees compiled ahead of time (`jinx compile --out`), consulted before
  // the cache so their modules are never recompiled.
  readonly trees?: readonly string[];
}

const CACHE_ROOT = resolve(
  process.env["XDG_CACHE_HOME"] ?? `${process.env["HOME"] ?? "/tmp"}/.cache`,
  "jinx",
);
export const DEFAULT_CACHE = join(CACHE_ROOT, "fs");

// V8's compiled code for every module loaded, kept across runs by node's
// compile cache: a warm evaluation otherwise strips and parses every
// compiled module again, which was four tenths of firefox.drvPath.
// Called before any compiled module loads; the compiler's own modules
// are already in, and are few.
export function enableCodeCache(): void {
  enableCompileCache(join(CACHE_ROOT, "compile-cache"));
}

// Set up on-demand compilation into the cache tree.
export function setup(opts: EvalOptions): void {
  enableCodeCache();
  for (const dir of opts.trees ?? []) {
    const out = resolve(dir);
    const cfg = JSON.parse(
      readFileSync(join(out, ".jinx", "config.json"), "utf8"),
    ) as { srcRoot: string };
    registerTree(out, resolve(out, cfg.srcRoot));
  }
  const tree: TreeOptions = { srcRoot: "/", outRoot: opts.outRoot };
  prepareTree(tree);
  registerTree(tree.outRoot, tree.srcRoot);
  // Compile a module when it is missing or older than its source.
  setCompileHook((t, nixFile) => {
    const topts: TreeOptions = { srcRoot: t.srcRoot, outRoot: t.outRoot };
    if (isStale(topts, nixFile)) {
      return compileFile(topts, nixFile);
    }
    return outputPathFor(topts, nixFile);
  });
  if (opts.system !== undefined) {
    settings.currentSystem = opts.system;
  }
}

const requireFromHere = createRequire(import.meta.url);

// The value of a file, with `-A attr.path` applied and `--arg`s passed if
// the file evaluates to a function.
export function evaluateFile(
  file: string,
  attrPath: string[],
  args: Attrs | null,
): Value {
  const abs = resolve(file);
  let v: Value = force(
    (getAttr(builtins, "import") as (p: Lazy) => Value)(abs),
  );
  if (args !== null) {
    if (typeof v !== "function") {
      throw new Error(
        "--arg given but the file does not evaluate to a function",
      );
    }
    v = app(v, args);
  } else if (
    typeof v === "function" &&
    (v as { formals?: { args: Record<string, boolean>; ellipsis: boolean } })
      .formals !== undefined
  ) {
    // Like nix-instantiate: a function taking a set is called with the
    // defaults it can fill in itself (autocall).
    const formals = (
      v as { formals: { args: Record<string, boolean>; ellipsis: boolean } }
    ).formals;
    if (Object.values(formals.args).every((hasDefault) => hasDefault)) {
      v = app(v, {});
    }
  }
  for (const name of attrPath) {
    v = sel(v, name);
  }
  return v;
}

export { dirname, forceAttrs };
