# Ideas

What a nixpkgs that is a TypeScript program makes possible. The first
four exist; the rest are in [roadmap.md](./roadmap.md) order.

## Derivations in the browser (built)

The compiled tree needs no Nix installation: evaluation is pure, the
store is a list of what would be added, and the runtime uses nothing
node-specific that a shim cannot provide (`fs` for the source tree,
`crypto` for SHA-256). The site's nixpkgs page fetches compiled modules
as the evaluation reaches them and computes `pkgs.hello.drvPath` in the
tab. With [trynix](https://github.com/fzakaria/trynix), which boots
store paths from cache.nixos.org, an output path Hydra already built
boots in the next tab.

## The parity audit as a site (built)

The whole-nixpkgs run ([verification.md](./verification.md)) says, for
each attribute, whether jinx agrees with Nix. The parity page has every
attribute of every run: counts by system and by family, the causes
behind the failures, and a search over the 231,777 attribute paths.
The same page over revisions is the project's progress chart.

## Tracking nixpkgs (built)

[fzakaria/jinx-nixpkgs](https://github.com/fzakaria/jinx-nixpkgs) holds
the compiled tree, one commit per tracked nixpkgs revision, each with
its parity report ([tracking-nixpkgs.md](./tracking-nixpkgs.md)).

## Types (built)

`lib`'s functions are documented with type signatures in comments.
`tools/gen-nixpkgs-dts.ts` turns them, and every attribute of a package
set, into TypeScript declarations, so `pkgs.` completes in an editor
and a misspelled attribute is a type error. The playground runs the
TypeScript language service in the page with the runtime's
declarations.

## Power tools

- Breakpoints. Open the tree in Chrome DevTools or VS Code and step
  through `stdenv.mkDerivation` as it builds `hello`'s attribute set.
  The source maps put the breakpoint on the `.nix` line.
- Profiling. V8's CPU profiler over an evaluation gives a flame graph
  of nixpkgs: which overlay, which `lib` function, which package the
  time goes to, with call stacks.
- Memory. A heap snapshot of an evaluated package set shows what
  retains what.
- Linting and codemods. The TypeScript compiler API over all of
  nixpkgs: find every package that does X, rewrite it.

## Incremental evaluation

Nix re-evaluates nixpkgs from scratch every time. A compiled tree is a
module graph: when one `.nix` file changes, one `.ts` module changes,
and everything that did not import it is unchanged. With evaluation
results memoised per module and invalidated along import edges, a
second evaluation after a one-line change costs what that line
affects.

## Snapshots

V8 can serialise a heap. Evaluate the fixpoint of `pkgs` once,
snapshot, and every later evaluation of one package starts from there.
`nix-eval-jobs` re-evaluates stdenv in every worker; a snapshot does it
once per nixpkgs revision.

## Smaller nixpkgs

A bundler tree-shakes. The modules and packages a NixOS configuration
reaches are a fraction of nixpkgs; the bundle for it is one file that
evaluates that configuration and nothing else.

## Other targets

The hard parts (the runtime model, the derivation machinery, the
tests) are target-independent. Lua, Go, or a second TypeScript emitter
that produces idiomatic code with static types rather than faithful
code with thunks, are each one emitter away.
