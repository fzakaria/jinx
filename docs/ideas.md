# Ideas

What becomes possible once nixpkgs is a TypeScript program. Some of
these are the reason the project exists; none of them is built yet, and
the order they get built in is [roadmap.md](./roadmap.md). The site,
jinx.dev, is where most of them would live.

## Derivations in the browser

The compiled tree has no dependency on a Nix installation: evaluation is
pure, the store is a list of what would be added, and the runtime uses
nothing node-specific that a browser shim cannot provide (`fs` for the
source tree, `crypto` for SHA-256). Bundle a package set and
`pkgs.hello.drvPath` runs in a tab.

That joins up with [trynix](https://github.com/fzakaria/trynix), which
boots store paths in the browser from cache.nixos.org: edit a package
definition in the page, compute its derivation client-side, and if the
output path is one Hydra already built, boot it. A playground for
nixpkgs with no server and no `nix` binary.

## Power tools

Every TypeScript tool applies to the compiled tree:

- Breakpoints. Open the tree in Chrome DevTools or VS Code and step
  through `stdenv.mkDerivation` as it builds the attribute set for
  `hello`. Source maps would put the breakpoint on the `.nix` line.
- Profiling. V8's CPU profiler over an evaluation gives a flame graph
  of nixpkgs: which overlay, which `lib` function, which package spends
  the time. Nix has `NIX_SHOW_STATS` and counting of thunks; this is a
  sampled profile with call stacks.
- Memory. Heap snapshots of an evaluated package set show what retains
  what, which is the question behind every "why does evaluating nixpkgs
  take 8 GB" thread.
- Types. `lib`'s functions are documented with type signatures in
  comments; emitting them as TypeScript declarations gives `pkgs.`
  completion and a type checker over module options. A NixOS
  configuration written against those types is one of the end states.
- Linting and codemods. The TypeScript compiler API over all of nixpkgs:
  find every package that does X, rewrite it.

## A typed editor

The playground's TypeScript pane is CodeMirror today. Monaco, the editor
inside VS Code, can run the TypeScript language service in the browser,
and given the runtime's declarations and a typed view of nixpkgs it
would complete `pkgs.` and check a hand-written derivation as you type.

## The parity audit as a site

The whole-nixpkgs run ([verification.md](./verification.md)) produces,
for each attribute, whether jinx agrees with Nix. Publish it: a page per
nixpkgs revision with a green/red grid of attributes, each linking to
the `.nix` source and the `.ts` jinx emitted side by side, the two
`.drv` texts diffed where they differ, and the error where one side
failed. The same page over time is the project's progress chart, and a
mismatch is a filed bug with a reproduction attached.

## Tracking nixpkgs

A transpiled nixpkgs, kept current automatically
([tracking-nixpkgs.md](./tracking-nixpkgs.md)): a repository whose
commits mirror nixpkgs commits, each carrying the compiled tree and the
parity report for that revision. Statistics fall out: how many files
changed, how many derivations, how long the evaluation took on each
side, where the time went.

## Incremental evaluation

Nix re-evaluates nixpkgs from scratch every time. A compiled tree is a
module graph: when one `.nix` file changes, one `.ts` module changes,
and everything that did not import it is unchanged. With evaluation
results memoised per module and invalidated by import edges, a second
evaluation after a one-line change costs what that line affects. This
is the thing a TypeScript program can do that a Nix evaluator
structurally cannot.

## Snapshots

V8 can serialise a heap. Evaluate the fixpoint of `pkgs` once, snapshot,
and every later evaluation of one package starts from the snapshot.
`nix-eval-jobs` re-evaluates stdenv in every worker; a snapshot does it
once per nixpkgs revision.

## Smaller nixpkgs

A bundler tree-shakes. Given a NixOS configuration, the set of modules
and packages it reaches is a fraction of nixpkgs; the bundle for it is a
single file that evaluates that configuration and nothing else.

## Other targets

The compiler is Nix in, TypeScript out, but the hard parts (the runtime
model, the derivation machinery, the tests) are target-independent.
Lua, Go, or a second TypeScript emitter that produces idiomatic code with
static types rather than faithful code with thunks, are all one emitter
away.
