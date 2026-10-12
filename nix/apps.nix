# `nix run .#<name>`: the tools around the compiler, each with its
# dependencies on PATH.
{
  pkgs,
  jinx,
  nix-conformance,
  # The built site (nix/site.nix), for `serve`.
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

  # Evaluate every tests/corpus/*.nix with nix and with jinx and compare
  # the JSON (docs/verification.md).
  corpus = tool "jinx-corpus" [ pkgs.nix jinx ] ''
    exec jinx test-corpus "''${1:-tests/corpus}"
  '';

  # Run the nix-conformance suite (a flake input) through jinx and print
  # the tally.
  conformance = tool "jinx-conformance" [ pkgs.nix jinx ] ''
    exec jinx test-conformance ${nix-conformance} "$@"
  '';

  # Evaluate every attribute of a nixpkgs checkout with nix-eval-jobs and
  # with jinx and report which drvPaths differ (docs/verification.md).
  parity = tool "jinx-parity" [ pkgs.nix pkgs.nix-eval-jobs pkgs.jq jinx ] ''
    exec ${./../tools/parity.sh} "$@"
  '';

  # Time Nix and the installed jinx on the same probes under GNU time and
  # append the record to site/bench/history.json (docs/performance.md).
  # Run from the repository root, where the history file and the commit
  # id are read.
  bench =
    tool "jinx-bench"
      [
        pkgs.nix
        pkgs.nodejs_24
        pkgs.time
        pkgs.git
      ]
      ''
        exec node ${./../tools/bench.ts} --jinx ${jinx}/bin/jinx "$@"
      '';

  # Serve the built site on http://localhost:8137 (`nix run .#serve --
  # <port>` for another) with python's http.server rooted at the
  # derivation. no-store because store paths carry a 1970 mtime, and a 304
  # would keep a previous build's JS forever.
  serve = {
    type = "app";
    program = "${pkgs.writeShellScript "jinx-serve" ''
      exec ${pkgs.python3}/bin/python3 - "''${1:-8137}" <<'EOF'
      import http.server, os, sys

      SITE = "${site}"

      class Handler(http.server.SimpleHTTPRequestHandler):
          def __init__(self, *args, **kwargs):
              super().__init__(*args, directory=SITE, **kwargs)

          # Resolve an extensionless request onto <path>.html, as GitHub
          # Pages does for /docs/design.
          def send_head(self):
              path, sep, query = self.path.partition("?")
              local = self.translate_path(path)
              if not os.path.exists(local) and os.path.isfile(local + ".html"):
                  self.path = path + ".html" + sep + query
              return super().send_head()

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
