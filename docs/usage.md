# Usage

## Run it

```console
$ nix run github:fzakaria/jinx -- eval ./default.nix
$ nix run github:fzakaria/jinx -- eval "$(nix eval --raw nixpkgs#path)" -A hello.drvPath
```

`jinx eval` compiles the files an evaluation reaches into a cache
under `~/.cache/jinx` and runs them. There is no search path: nixpkgs
is named by its path. The commands:

| command                               | what it does                                                                             |
| ------------------------------------- | ---------------------------------------------------------------------------------------- |
| `jinx eval <file> [-A attr] [--json]` | evaluate a file, like `nix-instantiate --eval --strict`; `--arg` and `--argstr` as there |
| `jinx compile <dir> --out <tree>`     | compile every `.nix` file under a directory into a TypeScript tree                       |
| `jinx eval <file> --tree <tree>`      | evaluate against a compiled tree instead of the cache                                    |
| `jinx instantiate <file> [-A attr]`   | write the `.drv` closure to the store, for `nix-store --realise`                         |
| `jinx eval-jobs <file> [--workers N]` | every attribute of a set, one JSON line each, like nix-eval-jobs                         |

`--impure` reads the environment and the current system as
`nix-instantiate` does; without it, evaluation is pure.

## In a flake

```nix
{
  inputs.jinx.url = "github:fzakaria/jinx";

  outputs = { self, nixpkgs, jinx }: {
    devShells.x86_64-linux.default = nixpkgs.legacyPackages.x86_64-linux.mkShell {
      packages = [ jinx.packages.x86_64-linux.jinx ];
    };
  };
}
```

`jinx.packages.<system>.jinx` is the command; `nix develop` then has
`jinx` on PATH.

## A NixOS configuration

A system closure evaluates like any other attribute. jinx has no
search path, so nixpkgs is named by path:

```console
$ nixpkgs=$(nix eval --raw nixpkgs#path)
$ jinx eval $nixpkgs/nixos --arg configuration ./configuration.nix \
    -A config.system.build.toplevel.drvPath
$ jinx instantiate $nixpkgs/nixos --arg configuration ./configuration.nix \
    -A config.system.build.toplevel
$ nix-store --realise /nix/store/...-nixos-system-....drv
```

The drvPath is the one `nix-instantiate` computes, so the store builds
what jinx wrote.

## From TypeScript

The library in `src/lib` evaluates Nix and gives it back as a view:
attribute reads force, calls apply, and plain objects, arrays, strings
and numbers pass as arguments.

```ts
import { loadNixpkgs } from "jinx";

const pkgs = loadNixpkgs("/path/to/nixpkgs", { system: "x86_64-linux" });

const hello = pkgs.stdenv.mkDerivation({
  pname: "hello",
  version: "2.12.2",
  src: pkgs.fetchurl({
    url: "mirror://gnu/hello/hello-2.12.2.tar.gz",
    hash: "sha256-WpqZbcKSzCTc9BHO6H6S9qrluNE72caBm0x6nc4IGKs=",
  }),
});

console.log(hello.drvPath);
```

| export                   | what it is                                                               |
| ------------------------ | ------------------------------------------------------------------------ |
| `loadNixpkgs(dir, opts)` | nixpkgs as a view, with `system`, `config` and `overlays` filled in      |
| `load(file, opts)`       | any Nix file as a view; `opts.args` is applied if it is a function       |
| `nix`                    | the builtins as a view: `nix.derivation({...})`, `nix.toJSON(...)`       |
| `lazy(() => v)`          | an attribute evaluated when something reads it                           |
| `path(base, rel)`        | a Nix path value                                                         |
| `Derivation`             | the type of a viewed derivation: `name`, `drvPath`, `outPath`, `outputs` |
| `show(v)`                | a value printed as `nix-instantiate --eval` prints it                    |

`opts.tree` points at a compiled tree, `opts.cache` at another cache
directory, `opts.system` sets `builtins.currentSystem`.

[examples/hello.ts](https://github.com/fzakaria/jinx/blob/main/examples/hello.ts)
is the package above; [examples/nixos.ts](https://github.com/fzakaria/jinx/blob/main/examples/nixos.ts)
evaluates a NixOS configuration written as an object. Typed views of
a package set, so `pkgs.` completes and a misspelled attribute is a
type error, come from `tools/gen-nixpkgs-dts.ts`
([examples/typed-hello.ts](https://github.com/fzakaria/jinx/blob/main/examples/typed-hello.ts)).

## In the browser

The [playground](../) compiles and evaluates a snippet in the tab;
`<nixpkgs>` there is the compiled nixpkgs, fetched as the evaluation
needs it, so a package or a NixOS system evaluates in the page. The
[nixpkgs page](../nixpkgs/) evaluates attributes of the same tree. `nix run github:fzakaria/jinx#serve` serves the same site
from the store, the compiled nixpkgs included, with no network.
