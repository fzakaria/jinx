# Verification

jinx's claim is that it computes the same derivations as Nix. This
document is how that claim is tested, at four levels, from a single
builtin to all of nixpkgs. Each level runs offline from recorded
expectations in `nix flake check`, and against a live Nix when asked.

## 1. Builtins, against the Nix source

The runtime modules that have to be bit-exact were each written from
the Nix 2.35 source and tested differentially against `nix-instantiate`
on this machine. `JINX_NIX_DIFF=1 npm test` runs the live comparisons;
without it the recorded cases run.

| Module              | What is compared                                                  |
| ------------------- | ----------------------------------------------------------------- |
| `store-path.ts`     | nix32, `makeStorePath`, text and fixed-output paths, hash parsing |
| `nar.ts`            | NAR bytes against `nix-store --dump`, hashes, filtered sources    |
| `numbers.ts`        | `%f`, `%g` and JSON float formats, 64-bit overflow                |
| `sort.ts`           | Nix's peeksort on pathological comparators                        |
| `regex.ts`          | `match` and `split` against libstdc++ ERE behaviour               |
| `json.ts`, `xml.ts` | `toJSON`, `fromJSON`, `toXML` bytes                               |
| `toml.ts`           | `fromTOML`                                                        |

## 2. The corpus, against nix-instantiate

`tests/corpus/*.nix` are small files exercising the language and the
builtins together: arithmetic, strings, attribute sets, lists, control
flow, paths, and derivations of every kind (multi-output, fixed-output
flat and recursive, structured attributes, input derivations). `jinx
test-corpus` evaluates each with jinx and with
`nix-instantiate --eval --strict --read-write-mode` and the printed
values must be identical, including every drvPath and outPath. `--record`
writes the Nix side to `*.exp` so the check runs offline.

## 3. The language, against nix-conformance

[numtide/nix-conformance] packages Nix's own `tests/functional/lang`
plus cases from differential fuzzing: 893 language cases, 106 parser
cases, 310 `.drv` files that must round-trip byte for byte, and 25 NARs.
`jinx adapter` implements its adapter protocol (`parse`, `check`, `eval`,
`eval-xml`, `drv`, `nar`), and `nix run .#conformance` runs the suite.
`tests/conformance/expected.json` holds the tally the check must not
regress below; a new pass raises the floor by hand so that progress is
visible in the history.

## 4. nixpkgs, against nix-eval-jobs

The headline number: for every attribute in nixpkgs, does jinx compute
the drvPath Nix computes, and does it fail on the attributes Nix fails
on?

`tools/parity.sh <nixpkgs>` runs on a machine with enough cores (it is
written for leviathan, 256 cores and 251 GB):

1. `nix-eval-jobs` over nixpkgs' own `ci/eval/outpaths.nix`
   configuration (`allowAliases = false`, `allowUnfree = true`,
   `checkMeta = true`, `inHydra = true`), producing one JSON line per
   attribute with its drvPath, outputs or error.
2. `jinx compile <nixpkgs> --out work/nixpkgs`, then
   `jinx eval-jobs` over the same configuration, producing the same
   shape of output.
3. A join on attribute path. Every line is one of: identical, differs
   (both have a drvPath and they disagree), jinx-error (Nix has a
   drvPath), nix-error (jinx has one), or both-error.

The result is a table and a list of the first differing attribute per
cause, which is the work queue; `eval-jobs --only` re-runs exactly the
flagged attributes after a fix, so an iteration costs minutes rather
than the full run. This is the bar [psyclyx/fix] met, every attribute
identical, and the number the status block in the README reports.

The first full run, nixpkgs 6510408d on leviathan with 32 workers:
nix-eval-jobs took 26 minutes and jinx 14 for 231,777 attributes;
228,492 drvPaths were identical, 2,714 attributes failed on both
sides, 30 differed and 541 failed only in jinx. The first comparison
found five causes among 7,500 mismatches (a `constructor` key read
from Object.prototype, the coercion of `__toString` in toJSON, Nix's
base64 decoder ignoring text after its padding, `dirOf "/"`, and the
indentation rule around escapes in `''` strings); after fixing them
and re-running the flagged attributes, two causes remain.

## What the bar does not cover

Building. jinx computes derivations and writes them to the store; Nix
builds them. Realising a derivation jinx instantiated proves the `.drv`
was accepted by Nix, which `jinx instantiate` checks by comparing the
path Nix assigns to the one jinx computed, and that is where jinx's
responsibility ends.

[numtide/nix-conformance]: https://github.com/numtide/nix-conformance
[psyclyx/fix]: https://github.com/psyclyx/fix
