#!/usr/bin/env bash
# Build the site's generated parts in place, for local work: the browser
# bundle at site/js/jinx.js, the nixpkgs worker at site/js/nixpkgs-worker.js
# and the rendered docs at site/docs/. Same esbuild and render-docs.py
# invocations as nix/site.nix. Serve site/ with any static server
# afterwards, or use `nix run .#serve` for the nix-built tree.
#
# Tools come from the dev shell when present and from nixpkgs otherwise.
set -euo pipefail

cd "$(dirname "$0")/.."

# Run a command, with the given nixpkgs packages on PATH when the command
# is not already there.
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

# The declarations of the runtime and the library, for completions in
# the TypeScript pane: tsc emits them per file into a scratch directory from
# the two entry points and what they import (the options are tsconfig.json's,
# spelled out because files on the command line skip it), and
# tools/pack-dts.ts packs them into one document.
dts=$(mktemp -d)
with tsc typescript -- tsc --ignoreConfig src/runtime/index.ts src/lib/index.ts \
  --declaration --emitDeclarationOnly --outDir "$dts" --rootDir . \
  --module nodenext --moduleResolution nodenext --target es2024 \
  --allowImportingTsExtensions --verbatimModuleSyntax --erasableSyntaxOnly \
  --skipLibCheck --types node --strict
node --disable-warning=ExperimentalWarning tools/pack-dts.ts "$dts" site/js/jinx-dts.json
rm -rf "$dts"

# The nixpkgs worker (site/nixpkgs/): the runtime with the filesystem
# served over HTTP (fs-remote) and compiled modules fetched by require()
# (module-remote). The bundle stands in for the tree's vendored runtime,
# so its import.meta.url is that runtime's virtual path; the corepkgs
# resolve next to it (src/runtime/builtins.ts).
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

# The playground's worker for snippets that name <nixpkgs>: the same
# runtime over the served tree, with the compiler.
with esbuild esbuild -- esbuild src/browser/playground-worker.ts \
  --bundle --format=esm --platform=browser --target=es2022 \
  --outfile=site/js/playground-worker.js \
  --alias:node:fs=./src/browser/shims/fs-remote.ts \
  --alias:node:path=./src/browser/shims/path.ts \
  --alias:node:url=./src/browser/shims/url.ts \
  --alias:node:module=./src/browser/shims/module-remote.ts \
  --alias:node:crypto=./src/browser/shims/crypto.ts \
  --inject:./src/browser/shims/buffer.ts \
  '--define:import.meta.url="file:///tree/.jinx/runtime/index.ts"' \
  "$@"

# The docs need cmark-gfm and a python with pygments. Outside the dev
# shell they come from nixpkgs; a python with the module is an expression,
# not an attribute.
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
