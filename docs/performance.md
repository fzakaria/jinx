# Performance

How fast jinx evaluates nixpkgs against Nix on the same machine and
the same nixpkgs. The numbers are one run of
[tools/bench.ts](../tools/bench.ts); the [benchmark page](../bench/)
draws every run. The design behind the numbers is in
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
$ nix run .#bench -- --nixpkgs /path/to/nixpkgs --rev <commit>
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
nixpkgs 6510408d. jinx at `8f8dac3`.

| probe     |    nix | jinx cold | jinx warm | cold / nix | warm / nix | peak RSS nix | peak RSS jinx warm |
| --------- | -----: | --------: | --------: | ---------: | ---------: | -----------: | -----------------: |
| `lib`     | 0.53 s |    1.56 s |    1.31 s |       2.9x |       2.5x |       238 MB |             501 MB |
| `hello`   | 0.37 s |    2.67 s |    1.72 s |       7.2x |       4.6x |        88 MB |             376 MB |
| `firefox` | 3.19 s |   29.73 s |   11.44 s |       9.3x |       3.6x |       488 MB |            1608 MB |
| `nixos`   | 4.21 s |   43.64 s |   21.35 s |      10.4x |       5.1x |       603 MB |            2377 MB |
| `sample`  | 6.27 s |   36.18 s |   20.61 s |       5.8x |       3.3x |       712 MB |            2469 MB |

Every probe's output matches Nix. jinx is 2.5x to 5.1x slower than Nix
once the modules are compiled and their code cached, and 3x to 10x on
a first evaluation, which compiles every module it reaches. The gap is
narrowest on `lib`, which is function calls and list operations, and
widest on the NixOS closure; memory is 2x to 4x Nix's: a thunk is an
object with a closure, an integer is an object.

Node runs the TypeScript directly, stripping types as each module
loads. jinx keeps V8's compiled code for every module across runs
(node's compile cache, under `~/.cache/jinx`), which took four tenths
off a warm run: before it, a warm evaluation stripped and parsed every
module again.

## What was tried

Measured on firefox.drvPath, warm, on nyx:

| change                                                                         |                                                                                     effect |
| ------------------------------------------------------------------------------ | -----------------------------------------------------------------------------------------: |
| node's compile cache                                                           |                                                         20.3 s to 12.2 s, 2.3 GB to 1.7 GB |
| a one-argument fast path in `app`, a bounded size check, a regex ATerm escaper |                                                                           12.2 s to 10.8 s |
| two fields per thunk instead of three                                          |                                                                                  1%, 10 MB |
| attribute positions as a symbol property instead of a prototype                |                                   1.5x faster, 1.7x less memory than the prototype version |
| `mapAttrs` as a lazy view                                                      |                                                                  4% less memory, same time |
| V8's young generation at 64 or 128 MB                                          |                                                                                       none |
| layering sets from 64 attributes instead of 256                                |                                                                           ten times slower |
| layering from 1024                                                             |                                                                                       none |
| a two-layer view for a tiny override of a medium set, instead of a copy        |                                                                         ten percent slower |
| a strict builtin's first argument evaluated in place instead of thunked        |       none; a tenth of all thunks are forced right after creation, so the ceiling is small |
| the Go TypeScript compiler for the build                                       | type-checks the project in the same time as tsc; the evaluation does not go through either |

## Where the time goes

A CPU profile of firefox: a third in the garbage collector, a sixth in
type stripping at load, a tenth in `app` (the function-application
path: formals, `functionArgs` reflection for `callPackage`, a thunk per
argument), a tenth in `//`, flattening and the other attribute set
operations, a twentieth building and hashing ATerms, the rest spread
across forcing and the builtins. A heap profile puts the live memory
in the flattened package sets and in `updateAttrs`.

Measured on firefox: 3.1 M thunks are created, 1.3 M ever forced,
330 k forced as the next thing after their creation; `//` copies
140,000 small sets, 6 M attributes in all, and flattens a layered set
97 times. The time is spread over application, `//` and forcing with no
one lever left in the runtime. What remains is structural: a startup
snapshot of the evaluated fixpoint, and whole-program resolution of
`callPackage` sites and `with lib;` in the emitter.
