// Record every file an evaluation reads: the compiled modules node loads
// and the sources the runtime opens (readFile, readDir, NAR hashing).
// `jinx eval --record-files out.json` writes them as
// {"tree": [...], "src": [...]}, relative to the tree given with --tree,
// which is what the site's nixpkgs page fetches ahead of an evaluation
// (tools/hot-files.sh, tools/attr-files.ts).
//
// Module loads come from a load hook; source reads from wrapping the fs
// functions the runtime imports by name, which node's ESM facade of
// node:fs picks up after syncBuiltinESMExports.
import fs from "node:fs";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FILE_SCHEME = "file:";

// The fs functions that read a file's bytes. stat, readdir and exists
// are left out: a reader with the tree's index answers those itself.
const READERS = ["readFileSync", "openSync"] as const;

const seen = new Set<string>();

function note(p: unknown): void {
  if (typeof p === "string") {
    seen.add(resolve(p));
  } else if (p instanceof URL) {
    seen.add(fileURLToPath(p));
  }
}

// Start recording. Idempotent: a second call keeps the first recording.
let started = false;
export function startRecording(): void {
  if (started) {
    return;
  }
  started = true;
  registerHooks({
    load(url, context, nextLoad) {
      if (url.startsWith(FILE_SCHEME)) {
        seen.add(fileURLToPath(url));
      }
      return nextLoad(url, context);
    },
  });
  const patched = fs as unknown as Record<string, (...a: unknown[]) => unknown>;
  for (const name of READERS) {
    const original = patched[name]!;
    patched[name] = (...args: unknown[]) => {
      note(args[0]);
      return original(...args);
    };
  }
  syncBuiltinESMExports();
}

export interface RecordedFiles {
  readonly tree: string[];
  readonly src: string[];
}

// The recorded paths that exist under `treeRoot` and `srcRoot`, relative
// to each, in the order first seen. The tree's own `nixpkgs` link is a
// second spelling of the source root.
export function recordedFiles(
  treeRoot: string,
  srcRoot: string,
): RecordedFiles {
  const tree = resolve(treeRoot);
  const src = resolve(srcRoot);
  const link = `${tree}/nixpkgs`;
  const out: RecordedFiles = { tree: [], src: [] };
  const under = (p: string, root: string): boolean => p.startsWith(root + "/");
  for (const p of seen) {
    let rel: string;
    let bucket: string[];
    if (under(p, src)) {
      rel = relative(src, p);
      bucket = out.src;
    } else if (under(p, link)) {
      rel = relative(link, p);
      bucket = out.src;
    } else if (under(p, tree)) {
      rel = relative(tree, p);
      bucket = out.tree;
    } else {
      continue;
    }
    let isFile = false;
    try {
      isFile = fs.statSync(p).isFile();
    } catch {
      continue;
    }
    if (isFile && !bucket.includes(rel)) {
      bucket.push(rel);
    }
  }
  return out;
}
