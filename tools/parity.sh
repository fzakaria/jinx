#!/usr/bin/env bash
# The whole-nixpkgs parity run (docs/verification.md, level 4): evaluate
# every attribute with nix-eval-jobs and with jinx and diff the drvPaths.
#
#   tools/parity.sh <nixpkgs> [--workers N] [--system x86_64-linux] [--out work/parity]
#
# Produces, under --out:
#   nix.jsonl     nix-eval-jobs output
#   jinx.jsonl    jinx eval-jobs output
#   report.md     the table and the first differing attribute per cause
#
# nixpkgs' own CI configuration is used for both sides so the attribute
# set is the one Hydra evaluates: allowAliases = false, allowUnfree =
# true, checkMeta = true, inHydra = true (ci/eval/outpaths.nix).
set -euo pipefail

nixpkgs=""
workers="$(nproc)"
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

# The expression both evaluators see: nixpkgs' outpaths.nix if the
# checkout has it, else the equivalent configuration spelled out.
expr="$out/outpaths.nix"
if [ -f "$nixpkgs/ci/eval/outpaths.nix" ]; then
  cat > "$expr" <<NIX
import $nixpkgs/ci/eval/outpaths.nix { path = $nixpkgs; }
NIX
else
  cat > "$expr" <<NIX
import $nixpkgs/pkgs/top-level/release-outpaths.nix {
  path = $nixpkgs;
  checkMeta = true;
  systems = [ "$system" ];
}
NIX
fi

echo "== nix-eval-jobs ($workers workers)" >&2
start=$(date +%s)
nix-eval-jobs --workers "$workers" --max-memory-size 8192 --force-recurse "$expr" > "$out/nix.jsonl" || true
echo "nix-eval-jobs: $(( $(date +%s) - start ))s, $(wc -l < "$out/nix.jsonl") lines" >&2

echo "== jinx compile" >&2
start=$(date +%s)
jinx compile "$nixpkgs" --out "$out/tree"
echo "compile: $(( $(date +%s) - start ))s" >&2

echo "== jinx eval-jobs ($workers workers)" >&2
start=$(date +%s)
jinx eval-jobs "$expr" --workers "$workers" --system "$system" --cache "$out/cache" > "$out/jinx.jsonl" || true
echo "jinx: $(( $(date +%s) - start ))s, $(wc -l < "$out/jinx.jsonl") lines" >&2

echo "== compare" >&2
jq -r 'select(.attr != null) | [.attr, (.drvPath // ("ERROR: " + (.error // "")))] | @tsv' "$out/nix.jsonl" | sort > "$out/nix.tsv"
jq -r 'select(.attr != null) | [.attr, (.drvPath // ("ERROR: " + (.error // "")))] | @tsv' "$out/jinx.jsonl" | sort > "$out/jinx.tsv"
join -t $'\t' -a1 -a2 -e MISSING -o 0,1.2,2.2 "$out/nix.tsv" "$out/jinx.tsv" > "$out/joined.tsv"
{
  echo "# Parity report"
  echo
  echo "| outcome | attributes |"
  echo "| --- | --- |"
  awk -F'\t' '
    { n++ }
    $2 == $3 && $2 !~ /^ERROR/ { same++ ; next }
    $2 ~ /^ERROR/ && $3 ~ /^ERROR/ { botherr++ ; next }
    $2 ~ /^ERROR/ { nixerr++ ; next }
    $3 ~ /^ERROR/ { jinxerr++ ; if (!shownj[1]++) print "jinx-error example:", $1, $3 > "/dev/stderr"; next }
    $3 == "MISSING" { missing++ ; next }
    { differ++ ; if (!shownd[1]++) print "differ example:", $1, $2, $3 > "/dev/stderr" }
    END {
      printf "| identical | %d |\n", same
      printf "| differ | %d |\n", differ
      printf "| jinx error, nix ok | %d |\n", jinxerr
      printf "| nix error, jinx ok | %d |\n", nixerr
      printf "| both error | %d |\n", botherr
      printf "| missing from jinx | %d |\n", missing
      printf "| total | %d |\n", n
    }' "$out/joined.tsv"
} > "$out/report.md"
cat "$out/report.md"
