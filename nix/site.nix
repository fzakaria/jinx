# `nix build .#site`: the whole deployable tree, so the pages workflow only
# has to upload what nix built:
#
#   index.html, style.css, llms.txt, CNAME   the site itself
#   js/                                      the page's modules
#   js/jinx.js                               the compiler and the runtime,
#                                            bundled by esbuild for the browser
#
# The bundle is src/browser/playground.ts with node's fs, path, url,
# module and crypto swapped for the shims in src/browser/shims/. The
# checked-in site/js/jinx.js is a stub with the same API; it is
# overwritten here, and by tools/build-site.sh for local work.
{ pkgs, self }:
let
  # The site and the compiler's source alone, rather than the whole flake
  # tree: reaching through `self` would make every file in the tree an
  # input, so a change to a doc or a test rebuilt the site for no reason.
  src = pkgs.lib.cleanSourceWith {
    src = self;
    filter =
      path: type:
      let
        rel = pkgs.lib.removePrefix (toString self + "/") (toString path);
        under = dir: rel == dir || pkgs.lib.hasPrefix "${dir}/" rel;
      in
      under "src" || under "site";
  };
in
pkgs.runCommand "jinx-site" { nativeBuildInputs = [ pkgs.esbuild ]; } ''
  mkdir -p $out
  cp -r ${src}/site/. $out/
  chmod -R u+w $out

  # The aliases are resolved against the working directory.
  cd ${src}
  esbuild src/browser/playground.ts \
    --bundle --format=esm --platform=browser --target=es2022 \
    --outfile=$out/js/jinx.js \
    --alias:node:fs=./src/browser/shims/fs.ts \
    --alias:node:path=./src/browser/shims/path.ts \
    --alias:node:url=./src/browser/shims/url.ts \
    --alias:node:module=./src/browser/shims/module.ts \
    --alias:node:crypto=./src/browser/shims/crypto.ts
''
