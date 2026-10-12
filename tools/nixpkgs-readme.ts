// Write the README and the parity history of a jinx-nixpkgs tree
// (docs/tracking-nixpkgs.md).
//
//   node tools/nixpkgs-readme.ts <tree>
//
// Reads <tree>/.jinx/config.json for the revisions, <tree>/parity/report.md
// and joined.tsv(.gz) for the outcome counts and the systems compared,
// and <tree>/parity/history.json for the earlier revisions. Writes the
// README with a status table for the current revision and a history
// table, and rewrites history.json with the current revision added (or
// replaced, when the same revision is published again).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

const CONFIG_FILE = ".jinx/config.json";
const REPORT_FILE = "parity/report.md";
const JOINED_FILE = "parity/joined.tsv";
const JOINED_GZ_FILE = "parity/joined.tsv.gz";
const HISTORY_FILE = "parity/history.json";
const README_FILE = "README.md";

const NIXPKGS_COMMIT_URL = "https://github.com/NixOS/nixpkgs/commit";
const JINX_COMMIT_URL = "https://github.com/fzakaria/jinx/commit";
const SHORT_REV = 7;
const ISO_DATE_LENGTH = "YYYY-MM-DD".length;

interface Config {
  readonly nixpkgs: { readonly rev: string };
  readonly jinx: string;
}

// One published revision, as parity/history.json records it.
interface HistoryEntry {
  readonly date: string;
  readonly nixpkgs: string;
  readonly jinx: string;
  readonly systems: readonly string[];
  readonly attributes: number;
  readonly identical: number;
  readonly bothError: number;
  readonly differ: number;
  readonly jinxError: number;
  readonly nixError: number;
}

// The outcome rows of parity/report.md (tools/parity-compare.sh), by the
// label the report prints.
const REPORT_ROWS: ReadonlyArray<readonly [string, keyof HistoryEntry]> = [
  ["identical", "identical"],
  ["both error", "bothError"],
  ["differ", "differ"],
  ["jinx error, nix ok", "jinxError"],
  ["nix error, jinx ok", "nixError"],
];

function readReport(
  report: string,
): Omit<HistoryEntry, "date" | "nixpkgs" | "jinx" | "systems"> {
  const counts: Record<string, number> = {};
  for (const line of report.split("\n")) {
    const m = /^\| (.+?) \| (\d+) \|$/.exec(line);
    if (m !== null) {
      counts[m[1]] = Number(m[2]);
    }
  }
  const total = /^Attributes evaluated by both: (\d+)/m.exec(report);
  if (total === null) {
    throw new Error(`${REPORT_FILE}: no attribute total`);
  }
  const out: Record<string, number> = { attributes: Number(total[1]) };
  for (const [label, key] of REPORT_ROWS) {
    if (counts[label] === undefined) {
      throw new Error(`${REPORT_FILE}: no "${label}" row`);
    }
    out[key] = counts[label];
  }
  return out as unknown as Omit<
    HistoryEntry,
    "date" | "nixpkgs" | "jinx" | "systems"
  >;
}

// The last element of an attribute path that is a system: outpaths.nix
// ends every package's path with one, and the few other paths (such as
// release-checks) end with a name that is not an <arch>-<os> pair.
const SYSTEM_PATTERN =
  /^[a-z0-9_]+-(linux|darwin|freebsd|netbsd|openbsd|windows|none)$/;

// The systems the comparison covered: the last element of every attribute
// path in joined.tsv, which outpaths.nix names per attribute.
function readSystems(tree: string): string[] {
  let text: string;
  if (existsSync(join(tree, JOINED_GZ_FILE))) {
    text = gunzipSync(readFileSync(join(tree, JOINED_GZ_FILE))).toString();
  } else {
    text = readFileSync(join(tree, JOINED_FILE), "utf8");
  }
  const systems = new Set<string>();
  for (const line of text.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) {
      continue;
    }
    const attrPath = JSON.parse(line.slice(0, tab)) as string[];
    const last = attrPath[attrPath.length - 1];
    if (last !== undefined && SYSTEM_PATTERN.test(last)) {
      systems.add(last);
    }
  }
  return [...systems].sort();
}

function short(rev: string): string {
  return rev.slice(0, SHORT_REV);
}

function n(value: number): string {
  return value.toLocaleString("en-US");
}

function nixpkgsLink(rev: string): string {
  return `[${short(rev)}](${NIXPKGS_COMMIT_URL}/${rev})`;
}

function jinxLink(rev: string): string {
  return `[${short(rev)}](${JINX_COMMIT_URL}/${rev})`;
}

function renderReadme(
  current: HistoryEntry,
  history: readonly HistoryEntry[],
): string {
  const oneSided = (e: HistoryEntry) => e.jinxError + e.nixError;
  const historyRows = history
    .map(
      (e) =>
        `| ${e.date} | ${nixpkgsLink(e.nixpkgs)} | ${jinxLink(e.jinx)} | ${n(e.attributes)} | ${n(e.identical)} | ${n(e.bothError)} | ${n(e.differ)} | ${n(oneSided(e))} |`,
    )
    .join("\n");
  return `# jinx-nixpkgs

nixpkgs, transpiled to TypeScript by [jinx](https://github.com/fzakaria/jinx).

## Status

nixpkgs ${nixpkgsLink(current.nixpkgs)}, compiled by jinx ${jinxLink(current.jinx)}
on ${current.date}.

Parity with Nix: every attribute of nixpkgs' \`ci/eval/outpaths.nix\` for
${current.systems.join(", ")}, evaluated with nix-eval-jobs and with jinx,
drvPath against drvPath.

| outcome | attributes |
| --- | --- |
| identical | ${n(current.identical)} |
| both fail | ${n(current.bothError)} |
| differ | ${n(current.differ)} |
| jinx fails, Nix does not | ${n(current.jinxError)} |
| Nix fails, jinx does not | ${n(current.nixError)} |

The attribute-by-attribute result is \`parity/joined.tsv.gz\` and the
summary [parity/report.md](parity/report.md); the method is jinx's
docs/verification.md.

## History

One row per published revision, newest first.

| date | nixpkgs | jinx | attributes | identical | both fail | differ | one side |
| --- | --- | --- | --- | --- | --- | --- | --- |
${historyRows}

## Layout

Every \`.nix\` file of the nixpkgs revision is here as a \`.ts\` module in the
same place in the tree, with a source map beside it pointing back at the
Nix. \`.jinx/config.json\` names the revision; \`.jinx/runtime/\` is the jinx
runtime the modules import, so the tree stands alone. \`.jinx/tree-index.json\`
and \`.jinx/src-index.json\` list every path of the tree and of the nixpkgs
source, \`.jinx/hot.json\` the files evaluating \`hello\` reads,
\`.jinx/names.json\` the top-level attribute names, and \`.jinx/files/\`
what each attribute reads beyond that, for a reader that fetches files
one at a time (jinx.dev's nixpkgs page).

The Nix source tree is not in this repository. Put a checkout of the
revision in \`.jinx/config.json\` at \`./nixpkgs\` (a symlink is fine); the
modules read patches, scripts and \`pkgs/by-name\` from it:

\`\`\`console
$ rev=$(jq -r .nixpkgs.rev .jinx/config.json)
$ ln -s "$(nix flake prefetch github:NixOS/nixpkgs/$rev --json | jq -r .storePath)" nixpkgs
$ node --stack-size=1000000 ../jinx/src/cli/main.ts eval ./nixpkgs -A hello --tree .
\`\`\`

Or evaluate from TypeScript with jinx's view API:

\`\`\`ts
import { loadNixpkgs } from "jinx";
const pkgs = loadNixpkgs("./nixpkgs", { tree: "." });
console.log(pkgs.hello.drvPath);
\`\`\`

Regenerated by \`tools/publish-nixpkgs.sh\` in the jinx repository, one commit
per tracked nixpkgs revision. nixpkgs is MIT; so is this.
`;
}

const tree = process.argv[2];
if (tree === undefined) {
  process.stderr.write("usage: node tools/nixpkgs-readme.ts <tree>\n");
  process.exit(2);
}

const config = JSON.parse(
  readFileSync(join(tree, CONFIG_FILE), "utf8"),
) as Config;
const report = readFileSync(join(tree, REPORT_FILE), "utf8");
const current: HistoryEntry = {
  date: new Date().toISOString().slice(0, ISO_DATE_LENGTH),
  nixpkgs: config.nixpkgs.rev,
  jinx: config.jinx,
  systems: readSystems(tree),
  ...readReport(report),
};

// The history keeps one entry per nixpkgs revision; publishing the same
// revision again replaces its entry.
const historyPath = join(tree, HISTORY_FILE);
const earlier: HistoryEntry[] = existsSync(historyPath)
  ? (JSON.parse(readFileSync(historyPath, "utf8")) as HistoryEntry[])
  : [];
const history = [
  current,
  ...earlier.filter((e) => e.nixpkgs !== current.nixpkgs),
];

writeFileSync(historyPath, `${JSON.stringify(history, null, 2)}\n`);
writeFileSync(join(tree, README_FILE), renderReadme(current, history));
process.stderr.write(
  `${README_FILE}: nixpkgs ${short(current.nixpkgs)}, ${history.length} revisions\n`,
);
