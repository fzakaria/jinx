# Comparisons

Where jinx sits among the other implementations of the Nix language.
The survey this is based on was done on 2026-10-11; dates are from the
projects' own repositories.

## The question each project answers

| Project          | Kind                     | Language   | Checks drvPaths against Nix                |
| ---------------- | ------------------------ | ---------- | ------------------------------------------ |
| jinx             | compiler to TypeScript   | TypeScript | corpus, nix-conformance, nixpkgs (planned) |
| [fix]            | bytecode VM              | Zig        | all of nixpkgs: 80,586 of 80,586           |
| [snix] (ex tvix) | bytecode VM              | Rust       | stdenv, hello, firefox, cross hello in CI  |
| [hnix]           | tree-walking interpreter | Haskell    | no claim                                   |
| [nix-eval-js]    | tree-walking interpreter | JavaScript | no; self-rated 5% complete                 |
| Nix, Lix         | tree-walking interpreter | C++        | the reference                              |

Every project in the table except jinx is an interpreter: Nix source in,
value out. jinx is a compiler: Nix source in, a program out, that
produces the value when run. Both can compute the same derivations; only
one leaves behind something you can read, type, step through or ship.

## fix

[fix] is the project that set the bar. It evaluates nixpkgs' own
`ci/eval/outpaths.nix` with itself and with a reference Nix, and as of
its 0.3.0 changelog (2026-08) every one of 80,586 attributes has an
identical drvPath, including agreement on which attributes fail. It is
also fast: a minimal NixOS closure in 0.54 s against Nix's 2.25 s on the
same machine, and the full nixpkgs universe in about 52 s and 34 GB
with 32 threads, through a parallel VM with speculative forcing.

fix's documentation is the clearest account of derivation hashing
outside the Nix source, and its performance model (wall time is the
serial chain of derivation hashing and the module fixpoint, not
throughput) is the one jinx should expect to meet. jinx's parity run
([verification.md](./verification.md)) is modelled on fix's.

## snix

[snix], formerly tvix, has worked on nixpkgs compatibility since 2022
and defines correctness as jinx does: drvPath and outPath equal to
Nix's. Its CI checks a fixed list (stdenv, hello, firefox, cross hello,
a NixOS ISO) on every commit; no whole-nixpkgs number has been
published. Its write-ups are the best record of what is hard: the
undocumented ATerm subset and hash-modulo intermediates, `derivation`
being Nix code around `derivationStrict`, string contexts that cannot be
skipped because stdenv works around a Nix bug, `tryEval` under
bytecode, and `builtins.path` coupling evaluator to store. jinx hit the
same list, in the same order.

## hnix and the rest

[hnix] is a Haskell interpreter whose goal of evaluating all of nixpkgs
has had open issues since 2020. [nix-eval-js] is a JavaScript
tree-walker written for incremental evaluation inside an editor, and its
author rates it 5% complete. [nix2c] by the same author is a Nix-to-C
transpiler labelled a failed experiment, with the argument that
compiling a dynamic language still pays runtime type checks and still
re-evaluates everything. jinx agrees with the first half: the type
checks stay. It disagrees with the second: a compiled module graph is
exactly the structure incremental evaluation needs
([ideas.md](./ideas.md)).

Going the other way, [NiJS] (2013) is a JavaScript DSL that writes Nix,
and [PureNix] compiles PureScript to Nix. Nickel's Nix import links
libnixexpr and evaluates eagerly; Tweag has said it has no plans to
invest in it further. No Nix-to-JavaScript or Nix-to-TypeScript compiler
existed before jinx.

## Where jinx differs

- Output is a program. Everything in [ideas.md](./ideas.md) follows from
  that and from nothing else in this table.
- Zero native code. The compiler and runtime are TypeScript with no
  dependencies; the only binary involved is Node (or a browser). fix
  needs Zig and a Nix daemon; snix is Rust.
- Pure by construction. jinx never touches the store during evaluation
  and never fetches, which makes it a library as much as a tool.
- Correctness by differential testing against Nix at every level, from
  one builtin to all of nixpkgs, with the recorded expectations in the
  tree so the check runs offline.

What jinx does not have that fix and snix do: years of hardening, a
parallel evaluator, and (for now) a measured whole-nixpkgs result.

[fix]: https://github.com/psyclyx/fix
[snix]: https://snix.dev
[hnix]: https://github.com/haskell-nix/hnix
[nix-eval-js]: https://github.com/milahu/nix-eval-js
[nix2c]: https://github.com/milahu/nix2c
[NiJS]: https://github.com/svanderburg/nijs
[PureNix]: https://github.com/purenix-org/purenix
