# Tracking nixpkgs

The compiler is small; the product is the compiled nixpkgs. This is
how that product is kept current: a workflow that does the work and
commits the result, as [nixpkgs-multiverse], [omniflake] and [omnibin]
do.

## What is published

[fzakaria/jinx-nixpkgs] holds the compiled tree, one commit per tracked
nixpkgs revision. `tools/publish-nixpkgs.sh <rev> <dir> --parity
<compare-dir>` builds one:

- the 45,000 `.ts` modules and their source maps, compiled with
  `--vendor-runtime` so the tree stands alone;
- `.jinx/config.json` naming the nixpkgs commit, its NAR hash and the
  jinx commit that compiled it. The source tree is not copied; the
  config points at `./nixpkgs`, which the consumer provides (a symlink
  to the store path from `nix flake prefetch` is enough);
- `.jinx/tree-index.json` and `.jinx/src-index.json`, every path of the
  tree and of the source (`tools/index-tree.ts`), which let the site's
  nixpkgs page evaluate the tree by fetching files one at a time from
  `raw.githubusercontent.com`;
- `parity/report.md` and `parity/joined.tsv.gz` from the run against
  nix-eval-jobs on that revision ([verification.md](./verification.md)),
  and `parity/history.json` with the counts of every revision so far;
- the README, written from those by `tools/nixpkgs-readme.ts`: a status
  table for the current revision and a history table with one row per
  revision.

The largest module is `pkgs/development/haskell-modules/hackage-packages.ts`
at 42 MB, under GitHub's 100 MB limit and over jsDelivr's 20 MB, which
is why the site reads from `raw.githubusercontent.com`.

The tree lives in its own repository because it is 45,000 files that
change with every nixpkgs commit; keeping it out of `jinx` keeps the
compiler small enough to clone and review.

Still to add: `stats.json` with files compiled, time to compile, and
time and memory to evaluate on each side.

## Serving the tree locally

`jinx-nixpkgs` is an input of the flake. `nix build .#site-local`
builds the site with the compiled tree and the nixpkgs source linked
in and `nixpkgs/config.json` pointing at them, so `nix run .#serve`
serves the nixpkgs page from the store with no network. A revision
that is not pushed yet: `--override-input jinx-nixpkgs path:../jinx-nixpkgs`.

## How it is kept current

`update.yml` in the jinx repository, on demand (and on a schedule once
leviathan is registered as a self-hosted runner; the parity run needs
hours of cores and a quarter terabyte of memory):

1. Resolve the revision to track: the `nixos-unstable` channel tip,
   which Hydra has evaluated and cache.nixos.org holds, so a parity
   mismatch is never a build failure.
2. Compile it and run the parity comparison.
3. Clone `jinx-nixpkgs`, publish into the checkout, commit on top of the
   earlier revisions and push.
4. Point `site/nixpkgs/config.json` at the new commit and commit that
   to jinx. The status block in jinx's README is still updated by hand.

The push authenticates with a deploy key: the public half registered
on `jinx-nixpkgs` with write access, the private half the
`JINX_NIXPKGS_DEPLOY_KEY` secret on `jinx`:

```console
$ ssh-keygen -t ed25519 -N "" -C "jinx update.yml" -f jinx-nixpkgs-deploy
$ gh repo deploy-key add jinx-nixpkgs-deploy.pub --repo fzakaria/jinx-nixpkgs \
    --allow-write --title "jinx update.yml"
$ gh secret set JINX_NIXPKGS_DEPLOY_KEY --repo fzakaria/jinx < jinx-nixpkgs-deploy
$ rm jinx-nixpkgs-deploy jinx-nixpkgs-deploy.pub
```

## Regression testing

Every tracked revision is a regression test for the compiler. A jinx
change that lowers the parity count on any revision is a regression,
and the report says which attribute and why.

[fzakaria/jinx-nixpkgs]: https://github.com/fzakaria/jinx-nixpkgs
[nixpkgs-multiverse]: https://github.com/fzakaria/nixpkgs-multiverse
[omniflake]: https://github.com/fzakaria/omniflake
[omnibin]: https://github.com/fzakaria/omnibin
