# `nix flake check` runs the test suite offline. The differential tests
# carry their expected values in the tree (tests/corpus/*.exp.json),
# recorded from nix by `jinx test-corpus --record`.
{
  pkgs,
  jinx,
  self,
  nix-conformance,
}:
{
  # The compiler type-checks and installs.
  build = jinx;

  # The house style's banned words and phrases, in prose and comments
  # alike (tools/check-prose.py).
  prose = pkgs.runCommand "jinx-prose" { nativeBuildInputs = [ pkgs.python3 ]; } ''
    python3 ${self}/tools/check-prose.py
    touch $out
  '';

  # The unit tests: node's own runner over tests/unit/*.test.ts.
  unit = pkgs.runCommand "jinx-unit" { nativeBuildInputs = [ pkgs.nodejs_24 ]; } ''
    cd ${self}
    node --disable-warning=ExperimentalWarning --test tests/unit/*.test.ts
    touch $out
  '';

  # The differential corpus against the recorded expectations. The
  # compiled modules go to a scratch cache, since the sandbox has no home.
  corpus = pkgs.runCommand "jinx-corpus" { nativeBuildInputs = [ jinx ]; } ''
    cd ${self}
    export JINX_CACHE=$TMPDIR/cache
    jinx test-corpus --offline tests/corpus
    touch $out
  '';

  # nix-conformance: the tally must not fall below the number recorded in
  # tests/conformance/expected.json. A new pass is reported and the file
  # updated by hand.
  conformance =
    pkgs.runCommand "jinx-conformance"
      {
        nativeBuildInputs = [
          jinx
          pkgs.nodejs_24
          pkgs.bash
          pkgs.jq
        ];
      }
      ''
        cd ${self}
        export JINX_CACHE=$TMPDIR/cache
        export HOME=$TMPDIR
        # One case by hand first, with its stderr, so a broken adapter shows
        # in this log instead of as a thousand failures.
        JINX_MAIN=${jinx}/lib/jinx/src/cli/main.ts tools/conformance-adapter.sh parse ${nix-conformance}/lang/parse-okay-1.nix || echo "adapter exit $?"
        jinx test-conformance ${nix-conformance} --floor tests/conformance/expected.json
        touch $out
      '';
}
