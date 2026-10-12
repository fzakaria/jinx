# The shells behind `nix develop`.
{ pkgs }:
let
  typeRoots = import ./types-node.nix { inherit pkgs; };
in
{
  # node 24 (which runs TypeScript by stripping types), tsc for `npm run
  # check`, the nix tools the differential tests compare against, and what
  # tools/build-site.sh needs (esbuild, cmark-gfm, pygments).
  default = pkgs.mkShellNoCC {
    packages = [
      pkgs.nodejs_24
      pkgs.typescript
      pkgs.nix
      pkgs.nix-eval-jobs
      pkgs.esbuild
      pkgs.cmark-gfm
      (pkgs.python3.withPackages (ps: [ ps.pygments ]))
      pkgs.jq
    ]
    # strace records the files an evaluation opens (tools/hot-files.sh).
    ++ pkgs.lib.optionals pkgs.stdenv.hostPlatform.isLinux [ pkgs.strace ];
    # tsc finds @types/node through node_modules; the shell links the
    # pinned copy in, so no npm install is needed.
    shellHook = ''
      if [ ! -e node_modules/@types/node ]; then
        mkdir -p node_modules/@types
        ln -sfn ${typeRoots}/node_modules/@types/node node_modules/@types/node
        ln -sfn ${typeRoots}/node_modules/undici-types node_modules/undici-types
      fi
    '';
  };
}
