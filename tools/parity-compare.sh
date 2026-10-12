#!/usr/bin/env bash
# Compare nix-eval-jobs output with jinx eval-jobs output
# (docs/verification.md): tools/parity-compare.sh nix.jsonl jinx.jsonl out-dir
# The jinx file may be several concatenated runs (--skip-done resumes).
set -euo pipefail
nix=${1:?nix.jsonl}
jinx=${2:?jinx.jsonl}
out=${3:?out-dir}
mkdir -p "$out"
# Keyed on the attribute path as JSON: a name may contain a dot, and the
# two tools quote such names differently in their `attr` field.
jq -r 'select(.attrPath != null) | [(.attrPath | tojson), (.drvPath // ("ERROR: " + ((.error // "") | split("\n")[0])))] | @tsv' "$nix" | sort -u -k1,1 > "$out/nix.tsv"
jq -r 'select(.attrPath != null) | [(.attrPath | tojson), (.drvPath // ("ERROR: " + ((.error // "") | split("\n")[0])))] | @tsv' "$jinx" | sort -u -k1,1 > "$out/jinx.tsv"
join -t $'\t' "$out/nix.tsv" "$out/jinx.tsv" > "$out/joined.tsv"
{
  echo "# Parity report"
  echo
  echo "Attributes evaluated by both: $(wc -l < "$out/joined.tsv") (nix has $(wc -l < "$out/nix.tsv"), jinx has $(wc -l < "$out/jinx.tsv"))"
  echo
  echo "| outcome | attributes |"
  echo "| --- | --- |"
  awk -F'\t' '
    { n++ }
    $2 == $3 { same++; next }
    $2 ~ /^ERROR/ && $3 ~ /^ERROR/ { botherr++; next }
    $2 ~ /^ERROR/ { nixerr++; next }
    $3 ~ /^ERROR/ { jinxerr++; next }
    { differ++ }
    END {
      printf "| identical | %d |\n", same
      printf "| both error | %d |\n", botherr
      printf "| differ | %d |\n", differ
      printf "| jinx error, nix ok | %d |\n", jinxerr
      printf "| nix error, jinx ok | %d |\n", nixerr
    }' "$out/joined.tsv"
} > "$out/report.md"
# The attributes to re-run with `eval-jobs --only`: one JSON array a line.
awk -F'\t' '($2 !~ /^ERROR/ && $3 ~ /^ERROR/) || ($2 !~ /^ERROR/ && $3 !~ /^ERROR/ && $2 != $3) { print $1 }' "$out/joined.tsv" > "$out/rerun.txt"
join -t $'\t' -v1 "$out/nix.tsv" "$out/jinx.tsv" | cut -f1 >> "$out/rerun.txt"
# The work queue: jinx errors grouped by message, and differing drvPaths.
awk -F'\t' '$2 !~ /^ERROR/ && $3 ~ /^ERROR/ { print $3 }' "$out/joined.tsv" | sed -E 's/[0-9a-z]{32}-[^ ]*//g; s/[0-9]+/N/g' | sort | uniq -c | sort -rn | head -40 > "$out/jinx-errors.txt"
awk -F'\t' '$2 !~ /^ERROR/ && $3 !~ /^ERROR/ && $2 != $3 { print $1 "\t" $2 "\t" $3 }' "$out/joined.tsv" | head -200 > "$out/differ.tsv"
awk -F'\t' '$2 ~ /^ERROR/ && $3 !~ /^ERROR/ { print $1 "\t" $2 }' "$out/joined.tsv" | head -100 > "$out/nix-errors.tsv"
cat "$out/report.md"
echo
echo "## jinx errors by message"
cat "$out/jinx-errors.txt"
