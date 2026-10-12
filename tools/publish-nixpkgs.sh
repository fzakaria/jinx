#!/usr/bin/env bash
# Build the jinx-nixpkgs tree: nixpkgs at one revision, compiled with the
# runtime vendored in, plus the metadata a consumer needs to pair it with
# the source tree (notes/publishing.md).
#
#   tools/publish-nixpkgs.sh <rev> <out-dir> [--parity <compare-dir>]
#
# <rev> is a nixpkgs commit; the source is fetched by nix and never copied
# into the tree. The consumer places or symlinks a checkout of that commit
# at <out-dir>/nixpkgs, which is what .jinx/config.json names.
#
# <out-dir> may be a checkout of jinx-nixpkgs: everything in it but .git,
# .jj and parity/history.json is replaced, so modules of files nixpkgs no
# longer has go away and the README's history table carries on.
#
# --parity names the output directory of tools/parity-compare.sh (or a
# directory holding its report.md and joined.tsv, gzipped or not) for
# this revision; the report goes into the tree and the README's status
# and history tables are written from it (tools/nixpkgs-readme.ts).
set -euo pipefail

usage="usage: publish-nixpkgs.sh <rev> <out-dir> [--parity <compare-dir>]"
rev=${1:?$usage}
out=${2:?$usage}
shift 2
parity=""
while [ $# -gt 0 ]; do
  case "$1" in
    --parity) parity=${2:?$usage}; shift 2 ;;
    *) echo "$usage" >&2; exit 2 ;;
  esac
done
here="$(cd "$(dirname "$0")/.." && pwd)"

meta=$(nix flake prefetch "github:NixOS/nixpkgs/$rev" --json)
src=$(jq -r .storePath <<<"$meta")
narHash=$(jq -r .hash <<<"$meta")
fullRev=$(jq -r '.locked.rev // empty' <<<"$meta")
if [ -z "$fullRev" ]; then
  fullRev=$rev
fi

# Start from an empty tree, keeping the checkout's .git and .jj and the
# parity history the README accumulates.
mkdir -p "$out"
history=$(mktemp)
if [ -f "$out/parity/history.json" ]; then
  cp "$out/parity/history.json" "$history"
fi
# The per-attribute lists survive a publish that skips recording them:
# the paths they name do not change with the compiler.
keptFiles=$(mktemp -d)
if [ "${JINX_ATTR_FILES:-1}" = 0 ] && [ -d "$out/.jinx/files" ]; then
  cp -r "$out/.jinx/files" "$keptFiles/files"
fi
find "$out" -mindepth 1 -maxdepth 1 ! -name .git ! -name .jj -exec rm -rf {} +

ulimit -s unlimited 2>/dev/null || true
run() {
  node --disable-warning=ExperimentalWarning --stack-size=1000000 "$@"
}
run "$here/src/cli/main.ts" compile "$src" --out "$out" --vendor-runtime

# The config names the source tree relative to the output tree, and
# records the revision so a consumer can fetch exactly that source.
jinxCommit=$(cd "$here" && (jj log -r @- --no-graph -T commit_id 2>/dev/null || git rev-parse HEAD))
abi=$(run --input-type=module -e "import { ABI } from '$here/src/runtime/index.ts'; console.log(ABI)")
cat > "$out/.jinx/config.json" <<JSON
{
  "srcRoot": "./nixpkgs",
  "nixpkgs": {
    "rev": "$fullRev",
    "narHash": "$narHash",
    "url": "github:NixOS/nixpkgs/$fullRev"
  },
  "jinx": "$jinxCommit",
  "abi": $abi
}
JSON
ln -sfn "$src" "$out/nixpkgs"
printf 'nixpkgs\n' > "$out/.gitignore"

# The indexes let a reader that fetches one file at a time (the site's
# nixpkgs page) answer readdir and stat without a round trip per path.
run "$here/tools/index-tree.ts" "$out" "$out/.jinx/tree-index.json" --skip .git --skip nixpkgs
run "$here/tools/index-tree.ts" "$src" "$out/.jinx/src-index.json"

# The files `hello` reads, which the site's nixpkgs page fetches ahead,
# and the top-level attribute names, so the page needs no evaluation to
# complete an attribute.
"$here/tools/hot-files.sh" "$out" "$src" "$out/.jinx/hot.json"
names=$(mktemp --suffix=.nix)
echo "builtins.attrNames (import $out/nixpkgs { system = \"x86_64-linux\"; config = {}; overlays = []; })" > "$names"
run "$here/src/cli/main.ts" eval "$names" --json --tree "$out" > "$out/.jinx/names.json"
rm -f "$names"

# Where every top-level attribute is defined, so the page shows the
# source before the attribute is evaluated.
run --max-old-space-size=32000 "$here/tools/attr-positions.ts" "$out"

# What each attribute reads beyond the hot set, one evaluation per
# attribute. This is the slow step: hours on a laptop, minutes on a
# large machine. JINX_ATTR_FILES_JOBS sets the parallelism;
# JINX_ATTR_FILES=0 skips it (the page then fetches as it goes).
if [ "${JINX_ATTR_FILES:-1}" != 0 ]; then
  run "$here/tools/attr-files.ts" "$out" --jobs "${JINX_ATTR_FILES_JOBS:-$(nproc)}"
elif [ -d "$keptFiles/files" ]; then
  cp -r "$keptFiles/files" "$out/.jinx/files"
fi
rm -rf "$keptFiles"

# The playground's NixOS example is not an attribute of pkgs; its list
# goes under the name "nixos". Recorded, like the rest, only when the
# lists are.
if [ "${JINX_ATTR_FILES:-1}" != 0 ]; then
nixosExpr=$(mktemp --suffix=.nix)
cat > "$nixosExpr" <<NIX
(import $out/nixpkgs/nixos {
  configuration = {
    fileSystems."/" = { device = "/dev/sda1"; fsType = "ext4"; };
    boot.loader.grub.device = "/dev/sda";
    networking.hostName = "jinx";
    system.stateVersion = "25.11";
  };
}).config.system.build.toplevel.drvPath
NIX
run "$here/tools/record-extra.ts" "$out" nixos "$nixosExpr"
rm -f "$nixosExpr"

# The lists as the site reads them: ids, with the files most attributes
# share pulled out into one document.
run "$here/tools/pack-files.ts" "$out"
rm -rf "$out/.jinx/files-raw"
fi

# The parity report for this revision, and the README written from it.
if [ -n "$parity" ]; then
  mkdir -p "$out/parity"
  if [ -s "$history" ]; then
    cp "$history" "$out/parity/history.json"
  fi
  cp "$parity/report.md" "$out/parity/report.md"
  if [ -f "$parity/joined.tsv.gz" ]; then
    cp "$parity/joined.tsv.gz" "$out/parity/joined.tsv.gz"
  else
    gzip -9 -c "$parity/joined.tsv" > "$out/parity/joined.tsv.gz"
  fi
  cat > "$out/parity/README.md" <<'MD'
# Parity with Nix

`report.md` is the result of evaluating every attribute of nixpkgs'
`ci/eval/outpaths.nix` with nix-eval-jobs and with jinx on this revision
and comparing drvPaths (jinx's docs/verification.md). `joined.tsv.gz` has
one line per attribute: the attribute path as JSON, Nix's drvPath or
`ERROR: <message>`, and jinx's. `history.json` has the counts of every
revision published so far, which the README's history table shows.
MD
  run "$here/tools/nixpkgs-readme.ts" "$out"
else
  echo "no --parity given: README not written" >&2
fi
rm -f "$history"
echo "wrote $out for nixpkgs $fullRev"
