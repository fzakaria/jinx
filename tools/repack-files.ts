// Renumber a published tree's per-attribute file lists against its
// current index. A list holds file ids, each a file's position in a walk
// of the tree and source indexes (src/browser/file-ids.ts), so a tree
// whose index was written again with files added or removed has lists
// that name the wrong files. Given the indexes the lists were packed
// against, every id becomes its path and then its id in the current
// index; a path the current index lacks is dropped.
//
//   node tools/repack-files.ts <tree> --from <dir>
//
// <dir> holds the tree-index.json and src-index.json the lists match.
// Rewrites .jinx/files/<shard>.json and common.json in place.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  COMMON_FILE,
  FILES_DIR,
  type IndexDir,
  fileIds,
} from "../src/browser/file-ids.ts";

const TREE_INDEX = "tree-index.json";
const SRC_INDEX = "src-index.json";
const JINX_DIR = ".jinx";
const SHARD_SUFFIX = ".json";
const FROM_FLAG = "--from";
const USAGE = "usage: node tools/repack-files.ts <tree> --from <dir>";

// The id each old id has in the new numbering, for the paths both have.
export function renumbering(
  from: readonly string[],
  to: readonly string[],
): Map<number, number> {
  const idOf = new Map<string, number>();
  to.forEach((p, id) => idOf.set(p, id));
  const out = new Map<number, number>();
  from.forEach((p, id) => {
    const n = idOf.get(p);
    if (n !== undefined) {
      out.set(id, n);
    }
  });
  return out;
}

// A list in the new numbering, each id once, in the order first seen;
// ids with no path in the new index are left out.
export function renumber(
  ids: readonly number[],
  map: ReadonlyMap<number, number>,
): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const id of ids) {
    const n = map.get(id);
    if (n !== undefined && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

function readIndexes(dir: string): string[] {
  const read = (f: string) =>
    JSON.parse(readFileSync(join(dir, f), "utf8")) as IndexDir;
  return fileIds(read(TREE_INDEX), read(SRC_INDEX));
}

function main(): void {
  const argv = process.argv.slice(2);
  const at = argv.indexOf(FROM_FLAG);
  const tree = argv.find((a, i) => i !== at && i !== at + 1);
  const from = at < 0 ? undefined : argv[at + 1];
  if (tree === undefined || from === undefined) {
    process.stderr.write(`${USAGE}\n`);
    process.exit(2);
  }
  const root = resolve(tree);
  const map = renumbering(
    readIndexes(resolve(from)),
    readIndexes(join(root, JINX_DIR)),
  );
  const dir = join(root, FILES_DIR);
  let entries = 0;
  let dropped = 0;
  let attributes = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(SHARD_SUFFIX)) {
      continue;
    }
    const file = join(dir, name);
    if (name === COMMON_FILE) {
      const ids = JSON.parse(readFileSync(file, "utf8")) as number[];
      const fixed = renumber(ids, map).sort((a, b) => a - b);
      entries += ids.length;
      dropped += ids.length - fixed.length;
      writeFileSync(file, JSON.stringify(fixed) + "\n");
      continue;
    }
    const shard = JSON.parse(readFileSync(file, "utf8")) as Record<
      string,
      number[]
    >;
    const out: Record<string, number[]> = {};
    for (const [attr, ids] of Object.entries(shard)) {
      const fixed = renumber(ids, map);
      entries += ids.length;
      dropped += ids.length - fixed.length;
      out[attr] = fixed;
      attributes++;
    }
    writeFileSync(file, JSON.stringify(out) + "\n");
  }
  console.error(
    `${entries} entries over ${attributes} attributes renumbered, ${dropped} dropped`,
  );
}

// Run as a script; importing the module for its functions does nothing.
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
