#!/usr/bin/env bash
# Build site/js/jinx.js for local work on the site: the same esbuild
# invocation as nix/site.nix, written over the checked-in stub. Serve
# site/ with any static server afterwards (python3 -m http.server from
# site/, or `nix run .#serve` for the nix-built tree).
#
# esbuild comes from the dev shell when it is there and from nixpkgs
# otherwise, so the script works from a bare checkout.
set -euo pipefail

cd "$(dirname "$0")/.."

esbuild_cmd=(esbuild)
if ! command -v esbuild >/dev/null 2>&1; then
  esbuild_cmd=(nix shell nixpkgs#esbuild -c esbuild)
fi

# The aliases are resolved against the working directory.
exec "${esbuild_cmd[@]}" src/browser/playground.ts \
  --bundle --format=esm --platform=browser --target=es2022 \
  --outfile=site/js/jinx.js \
  --alias:node:fs=./src/browser/shims/fs.ts \
  --alias:node:path=./src/browser/shims/path.ts \
  --alias:node:url=./src/browser/shims/url.ts \
  --alias:node:module=./src/browser/shims/module.ts \
  --alias:node:crypto=./src/browser/shims/crypto.ts \
  "$@"
