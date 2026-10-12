# The shells behind `nix develop`.
{ pkgs }:
let
  typeRoots = import ./types-node.nix { inherit pkgs; };
in
{
  # Everything the repository runs with: node 24 (which strips types itself,
  # so `node src/cli/main.ts` just works), tsc for `npm run check`, the nix
  # tools the differential tests compare against, and what
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
    ];
    # tsc finds @types/node through node_modules; the shell links the pinned
    # copy into the tree rather than asking anyone to run npm.
    shellHook = ''
      if [ ! -e node_modules/@types/node ]; then
        mkdir -p node_modules/@types
        ln -sfn ${typeRoots}/node_modules/@types/node node_modules/@types/node
        ln -sfn ${typeRoots}/node_modules/undici-types node_modules/undici-types
      fi
    '';
  };
}
