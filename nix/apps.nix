# `nix run .#<name>`: the tools around the compiler, each a command with its
# dependencies on PATH.
{
  pkgs,
  jinx,
  nix-conformance,
}:
let
  tool = name: runtimeInputs: text: {
    type = "app";
    program = "${pkgs.writeShellApplication { inherit name runtimeInputs text; }}/bin/${name}";
  };
in
{
  default = {
    type = "app";
    program = "${jinx}/bin/jinx";
  };

  # Run the differential test corpus against the nix on PATH: every
  # tests/corpus/*.nix is evaluated by both and the JSON compared
  # (docs/verification.md).
  corpus = tool "jinx-corpus" [ pkgs.nix jinx ] ''
    exec jinx test-corpus "''${1:-tests/corpus}"
  '';

  # Run the nix-conformance suite through jinx and print the tally. The suite
  # is a flake input so the pin is in flake.lock, not in a script.
  conformance = tool "jinx-conformance" [ pkgs.nix jinx ] ''
    exec jinx test-conformance ${nix-conformance} "$@"
  '';

  # Evaluate every attribute of a nixpkgs checkout twice, with nix-eval-jobs
  # and with jinx, and report which drvPaths differ (docs/verification.md).
  # Sized for leviathan: --workers defaults to the core count.
  parity = tool "jinx-parity" [ pkgs.nix pkgs.nix-eval-jobs pkgs.jq jinx ] ''
    exec ${./../tools/parity.sh} "$@"
  '';
}
