# Constraints

What jinx does not do, and the deviations it knows about. The ones that
matter for nixpkgs come first.

## Pure evaluation only

jinx evaluates the way `nix-instantiate --pure-eval` would, and a little
stricter:

- No import-from-derivation. nixpkgs bans it (`ci/eval` sets
  `allow-import-from-derivation = false`), and jinx has no builder to
  call. Importing or reading a store path that is not already on disk
  is an error.
- No fetching. `fetchTarball`, `fetchGit`, `fetchTree`, `fetchurl` (the
  builtin, not the nixpkgs function) and `getFlake` are errors. nixpkgs
  does not need them; its fetchers are derivations.
- No environment unless asked. `getEnv` is `""`, as under `--pure-eval`;
  `jinx eval --impure` and `eval-jobs --impure` read the process
  environment the way nix-instantiate does by default, which the parity
  run needs because a few packages (drbd) embed `getEnv "SHELL"` in
  their derivations. `currentTime` is an error, `currentSystem` is the
  `--system` jinx was given, `nixPath` is empty except for `<nix/...>`,
  which resolves to the corepkgs Nix embeds (`fetchurl.nix`, needed by
  the stdenv bootstrap).
- `storePath` and `scopedImport` are errors. Neither appears on the
  path nixpkgs' evaluation takes.

## Compiled trees only

`import` resolves to a compiled module. A path outside every compiled
tree is an error; there is no interpreter to fall back to. `jinx eval`
compiles on demand into a cache so that any file on the machine works;
a published nixpkgs tree is compiled ahead.

## Derivation kinds

Input-addressed and fixed-output derivations, which is all of nixpkgs.
`__contentAddressed` and `__impure` are errors (experimental in Nix
too), and dynamic derivations are not represented.

## Known deviations

- Strings are UTF-16 internally. `stringLength`, `substring` and
  `hashString` act on the UTF-8 bytes, which matches Nix; a `substring`
  that cuts through a multibyte character yields U+FFFD where Nix
  yields the raw bytes, and `match` runs on code units, so a regex that
  counts non-ASCII characters can differ. ASCII, which is what nixpkgs'
  regexes and slices touch, agrees.
- Regular expressions are translated from POSIX ERE to JavaScript and
  run by V8. Whole-match results agree with libstdc++; captures inside
  repeated groups and `split` on alternations whose branches are
  prefixes of one another can differ. `src/runtime/regex.ts` lists the
  cases with Nix's answers.
- Error messages carry Nix's wording where a test depends on it, but
  not its positions or traces.
- `genericClosure` compares keys as Nix does, so `1` and `1.0`
  collide.

## Target Nix version

The runtime mirrors Nix 2.35.2: its builtins, its `langVersion` of 6,
its hashing. Derivation hashing has not changed across Nix versions and
is what parity measures; builtins that newer Nix adds are added here
when nixpkgs starts to use them.
