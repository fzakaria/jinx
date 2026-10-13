// What the per-attribute file lists of a published tree say about
// nixpkgs as a whole: which source files no attribute reads, which files
// most attributes read, how many files an attribute needs, and where the
// attributes are defined. The site's stats page shows the result.
//
//   node tools/nixpkgs-stats.ts <tree>
//
// Reads .jinx/{tree-index,src-index,hot,names}.json, .jinx/files/ and
// .jinx/positions/, and writes .jinx/stats.json (the figures and the top
// lists) and .jinx/unread.json (every .nix file no attribute reads).
//
// The lists record what evaluating an attribute's drvPath reads beyond
// hello's files (the hot set), with the files at least 30% of attributes
// read moved to common.json. So a file's count of readers is exact for
// the long tail, and a hot or common file is known only to be read by
// every attribute, or by at least that share of them, unless the packer
// kept the counts in common-uses.json.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  COMMON_FILE,
  FILES_DIR,
  type IndexDir,
  SRC_PREFIX,
  TREE_PREFIX,
  fileIds,
} from "../src/browser/file-ids.ts";

const TREE_INDEX = ".jinx/tree-index.json";
const SRC_INDEX = ".jinx/src-index.json";
const HOT_FILE = ".jinx/hot.json";
const NAMES_FILE = ".jinx/names.json";
const POSITIONS_DIR = ".jinx/positions";
const COMMON_USES_FILE = "common-uses.json";
const STATS_FILE = ".jinx/stats.json";
const UNREAD_FILE = ".jinx/unread.json";
const CONFIG_FILE = ".jinx/config.json";
const NIX_SUFFIX = ".nix";
const MODULE_SUFFIX = ".ts";
const JINX_DIR = ".jinx/";
const COMMON_SHARE = 0.3;
const TOP_ATTRIBUTES = 25;
const TOP_FILES = 50;
const TOP_DEFINING_FILES = 25;
const TOP_KINDS = 15;
const QUANTILES = [0, 0.1, 0.5, 0.9, 0.99, 1];
// Readers-per-file buckets: the lower bound of each.
const READER_BUCKETS = [1, 2, 10, 100, 1000];
// How deep a directory the breakdowns group by: pkgs/by-name, nixos/modules.
const GROUP_DEPTH = 2;

export interface HotLists {
  readonly tree: readonly string[];
  readonly src: readonly string[];
}

export interface StatsInput {
  readonly rev: string;
  // Every regular file of both indexes, by id (src/browser/file-ids.ts).
  readonly paths: readonly string[];
  readonly hot: HotLists;
  readonly common: readonly number[];
  // Exact reader counts for common ids, when the packer kept them.
  readonly commonUses: Readonly<Record<string, number>> | null;
  readonly names: readonly string[];
  // Attribute -> ids beyond the hot and common sets.
  readonly lists: ReadonlyMap<string, readonly number[]>;
  readonly positions: ReadonlyMap<string, string>;
}

export interface Counted {
  readonly name: string;
  readonly count: number;
}

export interface DirCoverage {
  readonly dir: string;
  readonly total: number;
  readonly unread: number;
}

export interface Stats {
  readonly rev: string;
  readonly attributes: {
    readonly total: number;
    readonly withList: number;
    readonly positioned: number;
  };
  readonly files: {
    readonly modules: number;
    readonly nix: number;
    readonly nixRead: number;
    readonly nixUnread: number;
    // Source files read by some attribute, and those of them not .nix.
    readonly srcRead: number;
    readonly otherRead: number;
    readonly unreadByDir: readonly DirCoverage[];
  };
  readonly base: {
    readonly hotTree: number;
    readonly hotSrc: number;
    readonly common: number;
    readonly commonShare: number;
  };
  readonly perAttribute: {
    // Files beyond the base, at the quantiles in `quantiles`.
    readonly quantiles: readonly number[];
    readonly values: readonly number[];
    readonly top: readonly {
      readonly name: string;
      readonly files: number;
      readonly modules: number;
      readonly sources: number;
    }[];
  };
  readonly perFile: {
    // Files by how many attributes read them, beyond the base; one entry
    // per bucket lower bound in `buckets`.
    readonly buckets: readonly number[];
    readonly counts: readonly number[];
    readonly top: readonly Counted[];
    // The common files, with exact counts when known, else null.
    readonly common: readonly {
      readonly name: string;
      readonly count: number | null;
    }[];
  };
  readonly kinds: readonly Counted[];
  readonly positions: {
    readonly byDir: readonly Counted[];
    readonly topFiles: readonly Counted[];
  };
}

// The directory a path is grouped under: its first GROUP_DEPTH
// components, or the file itself at the top level.
export function groupOf(path: string): string {
  const parts = path.split("/");
  if (parts.length <= GROUP_DEPTH) {
    return parts.length === 1 ? "(top level)" : parts[0]!;
  }
  return parts.slice(0, GROUP_DEPTH).join("/");
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const i = Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)));
  return sorted[i]!;
}

function topOf(counts: ReadonlyMap<string, number>, n: number): Counted[] {
  return [...counts]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, n);
}

function bump(counts: Map<string, number>, key: string, by = 1): void {
  counts.set(key, (counts.get(key) ?? 0) + by);
}

// The source path a module or source id stands for: `t/pkgs/a.ts` and
// `s/pkgs/a.nix` are both pkgs/a.nix; another source file is itself.
function sourceOf(path: string): string | null {
  if (path.startsWith(TREE_PREFIX)) {
    const rel = path.slice(TREE_PREFIX.length);
    if (rel.startsWith(JINX_DIR) || !rel.endsWith(MODULE_SUFFIX)) {
      return null;
    }
    return rel.slice(0, -MODULE_SUFFIX.length) + NIX_SUFFIX;
  }
  return path.slice(SRC_PREFIX.length);
}

export function computeStats(input: StatsInput): {
  stats: Stats;
  unread: string[];
} {
  const idOf = new Map<string, number>();
  input.paths.forEach((p, id) => idOf.set(p, id));
  const hotIds = new Set<number>();
  for (const p of input.hot.tree) {
    const id = idOf.get(TREE_PREFIX + p);
    if (id !== undefined) {
      hotIds.add(id);
    }
  }
  for (const p of input.hot.src) {
    const id = idOf.get(SRC_PREFIX + p);
    if (id !== undefined) {
      hotIds.add(id);
    }
  }
  const commonIds = new Set(input.common);

  // Readers per id over the lists, and the files each attribute needs.
  const readers = new Map<number, number>();
  const perAttribute: {
    name: string;
    files: number;
    modules: number;
    sources: number;
  }[] = [];
  for (const [name, ids] of input.lists) {
    let modules = 0;
    let sources = 0;
    for (const id of ids) {
      // An id past the index is a list packed against another index.
      if (input.paths[id] === undefined) {
        continue;
      }
      readers.set(id, (readers.get(id) ?? 0) + 1);
      if (input.paths[id]!.startsWith(TREE_PREFIX)) {
        modules++;
      } else {
        sources++;
      }
    }
    perAttribute.push({ name, files: ids.length, modules, sources });
  }
  const readIds = new Set<number>([...hotIds, ...commonIds, ...readers.keys()]);

  // Every .nix source file, read or not, by directory.
  const readSources = new Set<string>();
  for (const id of readIds) {
    const src = sourceOf(input.paths[id]!);
    if (src !== null) {
      readSources.add(src);
    }
  }
  let modules = 0;
  let nix = 0;
  let srcRead = 0;
  let otherRead = 0;
  const unread: string[] = [];
  const dirTotal = new Map<string, number>();
  const dirUnread = new Map<string, number>();
  const kinds = new Map<string, number>();
  input.paths.forEach((p, id) => {
    if (p.startsWith(TREE_PREFIX)) {
      if (!p.startsWith(TREE_PREFIX + JINX_DIR) && p.endsWith(MODULE_SUFFIX)) {
        modules++;
      }
      return;
    }
    const rel = p.slice(SRC_PREFIX.length);
    if (readIds.has(id)) {
      srcRead++;
      if (!rel.endsWith(NIX_SUFFIX)) {
        otherRead++;
      }
      const dot = rel.lastIndexOf(".");
      const slash = rel.lastIndexOf("/");
      bump(kinds, dot > slash ? rel.slice(dot) : "(none)");
    }
    if (!rel.endsWith(NIX_SUFFIX)) {
      return;
    }
    nix++;
    bump(dirTotal, groupOf(rel));
    if (!readSources.has(rel)) {
      unread.push(rel);
      bump(dirUnread, groupOf(rel));
    }
  });
  unread.sort();
  const unreadByDir: DirCoverage[] = [...dirTotal]
    .map(([dir, total]) => ({ dir, total, unread: dirUnread.get(dir) ?? 0 }))
    .sort((a, b) => b.unread - a.unread || a.dir.localeCompare(b.dir));

  // Files by readers, beyond the base.
  const bucketCounts = READER_BUCKETS.map(() => 0);
  const fileReaders = new Map<string, number>();
  for (const [id, n] of readers) {
    let b = 0;
    while (b + 1 < READER_BUCKETS.length && n >= READER_BUCKETS[b + 1]!) {
      b++;
    }
    bucketCounts[b]!++;
    fileReaders.set(input.paths[id]!, n);
  }
  const common = [...commonIds]
    .map((id) => ({
      name: input.paths[id]!,
      count: input.commonUses?.[String(id)] ?? null,
    }))
    .sort(
      (a, b) => (b.count ?? 0) - (a.count ?? 0) || a.name.localeCompare(b.name),
    );

  // Where the attributes are defined.
  const posDirs = new Map<string, number>();
  const posFiles = new Map<string, number>();
  for (const position of input.positions.values()) {
    const file = position.replace(/:\d+$/, "");
    bump(posDirs, groupOf(file));
    bump(posFiles, file);
  }

  const sizes = perAttribute.map((a) => a.files).sort((a, b) => a - b);
  const stats: Stats = {
    rev: input.rev,
    attributes: {
      total: input.names.length,
      withList: input.lists.size,
      positioned: input.positions.size,
    },
    files: {
      modules,
      nix,
      nixRead: nix - unread.length,
      nixUnread: unread.length,
      srcRead,
      otherRead,
      unreadByDir,
    },
    base: {
      hotTree: input.hot.tree.length,
      hotSrc: input.hot.src.length,
      common: commonIds.size,
      commonShare: COMMON_SHARE,
    },
    perAttribute: {
      quantiles: QUANTILES,
      values: QUANTILES.map((q) => quantile(sizes, q)),
      top: [...perAttribute]
        .sort((a, b) => b.files - a.files || a.name.localeCompare(b.name))
        .slice(0, TOP_ATTRIBUTES),
    },
    perFile: {
      buckets: READER_BUCKETS,
      counts: bucketCounts,
      top: topOf(fileReaders, TOP_FILES),
      common,
    },
    kinds: topOf(kinds, TOP_KINDS),
    positions: {
      byDir: topOf(posDirs, posDirs.size),
      topFiles: topOf(posFiles, TOP_DEFINING_FILES),
    },
  };
  return { stats, unread };
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

function readShards<T>(
  dir: string,
  skip: ReadonlySet<string> = new Set(),
): Map<string, T> {
  const out = new Map<string, T>();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.endsWith(".json") || skip.has(name)) {
      continue;
    }
    for (const [k, v] of Object.entries(
      readJson<Record<string, T>>(join(dir, name)),
    )) {
      out.set(k, v);
    }
  }
  return out;
}

function main(): void {
  const tree = process.argv[2];
  if (tree === undefined) {
    process.stderr.write("usage: node tools/nixpkgs-stats.ts <tree>\n");
    process.exit(2);
  }
  const root = resolve(tree);
  const cfg = readJson<{ nixpkgs: { rev: string } }>(join(root, CONFIG_FILE));
  const filesDir = join(root, FILES_DIR);
  const lists = readShards<readonly number[]>(
    filesDir,
    new Set([COMMON_FILE, COMMON_USES_FILE]),
  );
  let commonUses: Record<string, number> | null = null;
  try {
    commonUses = readJson<Record<string, number>>(
      join(filesDir, COMMON_USES_FILE),
    );
  } catch {
    commonUses = null;
  }
  const { stats, unread } = computeStats({
    rev: cfg.nixpkgs.rev,
    paths: fileIds(
      readJson<IndexDir>(join(root, TREE_INDEX)),
      readJson<IndexDir>(join(root, SRC_INDEX)),
    ),
    hot: readJson<HotLists>(join(root, HOT_FILE)),
    common: readJson<number[]>(join(filesDir, COMMON_FILE)),
    commonUses,
    names: readJson<string[]>(join(root, NAMES_FILE)),
    lists,
    positions: readShards<string>(join(root, POSITIONS_DIR)),
  });
  writeFileSync(join(root, STATS_FILE), JSON.stringify(stats, null, 1) + "\n");
  writeFileSync(join(root, UNREAD_FILE), JSON.stringify(unread) + "\n");
  console.error(
    `${stats.files.nixUnread} of ${stats.files.nix} .nix files unread by ${stats.attributes.withList} attributes; wrote ${STATS_FILE} and ${UNREAD_FILE}`,
  );
}

// Run as a script; importing the module for `computeStats` does nothing.
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
