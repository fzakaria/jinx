// `import`: from a Nix path to the TypeScript module compiled from it.
//
// A compiled tree mirrors its source tree: `<src>/pkgs/a/default.nix`
// becomes `<out>/pkgs/a/default.ts`, and `<out>/.jinx/config.json` says
// where `<src>` is. Loading goes through require(), which is synchronous
// and memoised per file, which is exactly Nix's import: lazy, evaluated
// once, shared by every importer.

import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Lazy, type Value, NixError, Path, force } from "./value.ts";

interface Tree {
  readonly outRoot: string;
  readonly srcRoot: string;
}

const CONFIG_DIR = ".jinx";
const CONFIG_FILE = "config.json";

// Every compiled tree seen so far, by its out root.
const trees: Tree[] = [];

// Register a compiled tree so paths under its source root can be imported.
export function registerTree(outRoot: string, srcRoot: string): void {
  const out = resolve(outRoot);
  if (trees.some((t) => t.outRoot === out)) {
    return;
  }
  trees.push({ outRoot: out, srcRoot: resolve(srcRoot) });
}

// Find the tree a compiled module belongs to by walking up to its config.
function treeOfModule(moduleDir: string): Tree {
  for (const t of trees) {
    if (moduleDir === t.outRoot || moduleDir.startsWith(t.outRoot + "/")) {
      return t;
    }
  }
  let dir = moduleDir;
  for (;;) {
    const cfg = join(dir, CONFIG_DIR, CONFIG_FILE);
    if (existsSync(cfg)) {
      const parsed = JSON.parse(readFileSync(cfg, "utf8")) as {
        srcRoot: string;
      };
      const srcRoot = resolve(dir, parsed.srcRoot);
      registerTree(dir, srcRoot);
      return { outRoot: dir, srcRoot };
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `internal: no ${CONFIG_DIR}/${CONFIG_FILE} above ${moduleDir}`,
      );
    }
    dir = parent;
  }
}

// The source directory of a compiled module: what `./` means in it.
export function here(importMetaUrl: string): string {
  const moduleDir = dirname(fileURLToPath(importMetaUrl));
  const tree = treeOfModule(moduleDir);
  const rel = relative(tree.outRoot, moduleDir);
  return rel === "" ? tree.srcRoot : join(tree.srcRoot, rel);
}

// Resolve a Nix path to the .nix file it names: a directory means its
// default.nix.
export function resolveNixFile(p: string): string {
  let file = p;
  try {
    if (statSync(file).isDirectory()) {
      file = join(file, "default.nix");
    }
  } catch {
    throw new NixError(`path '${p}' does not exist`);
  }
  return file;
}

// `jinx eval` compiles on demand: the hook returns the compiled module for
// a source file, writing it if it is missing or stale.
export type CompileHook = (
  tree: { outRoot: string; srcRoot: string },
  nixFile: string,
) => string;

let compileHook: CompileHook | null = null;

export function setCompileHook(hook: CompileHook | null): void {
  compileHook = hook;
}

function compiledModuleFor(nixFile: string): string {
  for (const t of trees) {
    if (nixFile.startsWith(t.srcRoot === "/" ? "/" : t.srcRoot + "/")) {
      if (compileHook !== null) {
        return compileHook(t, nixFile);
      }
      const rel = relative(t.srcRoot, nixFile);
      const ts = join(t.outRoot, rel.replace(/\.nix$/, "") + ".ts");
      if (!existsSync(ts)) {
        throw new NixError(
          `'${nixFile}' has not been compiled (expected ${ts}); run jinx compile`,
        );
      }
      return ts;
    }
  }
  throw new NixError(
    `cannot import '${nixFile}': it is outside every compiled tree (jinx does not evaluate Nix at runtime, and import-from-derivation is not supported)`,
  );
}

const requireFromHere = createRequire(import.meta.url);

// builtins.import
export function importPath(arg: Lazy): Value {
  const v = force(arg);
  let p: string;
  if (v instanceof Path) {
    p = v.path;
  } else if (typeof v === "string") {
    p = v;
  } else if (typeof v === "object" && v !== null && "s" in v) {
    p = String(v.s);
  } else {
    throw new NixError("import expects a path");
  }
  if (!p.startsWith("/")) {
    throw new NixError(`string '${p}' doesn't represent an absolute path`);
  }
  const file = resolveNixFile(p);
  const ts = compiledModuleFor(file);
  const mod = requireFromHere(ts) as { default: Lazy };
  return force(mod.default);
}
