// Index a directory tree for the browser: one JSON document that answers
// readdir, exists and lstat for every path under the root, so the page
// fetches only files it knows exist.
//
//   node tools/index-tree.ts <dir> <out.json> [--skip <name>]...
//
// --skip leaves a top-level entry out, such as the nixpkgs symlink of a
// published tree. --modules keeps only the compiled modules and their
// source maps, plus the runtime, corepkgs and config under .jinx: the
// per-attribute lists number files by their position in this index
// (src/browser/file-ids.ts), so the index of a published tree must
// depend on the compiled output alone, not on the README, the parity
// report or the version control state next to it.
//
// The format is what src/browser/shims/fs-remote.ts reads. A directory is
// an object from entry name to entry, and the entry's JSON type says what
// it is:
//
//   number     a regular file, the number its size in bytes
//   [number]   a regular executable file, the number its size in bytes
//   string     a symlink, the string its target
//   object     a directory
//
// Symlinks are recorded, not followed, as lstat and the NAR serialisation
// see them.
import { lstatSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MODE_ANY_EXECUTE = 0o111;

export type IndexEntry = number | [number] | string | IndexDir;
export interface IndexDir {
  [name: string]: IndexEntry;
}

// The index of one directory: its entries, recursively.
export function indexDir(dir: string): IndexDir {
  const out: IndexDir = {};
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) {
      out[name] = readlinkSync(p);
      continue;
    }
    if (st.isDirectory()) {
      out[name] = indexDir(p);
      continue;
    }
    if (st.isFile()) {
      out[name] = (st.mode & MODE_ANY_EXECUTE) !== 0 ? [st.size] : st.size;
      continue;
    }
    // Sockets, devices and the like are left out.
  }
  return out;
}

const SKIP_FLAG = "--skip";
const MODULES_FLAG = "--modules";
const JINX_DIR = ".jinx";
const JINX_KEPT = new Set(["runtime", "corepkgs", "config.json"]);
const MODULE_SUFFIXES = [".ts", ".ts.map"];

const positional: string[] = [];
const skip = new Set<string>();
let modules = false;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === SKIP_FLAG) {
    skip.add(argv[++i] ?? "");
    continue;
  }
  if (argv[i] === MODULES_FLAG) {
    modules = true;
    continue;
  }
  positional.push(argv[i]);
}
const [dir, outFile] = positional;
if (dir === undefined || outFile === undefined) {
  process.stderr.write(
    "usage: node tools/index-tree.ts <dir> <out.json> [--skip <name>]... [--modules]\n",
  );
  process.exit(2);
}
// The entries of a directory that are modules or hold modules; an empty
// directory goes.
export function modulesOnly(d: IndexDir): IndexDir {
  const out: IndexDir = {};
  for (const [name, entry] of Object.entries(d)) {
    if (typeof entry === "object" && !Array.isArray(entry)) {
      const sub = modulesOnly(entry);
      if (Object.keys(sub).length > 0) {
        out[name] = sub;
      }
      continue;
    }
    if (MODULE_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
      out[name] = entry;
    }
  }
  return out;
}

const index = indexDir(dir);
if (modules) {
  const jinx = index[JINX_DIR];
  for (const name of Object.keys(index)) {
    if (name === JINX_DIR) {
      continue;
    }
    const entry = index[name]!;
    if (typeof entry === "object" && !Array.isArray(entry)) {
      const sub = modulesOnly(entry);
      if (Object.keys(sub).length > 0) {
        index[name] = sub;
      } else {
        delete index[name];
      }
    } else if (!MODULE_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
      delete index[name];
    }
  }
  if (jinx !== undefined && typeof jinx === "object" && !Array.isArray(jinx)) {
    for (const name of Object.keys(jinx)) {
      if (!JINX_KEPT.has(name)) {
        delete jinx[name];
      }
    }
  }
}
for (const name of skip) {
  delete index[name];
}
const json = JSON.stringify(index);
writeFileSync(outFile, json);
process.stderr.write(`${outFile}: ${json.length} bytes\n`);
