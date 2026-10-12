# `nix run .#<name>`: the tools around the compiler, each a command with its
# dependencies on PATH.
{
  pkgs,
  jinx,
  nix-conformance,
  # The built site (nix/site.nix), for `serve`. The flake passes its own
  # packages.site; the default lets the app stand alone.
  site ? import ./site.nix {
    inherit pkgs;
    self = ../.;
  },
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

  # Serve the built site, the tree the pages workflow deploys, on
  # http://localhost:8137 (`nix run .#serve -- <port>` for another). The
  # module tree and the bundle are plain static files, so this is python's
  # http.server rooted at the derivation. no-store because store paths
  # carry a 1970 mtime, and a 304 would keep a previous build's JS forever.
  serve = {
    type = "app";
    program = "${pkgs.writeShellScript "jinx-serve" ''
      exec ${pkgs.python3}/bin/python3 - "''${1:-8137}" <<'EOF'
      import http.server, sys

      SITE = "${site}"

      class Handler(http.server.SimpleHTTPRequestHandler):
          def __init__(self, *args, **kwargs):
              super().__init__(*args, directory=SITE, **kwargs)

          def end_headers(self):
              self.send_header("Cache-Control", "no-store")
              super().end_headers()

      port = int(sys.argv[1])
      print(f"serving {SITE} on http://localhost:{port}", flush=True)
      http.server.ThreadingHTTPServer(("", port), Handler).serve_forever()
      EOF
    ''}";
  };
}
