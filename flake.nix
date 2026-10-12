{
  description = "Nix, transpiled to TypeScript: nixpkgs as a typed program";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    # The language test suite jinx is held to (docs/verification.md).
    nix-conformance = {
      url = "github:numtide/nix-conformance";
      flake = false;
    };

    # nixpkgs compiled to TypeScript, for the site's nixpkgs page served
    # locally (docs/tracking-nixpkgs.md). Its .jinx/config.json names the
    # nixpkgs revision it was compiled from.
    jinx-nixpkgs = {
      url = "github:fzakaria/jinx-nixpkgs";
      flake = false;
    };
  };

  # Wiring only. Everything this repository builds lives under nix/, one file
  # per concern, so a derivation is one line here and its definition is one
  # file over there.
  outputs =
    {
      self,
      nixpkgs,
      nix-conformance,
      jinx-nixpkgs,
    }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f system);
      pkgsFor = system: nixpkgs.legacyPackages.${system};
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = pkgsFor system;
        in
        rec {
          # The compiler and runtime, type-checked and installed as `jinx`.
          # No npm dependencies: node 24 runs the TypeScript directly, and
          # tsc only checks (nix/jinx.nix).
          jinx = import ./nix/jinx.nix { inherit pkgs self; };
          default = jinx;

          # jinx.dev: the playground with the compiler and runtime bundled
          # for the browser, and the rendered docs (nix/site.nix). `site` is
          # what GitHub Pages deploys; its nixpkgs page reads the compiled
          # tree from GitHub. `site-local` carries the tree and the nixpkgs
          # source itself, for `nix run .#serve` with no network.
          site = import ./nix/site.nix { inherit pkgs self; };
          site-local = import ./nix/site.nix {
            inherit pkgs self;
            tree = jinx-nixpkgs;
          };
        }
      );

      apps = forAllSystems (
        system:
        import ./nix/apps.nix {
          pkgs = pkgsFor system;
          jinx = self.packages.${system}.jinx;
          site = self.packages.${system}.site-local;
          inherit nix-conformance;
        }
      );

      checks = forAllSystems (
        system:
        import ./nix/checks.nix {
          pkgs = pkgsFor system;
          jinx = self.packages.${system}.jinx;
          inherit self nix-conformance;
        }
      );

      formatter = forAllSystems (system: import ./nix/formatter.nix { pkgs = pkgsFor system; });

      devShells = forAllSystems (system: import ./nix/dev-shells.nix { pkgs = pkgsFor system; });
    };
}
