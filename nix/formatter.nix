# `nix fmt`: nixfmt for the Nix, prettier for the TypeScript and for
# markdown at the width the docs are written to.
{ pkgs }:
pkgs.nixfmt-tree.override {
  runtimeInputs = [
    pkgs.prettier
  ];
  settings = {
    # Transpiled trees and the test corpus are left alone: the corpus holds
    # Nix files whose spelling is the point of the test, and the emitter
    # formats its own output.
    global.excludes = [
      "out/*"
      "work/*"
      "tests/corpus/*"
      "tests/conformance/*"
      # Generated data for the parity page.
      "site/parity/data/*"
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
    # proseWrap stays at its default of preserving line breaks; reflowing
    # hand-wrapped prose would make every future diff a whole-file diff.
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
