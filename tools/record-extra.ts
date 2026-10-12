// Record the files an expression reads beyond the hot set and store the
// list under a name in the tree's .jinx/files, next to the per-attribute
// lists tools/attr-files.ts writes. For the playground's examples that
// are not one attribute of pkgs: a NixOS system.
//
//   node tools/record-extra.ts <tree> <name> <expr.nix>
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOT_FILE = ".jinx/hot.json";
const FILES_DIR = ".jinx/files";
const SHARD_CHARS = 2;
const STACK_SIZE_FLAG = "--stack-size=1000000";

interface Recorded {
  readonly tree: string[];
  readonly src: string[];
}

const [treeArg, name, expr] = process.argv.slice(2);
if (treeArg === undefined || name === undefined || expr === undefined) {
  process.stderr.write(
    "usage: node tools/record-extra.ts <tree> <name> <expr.nix>\n",
  );
  process.exit(2);
}
const tree = resolve(treeArg);
const main = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));
const out = join(tmpdir(), `jinx-extra-${process.pid}.json`);

const run = spawnSync(
  process.execPath,
  [
    "--disable-warning=ExperimentalWarning",
    STACK_SIZE_FLAG,
    main,
    "eval",
    expr,
    "--tree",
    tree,
    "--record-files",
    out,
  ],
  { stdio: ["ignore", "ignore", "inherit"] },
);
if (run.status !== 0 || !existsSync(out)) {
  process.stderr.write(`record-extra: evaluating ${expr} failed\n`);
  process.exit(1);
}
const recorded = JSON.parse(readFileSync(out, "utf8")) as Recorded;
rmSync(out, { force: true });

const hot = JSON.parse(readFileSync(join(tree, HOT_FILE), "utf8")) as Recorded;
const hotTree = new Set(hot.tree);
const hotSrc = new Set(hot.src);
const list: Recorded = {
  tree: recorded.tree.filter((p) => !hotTree.has(p)),
  src: recorded.src.filter((p) => !hotSrc.has(p)),
};

const key = name.slice(0, SHARD_CHARS).replace(/[^A-Za-z0-9_-]/g, "_") || "_";
const dir = join(tree, FILES_DIR);
mkdirSync(dir, { recursive: true });
const file = join(dir, `${key}.json`);
const shard = existsSync(file)
  ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, Recorded>)
  : {};
shard[name] = list;
writeFileSync(file, JSON.stringify(shard) + "\n");
process.stderr.write(
  `${FILES_DIR}/${key}.json: ${name}, ${list.tree.length} tree files, ${list.src.length} source files\n`,
);
