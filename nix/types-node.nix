# @types/node, pinned by hash from the registry, so tsc can check the
# code's use of node's modules without an npm install or a lockfile. Types
# only; nothing from it runs. Bump the two versions and hashes together,
# since @types/node declares the undici-types range it needs.
{ pkgs }:
let
  fetchTgz =
    {
      name,
      url,
      hash,
    }:
    pkgs.runCommand name { src = pkgs.fetchurl { inherit url hash; }; } ''
      mkdir -p $out
      tar -xzf $src -C $out --strip-components=1
    '';
in
pkgs.runCommand "jinx-type-roots" { } ''
  mkdir -p $out/node_modules/@types
  ln -s ${
    fetchTgz {
      name = "types-node";
      url = "https://registry.npmjs.org/@types/node/-/node-26.6.5.tgz";
      hash = "sha512-uMzsv9stDdofIZBx4UGh4Z9ZgXnGC9seRDscilBcTHAeOFk67MZg/k9bWVfO+bk4qZmG+l52hRnLwUiH2LnJTg==";
    }
  } $out/node_modules/@types/node
  ln -s ${
    fetchTgz {
      name = "undici-types";
      url = "https://registry.npmjs.org/undici-types/-/undici-types-8.11.2.tgz";
      hash = "sha512-iMVNmWZ0leK/goS6eXMizSzmm9CDWtyphwbaCms3DNLqRxDL+mMoNVcZMTyyVgXP0N+Z8neAMzDoUOUJL8veKg==";
    }
  } $out/node_modules/undici-types
''
