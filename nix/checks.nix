# `nix flake check` runs the test suite. All of it is offline: the differential
# tests carry their expected values in the tree (tests/corpus/*.exp.json),
# recorded from nix by `jinx test-corpus --record`, so the sandbox needs no
# nix daemon.
{
  pkgs,
  jinx,
  self,
  nix-conformance,
}:
{
  # The compiler type-checks and installs.
  build = jinx;

  # The unit tests: node's own runner over tests/unit/*.test.ts.
  unit = pkgs.runCommand "jinx-unit" { nativeBuildInputs = [ pkgs.nodejs_24 ]; } ''
    cd ${self}
    node --disable-warning=ExperimentalWarning --test tests/unit/*.test.ts
    touch $out
  '';

  # The differential corpus against the recorded expectations.
  # The compiled modules go to a scratch cache: the sandbox has no home.
  corpus = pkgs.runCommand "jinx-corpus" { nativeBuildInputs = [ jinx ]; } ''
    cd ${self}
    export JINX_CACHE=$TMPDIR/cache
    jinx test-corpus --offline tests/corpus
    touch $out
  '';

  # nix-conformance: the tally must not regress below the number recorded in
  # tests/conformance/expected.json. A pass that starts failing is an error; a
  # new pass is reported and the file is updated by hand so the floor rises.
  conformance =
    pkgs.runCommand "jinx-conformance"
      {
        nativeBuildInputs = [
          jinx
          pkgs.nodejs_24
        ];
      }
      ''
        cd ${self}
        export JINX_CACHE=$TMPDIR/cache
        jinx test-conformance ${nix-conformance} --floor tests/conformance/expected.json
        touch $out
      '';
}
