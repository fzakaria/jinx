// Record, for every top-level attribute of a published tree, where the
// package is defined, so the site's nixpkgs page can show the source
// and the compiled module before the attribute is evaluated.
//
//   node --stack-size=1000000 --max-old-space-size=32000 \
//     tools/attr-positions.ts <tree> [--system x86_64-linux]
//
// The package set is evaluated once through the tree and every name in
// .jinx/names.json is forced to its meta.position, "<file>:<line>"
// relative to the nixpkgs root; a package without one but with a
// pkgs/by-name directory gets that file. The results go to
// <tree>/.jinx/positions/<shard>.json, a shard per leading two
// characters of the name as in .jinx/files, each {"<attr>": "<pos>"}.
// Attributes that fail or have no position are left out. All of
// nixpkgs takes a few minutes, since forcing meta is most of what
// evaluating an attribute's drvPath does without the derivation.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_CACHE, evaluateFile, setup } from "../src/cli/evaluate.ts";
import { shardOf } from "../src/browser/file-ids.ts";
import {
  type Attrs,
  type Lazy,
  force,
  getAttr,
  isAttrs,
} from "../src/runtime/value.ts";

const DEFAULT_SYSTEM = "x86_64-linux";
const SYSTEM_FLAG = "--system";
const NAMES_FILE = ".jinx/names.json";
const CONFIG_FILE = ".jinx/config.json";
export const POSITIONS_DIR = ".jinx/positions";
const META = "meta";
const POSITION = "position";
const BY_NAME_DIR = "pkgs/by-name";
const BY_NAME_SHARD_LENGTH = 2;
const BY_NAME_FILE = "package.nix";
const PROGRESS_EVERY = 10000;
const USAGE = "usage: attr-positions.ts <tree> [--system x86_64-linux]";

interface Options {
  readonly tree: string;
  readonly system: string;
}

function parseArgs(argv: readonly string[]): Options {
  let tree: string | undefined;
  let system = DEFAULT_SYSTEM;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === SYSTEM_FLAG) {
      const v = argv[++i];
      if (v === undefined) {
        throw new Error(`${a} needs a value\n${USAGE}`);
      }
      system = v;
    } else if (a.startsWith("--")) {
      throw new Error(`unknown option ${a}\n${USAGE}`);
    } else if (tree === undefined) {
      tree = resolve(a);
    } else {
      throw new Error(USAGE);
    }
  }
  if (tree === undefined) {
    throw new Error(USAGE);
  }
  return { tree, system };
}

// The position of one package: meta.position made relative to the
// root, else its pkgs/by-name file, else null.
export function positionOf(
  attr: string,
  pkg: Lazy,
  root: string,
): string | null {
  const v = force(pkg);
  if (!isAttrs(v)) {
    return null;
  }
  const meta = getAttr(v as Attrs, META);
  const m = meta === undefined ? null : force(meta);
  const pos = m !== null && isAttrs(m) ? getAttr(m, POSITION) : undefined;
  if (pos !== undefined) {
    const p = force(pos);
    if (typeof p === "string") {
      const prefix = `${root}/`;
      return p.startsWith(prefix) ? p.slice(prefix.length) : p;
    }
  }
  const byName = `${BY_NAME_DIR}/${attr.slice(0, BY_NAME_SHARD_LENGTH)}/${attr}/${BY_NAME_FILE}`;
  return existsSync(join(root, byName)) ? byName : null;
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const started = performance.now();
  const cfg = JSON.parse(
    readFileSync(join(opts.tree, CONFIG_FILE), "utf8"),
  ) as {
    srcRoot: string;
  };
  const root = realpathSync(resolve(opts.tree, cfg.srcRoot));
  setup({ outRoot: DEFAULT_CACHE, trees: [opts.tree], system: opts.system });
  const pkgs = evaluateFile(root, [], {
    system: opts.system,
    config: {},
    overlays: [],
  });
  if (!isAttrs(pkgs)) {
    throw new Error(`${root} did not evaluate to a set`);
  }
  const names = JSON.parse(
    readFileSync(join(opts.tree, NAMES_FILE), "utf8"),
  ) as string[];

  // Every name's position, by shard; failures and missing positions
  // are counted and left out.
  const shards = new Map<string, Record<string, string>>();
  let found = 0;
  let failed = 0;
  let done = 0;
  for (const name of names) {
    const lazy = getAttr(pkgs, name);
    let position: string | null = null;
    try {
      position = lazy === undefined ? null : positionOf(name, lazy, root);
    } catch {
      failed++;
    }
    if (position !== null) {
      const key = shardOf(name);
      let shard = shards.get(key);
      if (shard === undefined) {
        shard = {};
        shards.set(key, shard);
      }
      shard[name] = position;
      found++;
    }
    if (++done % PROGRESS_EVERY === 0) {
      console.error(`  ${done} of ${names.length}`);
    }
  }

  const dir = join(opts.tree, POSITIONS_DIR);
  mkdirSync(dir, { recursive: true });
  let bytes = 0;
  for (const [key, shard] of shards) {
    const text = JSON.stringify(shard);
    bytes += text.length;
    writeFileSync(join(dir, `${key}.json`), text);
  }
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.error(
    `${found} of ${names.length} attributes positioned (${failed} failed) in ${shards.size} shards, ${bytes} bytes, ${seconds}s`,
  );
}

// Run as a script; importing the module for `positionOf` does nothing.
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
