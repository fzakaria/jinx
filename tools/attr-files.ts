// Record, for every top-level attribute of a published tree, the files
// evaluating its drvPath reads beyond what hello reads, so the site's
// nixpkgs page can fetch them in parallel before evaluating the
// attribute (src/browser/nixpkgs-worker.ts).
//
//   node tools/attr-files.ts <tree> [--jobs N] [--only names.json]
//
// One `jinx eval --record-files` process per attribute, N at a time;
// a fresh process each time, since modules a process has loaded are not
// read again. The results go to <tree>/.jinx/files-raw/<shard>.json, a
// shard per leading two characters of the attribute name, each
// {"<attr>": {"tree": [...], "src": [...]}}; an attribute that fails to
// evaluate is left out. tools/pack-files.ts turns them into what the
// site reads. Expect a few seconds per attribute: all of
// nixpkgs is hours on a laptop and minutes on a large machine.
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { shardOf } from "../src/browser/file-ids.ts";

const SYSTEM = "x86_64-linux";
const NAMES_FILE = ".jinx/names.json";
const HOT_FILE = ".jinx/hot.json";
const FILES_DIR = ".jinx/files-raw";
const PROGRESS_EVERY = 100;
const STACK_SIZE_FLAG = "--stack-size=1000000";

const JOBS_FLAG = "--jobs";
const ONLY_FLAG = "--only";

interface Recorded {
  readonly tree: string[];
  readonly src: string[];
}

function usage(): never {
  process.stderr.write(
    "usage: node tools/attr-files.ts <tree> [--jobs N] [--only names.json]\n",
  );
  process.exit(2);
}

let tree: string | undefined;
let jobs = cpus().length;
let only: string | undefined;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a === JOBS_FLAG) {
    jobs = Number(argv[++i]);
    continue;
  }
  if (a === ONLY_FLAG) {
    only = argv[++i];
    continue;
  }
  tree = a;
}
if (tree === undefined || !Number.isInteger(jobs) || jobs < 1) {
  usage();
}
const treeRoot = resolve(tree);
const main = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));

const names = JSON.parse(
  readFileSync(only ?? join(treeRoot, NAMES_FILE), "utf8"),
) as string[];
const hot = JSON.parse(
  readFileSync(join(treeRoot, HOT_FILE), "utf8"),
) as Recorded;
const hotTree = new Set(hot.tree);
const hotSrc = new Set(hot.src);

// Evaluate one attribute in a fresh process and return what it read
// beyond the hot set, or null when the evaluation failed.
function record(attr: string): Promise<Recorded | null> {
  const scratch = join(
    tmpdir(),
    `jinx-attr-${process.pid}-${attr.replace(/[^A-Za-z0-9_-]/g, "_")}`,
  );
  const expr = `${scratch}.nix`;
  const out = `${scratch}.json`;
  writeFileSync(
    expr,
    `(import ${treeRoot}/nixpkgs { system = "${SYSTEM}"; config = {}; overlays = []; }).${attr}.drvPath\n`,
  );
  return new Promise((done) => {
    const child = spawn(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        STACK_SIZE_FLAG,
        main,
        "eval",
        expr,
        "--tree",
        treeRoot,
        "--record-files",
        out,
      ],
      { stdio: ["ignore", "ignore", "ignore"] },
    );
    child.on("exit", (code) => {
      let result: Recorded | null = null;
      if (code === 0 && existsSync(out)) {
        const r = JSON.parse(readFileSync(out, "utf8")) as Recorded;
        result = {
          tree: r.tree.filter((p) => !hotTree.has(p)),
          src: r.src.filter((p) => !hotSrc.has(p)),
        };
      }
      rmSync(expr, { force: true });
      rmSync(out, { force: true });
      done(result);
    });
  });
}

const shards = new Map<string, Record<string, Recorded>>();
let next = 0;
let finished = 0;
let failed = 0;
const started = Date.now();

async function worker(): Promise<void> {
  while (next < names.length) {
    const attr = names[next++]!;
    const r = await record(attr);
    finished++;
    if (r === null) {
      failed++;
    } else {
      const key = shardOf(attr);
      let shard = shards.get(key);
      if (shard === undefined) {
        shard = {};
        shards.set(key, shard);
      }
      shard[attr] = r;
    }
    if (finished % PROGRESS_EVERY === 0) {
      const secs = (Date.now() - started) / 1000;
      process.stderr.write(
        `${finished}/${names.length} attributes, ${failed} failed, ${secs.toFixed(0)} s\n`,
      );
    }
  }
}

await Promise.all(Array.from({ length: Math.min(jobs, names.length) }, worker));

const dir = join(treeRoot, FILES_DIR);
if (only === undefined && existsSync(dir)) {
  rmSync(dir, { recursive: true });
}
mkdirSync(dir, { recursive: true });
for (const [key, shard] of shards) {
  const file = join(dir, `${key}.json`);
  // With --only, merge into a shard that is already there.
  const existing = existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, Recorded>)
    : {};
  writeFileSync(file, JSON.stringify({ ...existing, ...shard }) + "\n");
}
process.stderr.write(
  `${FILES_DIR}: ${finished - failed} attributes in ${shards.size} shards, ${failed} failed, ${((Date.now() - started) / 1000).toFixed(0)} s\n`,
);
