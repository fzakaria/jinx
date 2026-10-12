# The compiled nixpkgs

[fzakaria/jinx-nixpkgs](https://github.com/fzakaria/jinx-nixpkgs) is
nixpkgs compiled to TypeScript, one commit per tracked nixpkgs
revision. Every `.nix` file is a `.ts` module in the same place, with a
source map beside it pointing back at the Nix, and the runtime the
modules import is vendored under `.jinx/runtime`, so the tree stands
alone.

## Using it

The source tree is not in the repository. Put a checkout of the
revision `.jinx/config.json` names at `./nixpkgs` (a symlink to the
store path is enough) and evaluate against the tree:

```console
$ git clone https://github.com/fzakaria/jinx-nixpkgs && cd jinx-nixpkgs
$ rev=$(jq -r .nixpkgs.rev .jinx/config.json)
$ ln -s "$(nix flake prefetch github:NixOS/nixpkgs/$rev --json | jq -r .storePath)" nixpkgs
$ jinx eval ./nixpkgs -A hello.drvPath --tree .
```

Nothing is compiled on the way: `--tree` makes `import` resolve to the
modules already there. From TypeScript, `loadNixpkgs("./nixpkgs", { tree: "." })`
does the same.

## What a commit holds

- the modules and their source maps;
- `.jinx/config.json`: the nixpkgs commit, its NAR hash, and the jinx
  commit that compiled it;
- `parity/report.md` and `parity/joined.tsv.gz`: the result of
  evaluating every attribute of nixpkgs' CI configuration with
  nix-eval-jobs and with jinx on that revision
  ([verification.md](./verification.md)), one line per attribute;
- the README: a status table for the revision and a history table with
  one row per revision published;
- `.jinx/names.json`, `.jinx/hot.json`, `.jinx/files/` and
  `.jinx/positions/`: what the [nixpkgs page](../nixpkgs/) reads to
  evaluate the tree in a browser, fetching files as it needs them, and
  where every top-level attribute is defined.

Each revision is also a regression test for the compiler: a jinx change
that lowers the parity count on any revision is a regression, and the
report says which attribute and why.

## Local, offline

`jinx-nixpkgs` is an input of jinx's flake. `nix run github:fzakaria/jinx#serve`
serves the site with the compiled tree and the nixpkgs source from the
store, so the nixpkgs page runs with no network.
