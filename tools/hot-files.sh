#!/usr/bin/env bash
# Write the list of files evaluating a package reads from a compiled tree
# and its source, for the site's nixpkgs page to fetch in parallel before
# it needs them (src/browser/nixpkgs-worker.ts).
#
#   tools/hot-files.sh <tree> <src> <out.json> [attr...]
#
# The default is hello alone: the fixpoint and stdenv, which every
# package shares. `jinx eval --record-files` records what one evaluation
# reads; several attributes are recorded one at a time and merged in that
# order, as {"tree": [...], "src": [...]} relative to each root.
set -euo pipefail

tree=${1:?usage: hot-files.sh <tree> <src> <out.json> [attr...]}
src=${2:?usage: hot-files.sh <tree> <src> <out.json> [attr...]}
out=${3:?usage: hot-files.sh <tree> <src> <out.json> [attr...]}
shift 3
attrs=("$@")
if [ ${#attrs[@]} -eq 0 ]; then
  attrs=(hello)
fi
here="$(cd "$(dirname "$0")/.." && pwd)"
tree=$(cd "$tree" && pwd -P)
src=$(cd "$src" && pwd -P)

# The tree's config names its source as ./nixpkgs; the import goes through
# that path so the compiled modules are the ones used.
ln -sfn "$src" "$tree/nixpkgs"

expr=$(mktemp --suffix=.nix)
records=$(mktemp -d)
trap 'rm -rf "$expr" "$records"' EXIT

ulimit -s unlimited 2>/dev/null || true
for attr in "${attrs[@]}"; do
  echo "(import $tree/nixpkgs { system = \"x86_64-linux\"; config = {}; overlays = []; }).$attr.drvPath" > "$expr"
  node --disable-warning=ExperimentalWarning --stack-size=1000000 \
    "$here/src/cli/main.ts" eval "$expr" --tree "$tree" --record-files "$records/$attr.json" > /dev/null
done

python3 - "$records" "$out" "${attrs[@]}" <<'PY'
import json, sys
records, out = sys.argv[1:3]
attrs = sys.argv[3:]
# Insertion order is fetch order: the first attribute's files, then each
# later one's new files.
seen = {"tree": {}, "src": {}}
for attr in attrs:
    rec = json.load(open(f"{records}/{attr}.json"))
    for name in ("tree", "src"):
        for path in rec[name]:
            seen[name].setdefault(path, None)
hot = {name: list(paths) for name, paths in seen.items()}
with open(out, "w") as f:
    json.dump(hot, f, indent=0)
    f.write("\n")
print(f"{out}: {len(hot['tree'])} tree files, {len(hot['src'])} source files", file=sys.stderr)
PY
