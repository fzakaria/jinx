# nix-conformance

jinx takes part in [numtide/nix-conformance](https://github.com/numtide/nix-conformance)
through `tools/conformance-adapter.sh`, which runs `jinx adapter OP FILE [FLAG...]`
(`src/cli/adapter.ts`). The suite's `.exp` files are the answers of Nix 2.34.8.

## Run it

Clone the suite, then run its runner with the adapter's absolute path. The
runner must run from the suite's root (it does `cd` there itself) and needs
`node` on PATH, so start it from this repo's dev shell:

```sh
git clone https://github.com/numtide/nix-conformance /path/to/nix-conformance
nix develop path:. -c /path/to/nix-conformance/run "$PWD/tools/conformance-adapter.sh"
```

`./run` is the suite's bash runner (bash and coreutils only); `nix run
path:/path/to/nix-conformance -- "$PWD/tools/conformance-adapter.sh"` is
the same through the suite's flake. Give it one or more of `lang`, `parse`,
`nar`, `drv` to run a part, `--json` for one object per failure or skip
followed by a summary, and `--tree` to compare parse trees (the adapter
prints `ok` without a tree, so every `parse/` case fails under `--tree`).

Environment the wrapper reads:

- `JINX_CACHE`: where compiled files go. The runner sets `HOME=/fake-home`,
  so the default is `$XDG_CACHE_HOME/jinx/conformance-fs` or
  `/tmp/jinx/conformance-fs`.
- `JINX_ADAPTER_TIMEOUT`: seconds per case, 60 by default. One case,
  `lang/eval-fail-functor-loop.nix`, never ends in jinx; the timeout makes
  it a non-zero exit, which counts as the expected failure.
- `JINX_MAIN`: another `src/cli/main.ts` to run.

## Expected numbers

`expected.json` holds the pass, fail and skip counts of the whole suite
(`lang parse nar drv`) at the last run. A skip is an exit 3 from the
adapter: a `.flags` file with a flag jinx does not implement
(`--max-call-depth`, a fatal `--lint-*` flag).
