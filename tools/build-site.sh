#!/usr/bin/env bash
# Build the site's generated parts in place, for local work on it: the
# browser bundle at site/js/jinx.js (over the checked-in stub), the
# nixpkgs worker at site/js/nixpkgs-worker.js and the rendered docs at
# site/docs/. The same esbuild and render-docs.py
# invocations as nix/site.nix. Serve site/ with any static server
# afterwards (python3 -m http.server from site/), or `nix run .#serve`
# for the nix-built tree.
#
# The tools come from the dev shell when they are there and from nixpkgs
# otherwise, so the script works from a bare checkout.
set -euo pipefail

cd "$(dirname "$0")/.."

# Run a command with the given nixpkgs packages on PATH if the command is
# not already there.
with() {
  local cmd=$1
  shift
  local pkgs=()
  while [ "$1" != "--" ]; do
    pkgs+=("nixpkgs#$1")
    shift
  done
  shift
  if command -v "$cmd" >/dev/null 2>&1; then
    "$@"
  else
    nix shell "${pkgs[@]}" -c "$@"
  fi
}

# The aliases and the inject are resolved against the working directory.
with esbuild esbuild -- esbuild src/browser/playground.ts \
  --bundle --format=esm --platform=browser --target=es2022 \
  --outfile=site/js/jinx.js \
  --alias:node:fs=./src/browser/shims/fs.ts \
  --alias:node:path=./src/browser/shims/path.ts \
  --alias:node:url=./src/browser/shims/url.ts \
  --alias:node:module=./src/browser/shims/module.ts \
  --alias:node:crypto=./src/browser/shims/crypto.ts \
  --inject:./src/browser/shims/buffer.ts \
  "$@"

# The nixpkgs worker (site/nixpkgs/): the same runtime, with the
# filesystem served over HTTP (fs-remote) and compiled modules fetched by
# require() (module-remote). The bundle stands in for the compiled tree's
# vendored runtime, so its import.meta.url is defined as that runtime's
# virtual path: the corepkgs resolve next to it (src/runtime/builtins.ts).
with esbuild esbuild -- esbuild src/browser/nixpkgs-worker.ts \
  --bundle --format=esm --platform=browser --target=es2022 \
  --outfile=site/js/nixpkgs-worker.js \
  --alias:node:fs=./src/browser/shims/fs-remote.ts \
  --alias:node:path=./src/browser/shims/path.ts \
  --alias:node:url=./src/browser/shims/url.ts \
  --alias:node:module=./src/browser/shims/module-remote.ts \
  --alias:node:crypto=./src/browser/shims/crypto.ts \
  --inject:./src/browser/shims/buffer.ts \
  '--define:import.meta.url="file:///tree/.jinx/runtime/index.ts"' \
  "$@"

# The docs need cmark-gfm and a python that can import pygments. The dev
# shell has both; outside it they come from nixpkgs, and a python with the
# module on its path is an expression rather than an attribute.
if command -v cmark-gfm >/dev/null 2>&1 && python3 -c 'import pygments' 2>/dev/null; then
  python3 tools/render-docs.py "$(command -v cmark-gfm)" . site/docs
else
  nix shell --impure --expr '
    let p = (builtins.getFlake "nixpkgs").legacyPackages.${builtins.currentSystem}; in {
      cmark = p.cmark-gfm;
      python = p.python3.withPackages (ps: [ ps.pygments ]);
    }' cmark python \
    -c sh -c 'python3 tools/render-docs.py "$(command -v cmark-gfm)" . site/docs'
fi
