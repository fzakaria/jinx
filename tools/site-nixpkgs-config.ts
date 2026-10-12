// Write site/nixpkgs/config.json: where the site's nixpkgs page fetches
// the compiled tree and the nixpkgs source from.
//
//   node tools/site-nixpkgs-config.ts --tree-commit <sha> --rev <nixpkgs-rev>
//
// Both come from raw.githubusercontent.com pinned to a commit, so the
// page and the tree never disagree. GitHub's raw host sends the CORS
// header the page needs and serves files up to 100 MB; jsDelivr would
// cache better but stops at 20 MB, and hackage-packages.ts is 34 MB. The
// tree's own .jinx/ holds the two path indexes (tools/index-tree.ts).
import { writeFileSync } from "node:fs";

const CONFIG_FILE = "site/nixpkgs/config.json";
const RAW = "https://raw.githubusercontent.com";
const TREE_REPO = "fzakaria/jinx-nixpkgs";
const NIXPKGS_REPO = "NixOS/nixpkgs";
const TREE_INDEX = ".jinx/tree-index.json";
const SRC_INDEX = ".jinx/src-index.json";
const SYSTEM = "x86_64-linux";

const TREE_COMMIT_FLAG = "--tree-commit";
const REV_FLAG = "--rev";

let treeCommit: string | undefined;
let rev: string | undefined;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === TREE_COMMIT_FLAG) {
    treeCommit = argv[++i];
    continue;
  }
  if (argv[i] === REV_FLAG) {
    rev = argv[++i];
    continue;
  }
}
if (treeCommit === undefined || rev === undefined) {
  process.stderr.write(
    "usage: node tools/site-nixpkgs-config.ts --tree-commit <sha> --rev <nixpkgs-rev>\n",
  );
  process.exit(2);
}

const treeUrl = `${RAW}/${TREE_REPO}/${treeCommit}`;
const config = {
  treeUrl,
  treeIndexUrl: `${treeUrl}/${TREE_INDEX}`,
  srcUrl: `${RAW}/${NIXPKGS_REPO}/${rev}`,
  srcIndexUrl: `${treeUrl}/${SRC_INDEX}`,
  rev,
  system: SYSTEM,
};
writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`);
process.stderr.write(`${CONFIG_FILE}: tree ${treeCommit.slice(0, 7)}, nixpkgs ${rev.slice(0, 7)}\n`);
