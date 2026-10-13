// Pack the per-attribute file lists tools/attr-files.ts and
// tools/record-extra.ts recorded as paths (<tree>/.jinx/files-raw) into
// what the site's workers read (<tree>/.jinx/files): each path an id
// from src/browser/file-ids.ts, the files that at least COMMON_SHARE of
// the attributes read moved to one common.json fetched before any list,
// and the lists without them.
//
//   node tools/pack-files.ts <tree>
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  COMMON_FILE,
  FILES_DIR,
  type IndexDir,
  SRC_PREFIX,
  TREE_PREFIX,
  fileIds,
} from "../src/browser/file-ids.ts";

const RAW_DIR = ".jinx/files-raw";
const TREE_INDEX = ".jinx/tree-index.json";
const SRC_INDEX = ".jinx/src-index.json";
const COMMON_SHARE = 0.3;
const COMMON_USES_FILE = "common-uses.json";

interface Recorded {
  readonly tree: readonly string[];
  readonly src: readonly string[];
}

const tree = process.argv[2];
if (tree === undefined) {
  process.stderr.write("usage: node tools/pack-files.ts <tree>\n");
  process.exit(2);
}

const ids = new Map<string, number>();
fileIds(
  JSON.parse(readFileSync(join(tree, TREE_INDEX), "utf8")) as IndexDir,
  JSON.parse(readFileSync(join(tree, SRC_INDEX), "utf8")) as IndexDir,
).forEach((path, id) => ids.set(path, id));

// Every attribute's ids, by shard, and how many attributes read each file.
const rawDir = join(tree, RAW_DIR);
const shards = new Map<string, Map<string, number[]>>();
const uses = new Map<number, number>();
let attributes = 0;
let unknown = 0;
for (const file of readdirSync(rawDir)) {
  const raw = JSON.parse(readFileSync(join(rawDir, file), "utf8")) as Record<
    string,
    Recorded
  >;
  const packed = new Map<string, number[]>();
  for (const [attr, list] of Object.entries(raw)) {
    const paths = [
      ...list.tree.map((p) => TREE_PREFIX + p),
      ...list.src.map((p) => SRC_PREFIX + p),
    ];
    const listIds: number[] = [];
    for (const p of paths) {
      const id = ids.get(p);
      if (id === undefined) {
        unknown++;
        continue;
      }
      listIds.push(id);
      uses.set(id, (uses.get(id) ?? 0) + 1);
    }
    packed.set(attr, listIds);
    attributes++;
  }
  shards.set(file, packed);
}

const common = new Set<number>();
for (const [id, n] of uses) {
  if (n >= COMMON_SHARE * attributes) {
    common.add(id);
  }
}

const dir = join(tree, FILES_DIR);
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
writeFileSync(
  join(dir, COMMON_FILE),
  JSON.stringify([...common].sort((a, b) => a - b)) + "\n",
);
// How many attributes read each common file, which the lists no longer
// say; tools/nixpkgs-stats.ts reports them.
const commonUses: Record<string, number> = {};
for (const id of [...common].sort((a, b) => a - b)) {
  commonUses[String(id)] = uses.get(id) ?? 0;
}
writeFileSync(join(dir, COMMON_USES_FILE), JSON.stringify(commonUses) + "\n");
let kept = 0;
for (const [file, packed] of shards) {
  const out: Record<string, number[]> = {};
  for (const [attr, listIds] of packed) {
    const rest = listIds.filter((id) => !common.has(id));
    out[attr] = rest;
    kept += rest.length;
  }
  writeFileSync(join(dir, file), JSON.stringify(out) + "\n");
}
process.stderr.write(
  `${FILES_DIR}: ${attributes} attributes in ${shards.size} shards, ${common.size} common files, ` +
    `${(kept / Math.max(attributes, 1)).toFixed(0)} ids per attribute, ${unknown} paths not in the indexes\n`,
);
