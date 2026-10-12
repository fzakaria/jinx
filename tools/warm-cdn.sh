#!/usr/bin/env bash
# Fetch the files the nixpkgs page reads first through the hosts named
# in site/nixpkgs/config.json, so a first visitor after a publish finds
# them in whatever cache the host keeps.
#
#   tools/warm-cdn.sh site/nixpkgs/config.json
set -euo pipefail

config=${1:?usage: warm-cdn.sh <config.json>}
tree=$(jq -r .treeUrl "$config")
src=$(jq -r .srcUrl "$config")
hot=$(curl -fsSL "$tree/.jinx/hot.json")
{
  for f in .jinx/tree-index.json .jinx/src-index.json .jinx/names.json .jinx/hot.json; do
    echo "$tree/$f"
  done
  jq -r '.tree[]' <<<"$hot" | sed "s|^|$tree/|"
  jq -r '.src[]' <<<"$hot" | sed "s|^|$src/|"
} | xargs -P 32 -n 1 curl -fsS -o /dev/null -w '%{http_code} %{url_effective}\n' 2>&1 | grep -v '^200 ' || true
echo "warmed $(jq '.tree | length' <<<"$hot") tree files and $(jq '.src | length' <<<"$hot") source files"
