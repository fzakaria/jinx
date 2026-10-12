# `nix build .#site`: the whole deployable tree, so the pages workflow only
# has to upload what nix built:
#
#   index.html, style.css, llms.txt, CNAME   the site itself
#   js/                                      the page's modules
#   js/jinx.js                               the compiler and the runtime,
#                                            bundled by esbuild for the browser
#   js/nixpkgs-worker.js                     the runtime over an HTTP-served
#                                            tree, for nixpkgs/ (a worker)
#   docs/                                    docs/*.md rendered to HTML
#
# With `tree` (the jinx-nixpkgs input), the result also carries the
# compiled tree at tree/ and the nixpkgs source it was compiled from at
# src/, and nixpkgs/config.json points the page at them, so the page runs
# from the one origin with no network. That build is `site-local`; the
# deployed `site` leaves them out, since the two are a gigabyte.
#
# The bundle is src/browser/playground.ts with node's fs, path, url, module
# and crypto swapped for the shims in src/browser/shims/, and Buffer
# injected from the shim of the same name. The checked-in site/js/jinx.js
# is a stub with the same API; it is overwritten here, and by
# tools/build-site.sh for local work.
{
  pkgs,
  self,
  tree ? null,
}:
let
  # The nixpkgs source the tree was compiled from, fetched by the NAR hash
  # the tree's config records, so the fetch is pure.
  treeConfig = builtins.fromJSON (builtins.readFile "${tree}/.jinx/config.json");
  treeSource = builtins.fetchTree {
    type = "github";
    owner = "NixOS";
    repo = "nixpkgs";
    rev = treeConfig.nixpkgs.rev;
    narHash = treeConfig.nixpkgs.narHash;
  };
  localConfig = builtins.toJSON {
    treeUrl = "../tree";
    treeIndexUrl = "../tree/.jinx/tree-index.json";
    srcUrl = "../src";
    srcIndexUrl = "../tree/.jinx/src-index.json";
    rev = treeConfig.nixpkgs.rev;
    system = "x86_64-linux";
  };

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
      (
        under "src"
        || under "site"
        || under "docs"
        || rel == "README.md"
        || rel == "package.json"
        || rel == "tools/pack-dts.ts"
        || rel == "tools"
      )
      && !(under "site/docs");
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
pkgs.runCommand "jinx-site"
  {
    nativeBuildInputs = [
      pkgs.esbuild
      pkgs.nodejs_24
      pkgs.typescript
    ];
  }
  (
    ''
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

        # The nixpkgs worker (site/nixpkgs/): the same runtime over a
        # filesystem served by HTTP; see tools/build-site.sh for the define.
        esbuild src/browser/nixpkgs-worker.ts \
          --bundle --format=esm --platform=browser --target=es2022 \
          --outfile=$out/js/nixpkgs-worker.js \
          --alias:node:fs=./src/browser/shims/fs-remote.ts \
          --alias:node:path=./src/browser/shims/path.ts \
          --alias:node:url=./src/browser/shims/url.ts \
          --alias:node:module=./src/browser/shims/module-remote.ts \
          --alias:node:crypto=./src/browser/shims/crypto.ts \
          --inject:./src/browser/shims/buffer.ts \
          '--define:import.meta.url="file:///tree/.jinx/runtime/index.ts"'

        # The declarations of the runtime and the view API, for completions in
      # the TypeScript pane (tools/build-site.sh does the same locally).
      dts=$(mktemp -d)
      tsc --ignoreConfig src/runtime/index.ts src/lib/index.ts \
        --declaration --emitDeclarationOnly --outDir "$dts" --rootDir . \
        --module nodenext --moduleResolution nodenext --target es2024 \
        --allowImportingTsExtensions --verbatimModuleSyntax --erasableSyntaxOnly \
        --skipLibCheck --strict \
        --types node --typeRoots ${import ./types-node.nix { inherit pkgs; }}/node_modules/@types
      node --disable-warning=ExperimentalWarning tools/pack-dts.ts "$dts" $out/js/jinx-dts.json

      # The output path is known before building, so the page and the docs can
        # name the very store path they are served out of (a benign
        # self-reference, same as trynix and the multiverse).
        substituteInPlace $out/js/app.js --replace-fail "__STORE_PATH__" "$out"
        for f in $out/docs/*.html; do
          substituteInPlace "$f" --replace-fail "__STORE_PATH__" "$out"
        done
    ''
    + pkgs.lib.optionalString (tree != null) ''

      ln -s ${tree} $out/tree
      ln -s ${treeSource} $out/src
      echo '${localConfig}' > $out/nixpkgs/config.json
    ''
  )
