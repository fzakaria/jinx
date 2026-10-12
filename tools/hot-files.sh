#!/usr/bin/env bash
# Write the list of files evaluating a few packages reads from a compiled
# tree and its source, for the site's nixpkgs page to fetch in parallel
# before it needs them (src/browser/nixpkgs-worker.ts).
#
#   tools/hot-files.sh <tree> <src> <out.json> [attr...]
#
# The default attributes are hello, which every package shares the
# files of (the fixpoint and stdenv), then a handful of packages people
# try first. strace records every file node opens, one evaluation at a
# time, so the list is in the order the page should fetch: what hello
# needs first. The ones under <tree> and <src> are kept, relative to
# their root, as {"tree": [...], "src": [...]}.
set -euo pipefail

tree=${1:?usage: hot-files.sh <tree> <src> <out.json> [attr...]}
src=${2:?usage: hot-files.sh <tree> <src> <out.json> [attr...]}
out=${3:?usage: hot-files.sh <tree> <src> <out.json> [attr...]}
shift 3
attrs=("$@")
if [ ${#attrs[@]} -eq 0 ]; then
  attrs=(hello firefox python3 nodejs git vim neovim gcc rustc go curl openssl ripgrep tmux emacs)
fi
here="$(cd "$(dirname "$0")/.." && pwd)"
tree=$(cd "$tree" && pwd -P)
src=$(cd "$src" && pwd -P)

# The tree's config names its source as ./nixpkgs, so the import goes
# through that path for the compiled modules to be the ones used; the
# source files then appear under both spellings in the trace.
ln -sfn "$src" "$tree/nixpkgs"

expr=$(mktemp --suffix=.nix)
traces=$(mktemp -d)
trap 'rm -rf "$expr" "$traces"' EXIT

ulimit -s unlimited 2>/dev/null || true
for attr in "${attrs[@]}"; do
  echo "(import $tree/nixpkgs { system = \"x86_64-linux\"; config = {}; overlays = []; }).$attr.drvPath" > "$expr"
  strace -f -e trace=openat -o "$traces/$attr" \
    node --disable-warning=ExperimentalWarning --stack-size=1000000 \
    "$here/src/cli/main.ts" eval "$expr" --tree "$tree" > /dev/null
done

python3 - "$tree" "$src" "$traces" "$out" "${attrs[@]}" <<'PY'
import json, re, sys
tree, src, traces, out = sys.argv[1:5]
attrs = sys.argv[5:]
opened = re.compile(r'openat\(\w+, "([^"]+)", [^)]*\) = \d+')
# Insertion order is fetch order: hello's files, then each package's new ones.
seen = {"tree": {}, "src": {}}
for attr in attrs:
    for line in open(f"{traces}/{attr}", errors="replace"):
        m = opened.search(line)
        if m is None:
            continue
        path = m.group(1)
        for name, root in (("src", src), ("src", tree + "/nixpkgs"), ("tree", tree)):
            if path.startswith(root + "/"):
                seen[name].setdefault(path[len(root) + 1 :], None)
                break
hot = {name: list(paths) for name, paths in seen.items()}
with open(out, "w") as f:
    json.dump(hot, f, indent=0)
    f.write("\n")
print(f"{out}: {len(hot['tree'])} tree files, {len(hot['src'])} source files", file=sys.stderr)
PY
