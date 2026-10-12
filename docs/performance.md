# Performance

How fast jinx evaluates nixpkgs against Nix on the same machine and the
same nixpkgs. The numbers are one run of [tools/bench.ts](../tools/bench.ts)
on 2026-10-12; [jinx.dev/bench](https://jinx.dev/bench/) draws every run
from [site/bench/history.json](../site/bench/history.json). The design
behind the numbers is the performance model in
[design.md](./design.md#performance-model).

## What is measured

Five probes, each a Nix expression that `nix-instantiate` and jinx both
evaluate to JSON. The outputs are compared, so a run is also a parity
check.

| probe     | expression                                                                                    |
| --------- | --------------------------------------------------------------------------------------------- |
| `lib`     | `builtins.length (import <nixpkgs>/lib/tests/misc.nix)`: the lib test suite, most of `lib`    |
| `hello`   | `hello.drvPath`: stdenv, the fixpoint of `pkgs`, one package                                  |
| `firefox` | `firefox.drvPath`: a deep dependency graph through rust, gtk and the wrapper                  |
| `nixos`   | `config.system.build.toplevel.drvPath` of a minimal NixOS configuration                       |
| `sample`  | the drvPath of every package in a 66-package sample across languages, cross and static builds |

The sample imports nixpkgs with `allowUnfree = true` and
`allowAliases = false`; the others take the defaults. Nix runs as
`nix-instantiate --eval --strict --read-write-mode --json`. jinx runs
as `jinx eval --json --cache <dir>`, twice:

- cold, with an empty cache: every `.nix` file the evaluation reaches
  is compiled on demand, written out and loaded. What a first
  evaluation costs, compiler included.
- warm, into the cache the cold run left: the compiled modules are
  present and only loaded. What every later evaluation costs, and what
  a precompiled tree gives from the start.

Each timing is wall seconds and peak resident set under GNU `time`,
the median of three runs; the tool prints the three raw times next to
the median.

## How to run it

```console
$ nix run .#bench                              # every probe, 3 runs each, appends to site/bench/history.json
$ nix run .#bench -- --probes lib,hello --runs 1 --history /tmp/h.json
$ nix run .#bench -- --nixpkgs /path/to/nixpkgs
```

The app puts nix, node and GNU time on PATH and measures the installed
`jinx`. From the dev shell, `node tools/bench.ts` measures
`src/cli/main.ts` directly. The whole run takes about fifteen minutes.

A record carries the jinx commit, the nixpkgs path, the Nix and Node
versions and the machine, so the history is compared within one
machine and one nixpkgs. Commit the appended record with the change it
measures.

## The numbers

nyx: AMD Ryzen 7 7840U, 16 threads, 61 GB. Nix 2.34.8, Node 24.21.0,
nixpkgs 6510408d. jinx at `1b49288`.

| probe     |    nix | jinx cold | jinx warm | cold / nix | warm / nix | peak RSS nix | peak RSS jinx warm |
| --------- | -----: | --------: | --------: | ---------: | ---------: | -----------: | -----------------: |
| `lib`     | 0.53 s |    1.58 s |    1.42 s |       3.0x |       2.7x |       238 MB |             514 MB |
| `hello`   | 0.37 s |    2.50 s |    1.98 s |       6.8x |       5.4x |        88 MB |             396 MB |
| `firefox` | 3.37 s |   30.81 s |   23.71 s |       9.1x |       7.0x |       488 MB |            2264 MB |
| `nixos`   | 4.14 s |   44.10 s |   31.63 s |      10.7x |       7.6x |       603 MB |            3129 MB |
| `sample`  | 6.52 s |   38.53 s |   28.97 s |       5.9x |       4.4x |       712 MB |            3413 MB |

Every probe's output matches Nix. jinx is 2.7x to 7.6x slower than Nix
once the modules are compiled, and 3x to 11x on a first evaluation.
The gap is narrowest on `lib`, which is function calls and list
operations, and widest on the large closures, where memory is 4x to
6x Nix's: a thunk is an object with a closure, an integer is an
object, and a third of the time is the garbage collector.

Node runs the TypeScript directly, stripping types as each module
loads; a sixth of a cold firefox run is that stripping. A tree
published as JavaScript, or a V8 code cache, would remove it.

## What changed the numbers

- Layered attribute sets (`//` on a large set makes a two-layer view
  instead of a copy): the sample went from 60 s to 27 s.
- Attribute positions as a symbol property instead of a prototype per
  set: firefox from 20.6 s and 1.43 GB back to 13.7 s and 977 MB on the
  nixpkgs of the time. A prototype per set gave V8 a hidden class per
  set and kept both operands of every merge alive.
- `mapAttrs` as a lazy view: 2.30 GB peak from 2.38 on firefox. Most
  mapped sets are enumerated by a later `//` and flattened, which is
  where the rest of the memory stays.

## Where the time goes

A CPU profile of firefox: a third in the garbage collector, a sixth in
type stripping at load, a tenth in `app` (the function-application
path: formals, `functionArgs` reflection for `callPackage`, a thunk per
argument), a tenth in `//`, flattening and the other attribute set
operations, a twentieth building and hashing ATerms, the rest spread
across forcing and the builtins. A heap profile puts the live memory
in the flattened package sets and in `updateAttrs`.

What is left to win is in the model: strictness analysis to skip
thunks the emitter can prove are forced, whole-program resolution of
`callPackage` sites and `with lib;`, and a startup snapshot of the
evaluated fixpoint.
