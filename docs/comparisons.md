# Comparisons

Where jinx sits among the other implementations of the Nix language.

| Project          | Kind                     | Language   | Checks drvPaths against Nix                         |
| ---------------- | ------------------------ | ---------- | --------------------------------------------------- |
| jinx             | compiler to TypeScript   | TypeScript | all of nixpkgs on three systems: 231,777 of 231,777 |
| [fix]            | bytecode VM              | Zig        | all of nixpkgs on one system: 80,586 of 80,586      |
| [snix] (ex tvix) | bytecode VM              | Rust       | stdenv, hello, firefox, cross hello in CI           |
| [hnix]           | tree-walking interpreter | Haskell    | no claim                                            |
| [nix-eval-js]    | tree-walking interpreter | JavaScript | no; self-rated 5% complete                          |
| Nix, Lix         | tree-walking interpreter | C++        | the reference                                       |

Every project in the table except jinx is an interpreter: Nix source
in, value out. jinx is a compiler: Nix source in, a program out, which
produces the value when run.

## fix

[fix] evaluates nixpkgs' `ci/eval/outpaths.nix` with itself and with a
reference Nix, and as of its 0.3.0 release every one of 80,586 attributes has an
identical drvPath, including agreement on
which attributes fail. It is fast: a minimal NixOS closure in 0.54 s
against Nix's 2.25 s on the same machine, and the full nixpkgs universe
in about 52 s and 34 GB with 32 threads, through a parallel VM with
speculative forcing. Its documentation is the clearest account of
derivation hashing outside the Nix source. jinx's parity run
([verification.md](./verification.md)) follows fix's method.

## snix

[snix], formerly tvix, has worked on nixpkgs compatibility since 2022
and defines correctness as jinx does: drvPath and outPath equal to
Nix's. Its CI checks a fixed list (stdenv, hello, firefox, cross hello,
a NixOS ISO) on every commit; no whole-nixpkgs number has been
published. Its write-ups record what is hard: the undocumented ATerm
subset and hash-modulo intermediates, `derivation` being Nix code
around `derivationStrict`, string contexts that cannot be skipped
because stdenv works around a Nix bug, `tryEval` under bytecode, and
`builtins.path` coupling evaluator to store. jinx hit the same list.

## hnix and the rest

[hnix] is a Haskell interpreter whose goal of evaluating all of nixpkgs
has had open issues since 2020. [nix-eval-js] is a JavaScript
tree-walker written for incremental evaluation inside an editor, rated
5% complete by its author. [nix2c] by the same author is a Nix-to-C
transpiler labelled a failed experiment, on the argument that compiling
a dynamic language still pays runtime type checks and still
re-evaluates everything. The type checks do stay; a compiled module
graph is, though, what incremental evaluation needs.

In the other direction, [NiJS] (2013) is a JavaScript DSL that writes
Nix, and [PureNix] compiles PureScript to Nix. Nickel's Nix import
links libnixexpr and evaluates eagerly. No Nix-to-JavaScript or
Nix-to-TypeScript compiler existed before jinx.

## Where jinx differs

- The output is a program: a debugger, a profiler, a bundler and a
  browser apply to it.
- No native code. The compiler and runtime are TypeScript with no
  dependencies; the only binary involved is Node, or a browser. fix
  needs Zig and a Nix daemon; snix is Rust.
- Pure by construction. Evaluation never touches the store and never
  fetches, which makes jinx a library as much as a tool.
- Differential testing against Nix at every level, from one builtin to
  all of nixpkgs, with the recorded expectations in the tree so the
  check runs offline.

What fix and snix have that jinx does not: years of hardening, a
parallel evaluator in one process, and speed. jinx is 2.6x to 5.4x
slower than Nix per attribute ([performance.md](./performance.md)).

[fix]: https://github.com/psyclyx/fix
[snix]: https://snix.dev
[hnix]: https://github.com/haskell-nix/hnix
[nix-eval-js]: https://github.com/milahu/nix-eval-js
[nix2c]: https://github.com/milahu/nix2c
[NiJS]: https://github.com/svanderburg/nijs
[PureNix]: https://github.com/purenix-org/purenix
