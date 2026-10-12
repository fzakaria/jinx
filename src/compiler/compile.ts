// The compiler driver: one Nix file to one TypeScript file, or a whole
// tree to its mirror. Also the on-demand hook the runtime's import() uses
// in `jinx eval`, so a file can be evaluated without compiling its
// neighbourhood first.

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../syntax/parser.ts";
import { emit, emitModule } from "./emit.ts";

// Where the runtime lives in this checkout.
export const RUNTIME_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../runtime",
);

const CONFIG_DIR = ".jinx";

export interface TreeOptions {
  readonly srcRoot: string;
  readonly outRoot: string;
  // Copy the runtime into <out>/.jinx/runtime so the tree stands alone.
  // By default it is a symlink to this checkout's runtime: node resolves
  // symlinks to real paths, so the tree and the jinx CLI then share one
  // runtime instance, which is what lets the CLI evaluate the tree.
  readonly vendorRuntime?: boolean;
}

// Prepare an output tree: its config and its runtime.
export function prepareTree(opts: TreeOptions): void {
  const out = resolve(opts.outRoot);
  const cfgDir = join(out, CONFIG_DIR);
  mkdirSync(cfgDir, { recursive: true });
  const runtime = join(cfgDir, "runtime");
  if (opts.vendorRuntime === true) {
    if (existsSync(runtime) && lstatSync(runtime).isSymbolicLink()) {
      rmSync(runtime);
    }
    if (
      !existsSync(runtime) ||
      statSync(runtime).mtimeMs < newestMtime(RUNTIME_DIR)
    ) {
      cpSync(RUNTIME_DIR, runtime, {
        recursive: true,
        filter: (p) => !p.endsWith(".test.ts"),
      });
    }
  } else if (!existsSync(runtime)) {
    symlinkSync(RUNTIME_DIR, runtime);
  } else if (!lstatSync(runtime).isSymbolicLink()) {
    rmSync(runtime, { recursive: true });
    symlinkSync(RUNTIME_DIR, runtime);
  }
  writeFileSync(
    join(cfgDir, "config.json"),
    JSON.stringify(
      { srcRoot: relative(out, resolve(opts.srcRoot)) || "." },
      null,
      2,
    ) + "\n",
  );
}

function newestMtime(dir: string): number {
  let newest = 0;
  for (const name of readdirSync(dir)) {
    const st = statSync(join(dir, name));
    newest = Math.max(
      newest,
      st.isDirectory() ? newestMtime(join(dir, name)) : st.mtimeMs,
    );
  }
  return newest;
}

// The output path of a source file in a tree.
export function outputPathFor(opts: TreeOptions, nixFile: string): string {
  const rel = relative(resolve(opts.srcRoot), resolve(nixFile));
  if (rel.startsWith("..")) {
    throw new Error(`${nixFile} is outside the source root ${opts.srcRoot}`);
  }
  return join(resolve(opts.outRoot), rel.replace(/\.nix$/, "") + ".ts");
}

// Compile one file into its place in the tree. Returns the output path.
export function compileFile(opts: TreeOptions, nixFile: string): string {
  const file = resolve(nixFile);
  const out = outputPathFor(opts, file);
  const runtimeImport = relative(
    dirname(out),
    join(resolve(opts.outRoot), CONFIG_DIR, "runtime", "index.ts"),
  );
  const src = readFileSync(file, "utf8");
  const ast = parse(src, file);
  const base = out.slice(out.lastIndexOf("/") + 1);
  // The map sits next to the module and names the Nix file relative to it.
  const { typescript, sourceMap } = emit(ast, {
    file,
    runtimeImport:
      runtimeImport.startsWith("./") || runtimeImport.startsWith("../")
        ? runtimeImport
        : "./" + runtimeImport,
    sourceMap: {
      url: `${base}.map`,
      sourceRelative: relative(dirname(out), file),
    },
  });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, typescript);
  if (sourceMap !== null) {
    writeFileSync(`${out}.map`, sourceMap);
  }
  return out;
}

// Compile a file to a string, for inspection.
export function compileToString(
  nixFile: string,
  runtimeImport = "jinx/runtime",
): string {
  const file = resolve(nixFile);
  const ast = parse(readFileSync(file, "utf8"), file);
  return emitModule(ast, { file, runtimeImport });
}

export interface TreeReport {
  compiled: number;
  failed: { file: string; error: string }[];
}

// Compile every .nix file under the source root.
export function compileTree(
  opts: TreeOptions,
  onProgress?: (done: number) => void,
): TreeReport {
  prepareTree(opts);
  const report: TreeReport = { compiled: 0, failed: [] };
  for (const file of walkNix(resolve(opts.srcRoot))) {
    try {
      compileFile(opts, file);
      report.compiled++;
    } catch (e) {
      report.failed.push({
        file,
        error: e instanceof Error ? e.message : String(e),
      });
    }
    if (
      onProgress !== undefined &&
      (report.compiled + report.failed.length) % 1000 === 0
    ) {
      onProgress(report.compiled + report.failed.length);
    }
  }
  return report;
}

export function* walkNix(dir: string): Generator<string> {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    if (name.isDirectory()) {
      yield* walkNix(p);
    } else if (name.isFile() && name.name.endsWith(".nix")) {
      yield p;
    }
  }
}

// Whether the compiled output is older than its source (or missing).
export function isStale(opts: TreeOptions, nixFile: string): boolean {
  const out = outputPathFor(opts, nixFile);
  if (!existsSync(out)) {
    return true;
  }
  return statSync(out).mtimeMs < statSync(nixFile).mtimeMs;
}
