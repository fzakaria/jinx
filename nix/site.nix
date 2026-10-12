# `nix build .#site`: the whole deployable tree, so the pages workflow only
# has to upload what nix built:
#
#   index.html, style.css, llms.txt, CNAME   the site itself
#   js/                                      the page's modules
#   js/jinx.js                               the compiler and the runtime,
#                                            bundled by esbuild for the browser
#   docs/                                    docs/*.md rendered to HTML
#
# The bundle is src/browser/playground.ts with node's fs, path, url, module
# and crypto swapped for the shims in src/browser/shims/, and Buffer
# injected from the shim of the same name. The checked-in site/js/jinx.js
# is a stub with the same API; it is overwritten here, and by
# tools/build-site.sh for local work.
{ pkgs, self }:
let
  # The site, the docs, the README (the docs' order) and the compiler's
  # source alone, rather than the whole flake tree: reaching through `self`
  # would make every file in the tree an input, so a change to a test
  # rebuilt the site for no reason.
  src = pkgs.lib.cleanSourceWith {
    src = self;
    filter =
      path: type:
      let
        rel = pkgs.lib.removePrefix (toString self + "/") (toString path);
        under = dir: rel == dir || pkgs.lib.hasPrefix "${dir}/" rel;
      in
      # site/docs is what tools/build-site.sh renders locally; the docs
      # derivation below renders them again, so a stale local copy stays out.
      (under "src" || under "site" || under "docs" || rel == "README.md") && !(under "site/docs");
  };

  # docs/*.md rendered to /docs/<name>.html, the way nixpkgs-multiverse does
  # it (tools/render-docs.py). pygments highlights the code blocks at build
  # time, which keeps a highlighter and its CDN out of the pages.
  docs =
    pkgs.runCommand "jinx-docs"
      {
        nativeBuildInputs = [
          (pkgs.python3.withPackages (ps: [ ps.pygments ]))
          pkgs.cmark-gfm
        ];
      }
      ''
        python3 ${../tools/render-docs.py} ${pkgs.cmark-gfm}/bin/cmark-gfm ${src} $out \
          https://jinx.dev "__STORE_PATH__"
      '';
in
pkgs.runCommand "jinx-site" { nativeBuildInputs = [ pkgs.esbuild ]; } ''
  mkdir -p $out
  cp -r ${src}/site/. $out/
  chmod -R u+w $out
  cp -r ${docs} $out/docs
  chmod -R u+w $out/docs

  # The aliases and the inject are resolved against the working directory.
  cd ${src}
  esbuild src/browser/playground.ts \
    --bundle --format=esm --platform=browser --target=es2022 \
    --outfile=$out/js/jinx.js \
    --alias:node:fs=./src/browser/shims/fs.ts \
    --alias:node:path=./src/browser/shims/path.ts \
    --alias:node:url=./src/browser/shims/url.ts \
    --alias:node:module=./src/browser/shims/module.ts \
    --alias:node:crypto=./src/browser/shims/crypto.ts \
    --inject:./src/browser/shims/buffer.ts

  # The output path is known before building, so the page and the docs can
  # name the very store path they are served out of (a benign
  # self-reference, same as trynix and the multiverse).
  substituteInPlace $out/js/app.js --replace-fail "__STORE_PATH__" "$out"
  for f in $out/docs/*.html; do
    substituteInPlace "$f" --replace-fail "__STORE_PATH__" "$out"
  done
''
