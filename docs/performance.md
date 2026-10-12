# Performance

How fast jinx evaluates nixpkgs, measured against Nix on the same
machine and the same nixpkgs. The numbers here are from one run of
[tools/bench.ts](../tools/bench.ts) on 2026-10-12; the page at
[jinx.dev/bench](https://jinx.dev/bench/) draws every run since, from
[site/bench/history.json](../site/bench/history.json). The design
behind the numbers, and the three ways the design leaves to improve
them, is the performance model in [design.md](./design.md#performance-model).

## What is measured

Five probes, each a Nix expression that `nix-instantiate` and jinx both
evaluate to JSON. The outputs are compared, so a benchmark run is also
a parity check: a record says whether the two agreed.

| probe     | expression                                                                                                        |
| --------- | ----------------------------------------------------------------------------------------------------------------- |
| `lib`     | `builtins.length (import <nixpkgs>/lib/tests/misc.nix)`: the lib test suite, which exercises most of `lib`        |
| `hello`   | `hello.drvPath`: stdenv, the fixpoint of `pkgs`, one package                                                      |
| `firefox` | `firefox.drvPath`: a deep dependency graph through rust, gtk and the wrapper                                      |
| `nixos`   | `config.system.build.toplevel.drvPath` of a minimal NixOS configuration (a root filesystem, grub, `stateVersion`) |
| `sample`  | the drvPath of every package in the 66-package sample [verification.md](./verification.md) reports parity on      |

The sample imports nixpkgs with `allowUnfree = true` and
`allowAliases = false`; the others take the defaults. Nix runs as
`nix-instantiate --eval --strict --read-write-mode --json`. jinx runs as
`jinx eval --json --cache <dir>`, twice:

- cold, with an empty cache: every `.nix` file the evaluation reaches is
  compiled to TypeScript on demand, written out, and loaded. This is
  what a first evaluation costs, compiler included.
- warm, into the cache the cold run left: the compiled modules are
  present and only loaded, which is what every evaluation after the
  first costs, and what a precompiled tree (`jinx compile --out`) gives
  from the start.

Each timing is wall seconds and peak resident set under GNU `time`, as
the median of three runs. The tool prints the three raw times alongside
the median so a noisy run is visible.

## How to run it

```console
$ nix run .#bench                              # every probe, 3 runs each, appends to site/bench/history.json
$ nix run .#bench -- --probes lib,hello --runs 1 --history /tmp/h.json
$ nix run .#bench -- --nixpkgs /path/to/nixpkgs
```

The app puts nix, node and GNU time on PATH and measures the installed
`jinx` wrapper. From the dev shell, `node tools/bench.ts` measures
`src/cli/main.ts` directly, with the same node flags the wrapper uses.
The whole run takes about ten minutes, most of it the sample.

A record carries the jinx commit, the nixpkgs revision or store path,
the Nix and Node versions, and the machine, so the history is only
compared within one machine and one nixpkgs. Commit the appended
record with the change it measures.

## The numbers

nyx: AMD Ryzen 7 7840U, 16 threads, 61 GB. Nix 2.34.8, Node 24.21.0,
nixpkgs `4k79ns9drp02wyvcix81c7nnz4hn8psi-source` (nixos-unstable,
25.11pre). jinx at `5ef5c1a`.

| probe     |    nix | jinx cold | jinx warm | cold / nix | warm / nix | peak RSS nix | peak RSS jinx warm | outputs    |
| --------- | -----: | --------: | --------: | ---------: | ---------: | -----------: | -----------------: | ---------- |
| `lib`     | 0.50 s |    1.43 s |    1.29 s |       2.9x |       2.6x |       217 MB |             490 MB | identical  |
| `hello`   | 0.32 s |    2.31 s |    1.73 s |       7.2x |       5.4x |        93 MB |             352 MB | identical  |
| `firefox` | 1.84 s |    9.89 s |    8.03 s |       5.4x |       4.4x |       343 MB |             817 MB | identical  |
| `nixos`   | 3.66 s |         – |         – |          – |          – |       597 MB |                  – | jinx fails |
| `sample`  | 5.31 s |   32.22 s |   24.44 s |       6.1x |       4.6x |       658 MB |            2533 MB | identical  |

jinx is between 2.6x and 5.4x slower than Nix once the modules are
compiled, and 3x to 7x on a first evaluation. The gap is narrowest on
`lib`, which is mostly function calls and list operations, and widest
on `hello`, where a fixed cost dominates: `hello` itself is a few
lines, so most of its 1.7 s is the `pkgs` fixpoint and stdenv, which
every package pays and which Nix gets through in 0.3 s. Memory is 2x
to 4x Nix's: a thunk is a heap object with a closure, an integer is a
heap object, and the collector decides when anything is freed.

The NixOS closure does not evaluate on jinx yet. The module system gets
as far as `system.build.toplevel` and stops in `lib.path.hasStorePathPrefix`
with "Argument has a filesystem root (.) that's not /": a path value
whose root jinx reports differently from Nix. The record keeps the error
and the page draws the gap, which is the point of measuring it.

Node 24 runs the TypeScript directly, stripping types as each module
loads. That is part of the warm number: the compiled tree is read,
stripped and parsed on every run. A V8 code cache or a bundle would
remove it.

## Where the time goes

The performance model in [design.md](./design.md#performance-model)
reports the profile of the sample, which splits roughly as:

- a tenth in `app`, the function-application path: argument formals,
  `functionArgs` reflection for `callPackage`, and the thunk per
  argument;
- a tenth in building and hashing ATerms for derivations, which Nix
  does in C++ with its own hash;
- a tenth in loading and type-stripping modules, which the cold number
  pays on top of compiling them, and a precompiled tree would not;
- a fifth in attribute set operations: `//`, `intersectAttrs`,
  `removeAttrs` and `mapAttrs` over the layered sets that `callPackage`
  and the overlays produce;
- the rest spread across forcing, garbage collection and the builtins.

The two that dominated before the layered attribute sets were the
`intersectAttrs` of every `callPackage`, which iterated all of `pkgs`,
and the `//` copies. What the design leaves to win is in the model:
compile-time strictness analysis to skip thunks the emitter can prove
are forced, whole-program resolution of `callPackage` sites and `with
lib;`, and a startup snapshot of the evaluated fixpoint so that an
evaluation after the first starts where the first left off.
