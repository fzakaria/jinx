# `nix fmt`. The tree wrapper, matching trynix and nixpkgs-multiverse: one
# formatting step covers every language in the tree. nixfmt for the Nix,
# prettier for the TypeScript and for markdown at the width the docs are
# written to.
{ pkgs }:
pkgs.nixfmt-tree.override {
  runtimeInputs = [
    pkgs.prettier
  ];
  settings = {
    # Transpiled trees and the test corpus' expected outputs are not ours to
    # format: the corpus holds Nix files whose spelling is the point of the
    # test, and the emitted TypeScript is formatted by the emitter.
    global.excludes = [
      "out/*"
      "work/*"
      "tests/corpus/*"
      "tests/conformance/*"
    ];
    formatter.prettier = {
      command = "prettier";
      options = [ "--write" ];
      includes = [
        "*.ts"
        "*.mts"
        "*.js"
        "*.mjs"
        "*.json"
      ];
    };
    # proseWrap stays at its default of preserving the author's line breaks:
    # these files are hand-wrapped prose, and reflowing would make every
    # future diff a whole-file diff.
    formatter.prettier-markdown = {
      command = "prettier";
      options = [
        "--write"
        "--print-width"
        "80"
      ];
      includes = [ "*.md" ];
    };
  };
}
