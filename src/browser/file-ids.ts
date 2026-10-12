// File ids shared by the tools that write a tree's .jinx/files and the
// workers that read them. A regular file's id is its position in a walk
// of the tree's index, then of the source's index, in the order the
// indexes list entries (tools/index-tree.ts writes names sorted), so
// both sides compute the same numbering from the same two documents
// and no list of paths has to be published.

export type IndexEntry = number | [number] | string | IndexDir;
export interface IndexDir {
  [name: string]: IndexEntry;
}

// Paths in the lists are relative to their root; the two roots are told
// apart by the prefix.
export const TREE_PREFIX = "t/";
export const SRC_PREFIX = "s/";

function isDir(entry: IndexEntry): entry is IndexDir {
  return typeof entry === "object" && !Array.isArray(entry);
}

function walk(dir: IndexDir, prefix: string, out: string[]): void {
  for (const name of Object.keys(dir)) {
    const entry = dir[name]!;
    const path = prefix + name;
    if (isDir(entry)) {
      walk(entry, path + "/", out);
      continue;
    }
    if (typeof entry === "string") {
      continue;
    }
    out.push(path);
  }
}

// Every regular file of both indexes, by id.
export function fileIds(tree: IndexDir, src: IndexDir): string[] {
  const out: string[] = [];
  walk(tree, TREE_PREFIX, out);
  walk(src, SRC_PREFIX, out);
  return out;
}

// The shard an attribute's list is kept in: its first characters, with
// anything a filename should not carry replaced.
export const SHARD_CHARS = 2;
export function shardOf(attr: string): string {
  return attr.slice(0, SHARD_CHARS).replace(/[^A-Za-z0-9_-]/g, "_") || "_";
}

export const FILES_DIR = ".jinx/files";
export const COMMON_FILE = "common.json";
