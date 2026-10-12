// Index a directory tree for the browser: one JSON document that answers
// readDir, pathExists and lstat for every path under the root, so the
// page knows what exists before it fetches anything.
//
//   node tools/index-tree.ts <dir> <out.json>
//
// The format is the one src/browser/shims/fs-remote.ts reads. nixpkgs has
// ~100k entries, so it is kept compact: a directory is an object from
// entry name to entry, and the entry's JSON type says what it is.
//
//   number     a regular file, the number its size in bytes
//   [number]   a regular executable file, the number its size in bytes
//   string     a symlink, the string its target
//   object     a directory
//
// Nothing is followed: a symlink is recorded as a symlink, as lstat and
// the NAR serialisation see it.
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
      out[name] =
        (st.mode & MODE_ANY_EXECUTE) !== 0 ? [st.size] : st.size;
      continue;
    }
    // Sockets, devices and the like: not in a source tree, and nothing
    // the runtime could read, so they are left out.
  }
  return out;
}

const [dir, outFile] = process.argv.slice(2);
if (dir === undefined || outFile === undefined) {
  process.stderr.write("usage: node tools/index-tree.ts <dir> <out.json>\n");
  process.exit(2);
}
const index = indexDir(dir);
const json = JSON.stringify(index);
writeFileSync(outFile, json);
process.stderr.write(`${outFile}: ${json.length} bytes\n`);
