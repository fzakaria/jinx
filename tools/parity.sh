#!/usr/bin/env bash
# The whole-nixpkgs parity run (docs/verification.md): evaluate every
# attribute with nix-eval-jobs and with jinx and diff the drvPaths.
#
#   tools/parity.sh <nixpkgs> [--workers N] [--system x86_64-linux] [--out work/parity]
#
# Produces, under --out:
#   nix.jsonl      nix-eval-jobs output
#   jinx.jsonl     jinx eval-jobs output
#   compare/       report.md, joined.tsv, jinx-errors.txt, differ.tsv, rerun.txt
#
# Both sides use nixpkgs' CI configuration (ci/eval/outpaths.nix:
# allowAliases = false, allowUnfree = true, checkMeta = true, inHydra =
# true) and run impurely in the same environment, since a few derivations
# embed getEnv. After a fix, `jinx eval-jobs --only compare/rerun.txt`
# re-runs the flagged attributes and tools/parity-compare.sh re-joins.
#
# nix-eval-jobs takes about 4 GB a worker and jinx about 5; 32 workers of
# each fit in 250 GB and finish in under half an hour each.
set -euo pipefail

nixpkgs=""
workers="32"
system="x86_64-linux"
out="work/parity"
while [ $# -gt 0 ]; do
  case "$1" in
    --workers) workers="$2"; shift 2 ;;
    --system) system="$2"; shift 2 ;;
    --out) out="$2"; shift 2 ;;
    *) nixpkgs="$1"; shift ;;
  esac
done
if [ -z "$nixpkgs" ]; then
  echo "usage: tools/parity.sh <nixpkgs> [--workers N] [--system S] [--out DIR]" >&2
  exit 2
fi
nixpkgs="$(realpath "$nixpkgs")"
mkdir -p "$out"
here="$(cd "$(dirname "$0")/.." && pwd)"
ulimit -s unlimited 2>/dev/null || true

# The expression both evaluators see.
expr="$out/outpaths.nix"
if [ -f "$nixpkgs/ci/eval/outpaths.nix" ]; then
  printf 'import %s/ci/eval/outpaths.nix { path = %s; }\n' "$nixpkgs" "$nixpkgs" > "$expr"
else
  printf 'import %s/pkgs/top-level/release-outpaths.nix { path = %s; checkMeta = true; systems = [ "%s" ]; }\n' "$nixpkgs" "$nixpkgs" "$system" > "$expr"
fi

echo "== nix-eval-jobs ($workers workers)" >&2
start=$(date +%s)
nix-eval-jobs --workers "$workers" --max-memory-size 4096 --force-recurse "$expr" > "$out/nix.jsonl" || true
echo "nix-eval-jobs: $(( $(date +%s) - start ))s, $(wc -l < "$out/nix.jsonl") lines" >&2

echo "== jinx compile" >&2
start=$(date +%s)
jinx compile "$nixpkgs" --out "$out/tree"
echo "compile: $(( $(date +%s) - start ))s" >&2

echo "== jinx eval-jobs ($workers workers)" >&2
start=$(date +%s)
jinx eval-jobs "$expr" --workers "$workers" --max-heap 5000 --impure --system "$system" --tree "$out/tree" --cache "$out/cache" > "$out/jinx.jsonl" || true
echo "jinx: $(( $(date +%s) - start ))s, $(wc -l < "$out/jinx.jsonl") lines" >&2

echo "== compare" >&2
"$here/tools/parity-compare.sh" "$out/nix.jsonl" "$out/jinx.jsonl" "$out/compare"
